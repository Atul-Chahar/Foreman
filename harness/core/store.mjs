// Durable state. Everything the swarm knows lives here — never in an
// agent's context, never in a module-level variable. node:sqlite keeps the
// dependency count at zero; the schema is intentionally boring.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { assertTransition, STATES } from './state.mjs';

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,           -- 'task-007' — the idempotency key
  issue_number INTEGER,
  title        TEXT NOT NULL,
  state        TEXT NOT NULL,
  risk_tier    TEXT NOT NULL DEFAULT 'T1',
  priority     INTEGER NOT NULL DEFAULT 0, -- reconciler fixes jump the queue
  branch       TEXT,
  pr_number    INTEGER,
  spec         TEXT NOT NULL DEFAULT '{}', -- enhanced task spec (JSON)
  result       TEXT NOT NULL DEFAULT '{}', -- last sandbox/test result (JSON)
  attempts     INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'issue', -- 'issue' | 'fix'
  fix_for      TEXT,                          -- task id this fix repairs
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  action      TEXT NOT NULL,   -- e.g. 'merge_to_main'
  tier        TEXT NOT NULL,   -- T0 | T1 | T2
  summary     TEXT NOT NULL,   -- human-readable description of what happens
  detail      TEXT NOT NULL DEFAULT '{}', -- diff, test results, review (JSON)
  status      TEXT NOT NULL,   -- pending | approved | rejected | cancelled
  decided_by  TEXT,            -- 'human:<name>' when gated, 'policy:<tier>' when auto
  reason      TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS events (
  id       TEXT PRIMARY KEY,
  ts       TEXT NOT NULL,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  actor    TEXT NOT NULL,       -- 'human:<name>' | 'policy:<tier>' | 'system:<name>'
  tier     TEXT,                -- T0 | T1 | T2 | null
  action   TEXT NOT NULL,
  decision TEXT NOT NULL,       -- auto-approved | gated | approved | rejected | ...
  reason   TEXT
);
`;

export class Store {
  /** @param {string} file path to the sqlite database (created if missing) */
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.auditSink = null; // set by AuditLog: (row) => void — writes the JSONL copy
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(DDL);
    this.db
      .prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  // ── kv ────────────────────────────────────────────────────────────────────

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, String(value));
  }

  // ── tasks ─────────────────────────────────────────────────────────────────

  upsertTask(task) {
    const now = new Date().toISOString();
    const existing = this.getTask(task.id);
    if (existing) {
      // Deliberately does NOT write `state`: the state machine is only
      // reachable through transitionTask(), which validates and audits.
      this._updateTaskFields(existing, task, now);
      return this.getTask(task.id);
    }
    this.db
      .prepare(
        `INSERT INTO tasks(id, issue_number, title, state, risk_tier, priority, branch, pr_number,
           spec, result, attempts, kind, fix_for, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        task.id,
        task.issue_number ?? null,
        task.title,
        task.state ?? STATES.PLANNED,
        task.risk_tier ?? 'T1',
        task.priority ?? 0,
        task.branch ?? null,
        task.pr_number ?? null,
        JSON.stringify(task.spec ?? {}),
        JSON.stringify(task.result ?? {}),
        task.attempts ?? 0,
        task.kind ?? 'issue',
        task.fix_for ?? null,
        now,
        now,
      );
    return this.getTask(task.id);
  }

  _updateTaskFields(existing, patch, now, forcedState = null) {
    this.db
      .prepare(
        `UPDATE tasks SET title=?, state=?, risk_tier=?, priority=?, branch=?, pr_number=?,
           spec=?, result=?, attempts=?, kind=?, fix_for=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.title ?? existing.title,
        // upsertTask can never move state; only transitionTask passes a
        // validated forcedState
        forcedState ?? existing.state,
        patch.risk_tier ?? existing.risk_tier,
        patch.priority ?? existing.priority,
        patch.branch ?? existing.branch,
        patch.pr_number ?? existing.pr_number,
        JSON.stringify(patch.spec ?? existing.spec),
        JSON.stringify(patch.result ?? existing.result),
        patch.attempts ?? existing.attempts,
        patch.kind ?? existing.kind,
        patch.fix_for ?? existing.fix_for,
        now,
        existing.id,
      );
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? this._taskFromRow(row) : null;
  }

  listTasks() {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at, id')
      .all()
      .map((r) => this._taskFromRow(r));
  }

  listTasksInStates(states) {
    const qs = states.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM tasks WHERE state IN (${qs}) ORDER BY priority DESC, created_at, id`)
      .all(...states)
      .map((r) => this._taskFromRow(r));
  }

  /**
   * The ONLY way task state changes. Enforces the state machine and writes an
   * audit record in the same transaction — a lifecycle change can never be
   * silent or half-applied.
   *
   * @param {{ actor?: string, reason?: string }} [meta]
   */
  transitionTask(id, to, patch = {}, meta = {}) {
    const now = new Date().toISOString();
    // Read, validate, write and audit INSIDE the write lock: two concurrent
    // callers must not both validate against the same stale source state.
    this._tx(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`transitionTask: unknown task ${id}`);
      const from = task.state;
      assertTransition(from, to);
      this._updateTaskFields(task, patch, now, to);
      this.appendAudit({
        actor: meta.actor ?? 'system:store',
        tier: null,
        action: 'task.transition',
        decision: `${from} -> ${to}`,
        reason: meta.reason ?? '',
      });
    });
    return this.getTask(id);
  }

  /** Run fn inside an immediate transaction; rolls back on throw. */
  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Durable TTL lock keyed in meta — serializes critical sections across
   * independent processes sharing the database, unlike any in-memory flag.
   * @returns {boolean} true when the lock was acquired
   */
  tryLock(key, owner, ttlMs = 120_000) {
    return this._tx(() => {
      const raw = this.getMeta(`lock.${key}`);
      if (raw) {
        try {
          const held = JSON.parse(raw);
          if (held.o !== owner && Date.now() < held.exp) return false;
        } catch {
          /* corrupt lock row — treat as stale and take it over */
        }
      }
      this.setMeta(`lock.${key}`, JSON.stringify({ o: owner, exp: Date.now() + ttlMs }));
      return true;
    });
  }

  /** Release a lock. Only the owner (or a stale-expired holder) can. */
  unlock(key, owner) {
    this._tx(() => {
      const raw = this.getMeta(`lock.${key}`);
      if (!raw) return;
      try {
        const held = JSON.parse(raw);
        if (held.o !== owner) return;
      } catch { /* fall through: ours to clean */ }
      this.setMeta(`lock.${key}`, '');
    });
  }

  _taskFromRow(row) {
    return {
      ...row,
      spec: JSON.parse(row.spec),
      result: JSON.parse(row.result),
    };
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  createApproval({ id, taskId, action, tier, summary, detail }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals(id, task_id, action, tier, summary, detail, status, created_at)
         VALUES (?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(id, taskId, action, tier, summary, JSON.stringify(detail ?? {}), now);
    return this.getApproval(id);
  }

  getApproval(id) {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    return row ? { ...row, detail: JSON.parse(row.detail) } : null;
  }

  listApprovals(status = null) {
    const rows = status
      ? this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at').all(status)
      : this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all();
    return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  /**
   * Resolve a pending approval. Guarded: only a `pending` row can move, so a
   * lost race (two deciders) leaves the first winner standing and returns
   * null to the loser instead of silently overwriting the decision.
   */
  decideApproval(id, { status, decidedBy, reason }) {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE approvals SET status=?, decided_by=?, reason=?, decided_at=?
         WHERE id=? AND status='pending'`,
      )
      .run(status, decidedBy, reason ?? null, now, id);
    return info.changes > 0 ? this.getApproval(id) : null;
  }

  // ── events ────────────────────────────────────────────────────────────────

  persistEvent(event) {
    this.db
      .prepare('INSERT INTO events(id, ts, type, payload) VALUES (?,?,?,?)')
      .run(event.id, event.ts, event.type, JSON.stringify(event.payload));
  }

  listEvents(afterId = null, limit = 500) {
    // Replay in insertion order. The cursor is resolved in SQL so paging past
    // any window size works — a LIMIT applied before the cursor would strand
    // incremental consumers on the first page forever.
    const rows = this.db
      .prepare(
        `SELECT rowid, * FROM events
         WHERE (? IS NULL OR rowid > COALESCE((SELECT rowid FROM events WHERE id = ?), 0))
         ORDER BY rowid LIMIT ?`,
      )
      .all(afterId, afterId, limit);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      payload: JSON.parse(r.payload),
    }));
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  /** Returns the stamped entry including its stable autoincrement id — the
   *  join key that keeps SQLite and the JSONL evidence copy reconcilable.
   *  If an AuditLog has registered itself as `auditSink`, the JSONL copy is
   *  written here too: one write path, no divergence by construction. */
  appendAudit({ actor, tier, action, decision, reason }) {
    const ts = new Date().toISOString();
    const info = this.db
      .prepare('INSERT INTO audit(ts, actor, tier, action, decision, reason) VALUES (?,?,?,?,?,?)')
      .run(ts, actor, tier ?? null, action, decision, reason ?? null);
    const entry = { id: Number(info.lastInsertRowid), ts, actor, tier, action, decision, reason };
    if (this.auditSink) {
      // The database row is authoritative; a failed evidence append must not
      // lose or roll back the decision. syncFromDb() repairs the gap by id.
      try {
        this.auditSink(entry);
      } catch (err) {
        console.error(`[audit] jsonl append failed (db id=${entry.id}):`, err.message);
      }
    }
    return entry;
  }

  listAudit(limit = 200) {
    return this.db
      .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit);
  }

  /** Ascending keyset page of audit rows after `afterId` — lets the JSONL
   *  evidence log repair from any point without missing interior rows. */
  listAuditAfter(afterId = -1, limit = 1000) {
    return this.db
      .prepare('SELECT * FROM audit WHERE id > ? ORDER BY id LIMIT ?')
      .all(afterId, limit);
  }
}
