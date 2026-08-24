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
      this.db
        .prepare(
          `UPDATE tasks SET title=?, state=?, risk_tier=?, priority=?, branch=?, pr_number=?,
             spec=?, result=?, attempts=?, kind=?, fix_for=?, updated_at=? WHERE id=?`,
        )
        .run(
          task.title ?? existing.title,
          task.state ?? existing.state,
          task.risk_tier ?? existing.risk_tier,
          task.priority ?? existing.priority,
          task.branch ?? existing.branch,
          task.pr_number ?? existing.pr_number,
          JSON.stringify(task.spec ?? existing.spec),
          JSON.stringify(task.result ?? existing.result),
          task.attempts ?? existing.attempts,
          task.kind ?? existing.kind,
          task.fix_for ?? existing.fix_for,
          now,
          task.id,
        );
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

  /** The ONLY way task state changes. Enforces the state machine. */
  transitionTask(id, to, patch = {}) {
    const task = this.getTask(id);
    if (!task) throw new Error(`transitionTask: unknown task ${id}`);
    assertTransition(task.state, to);
    this.upsertTask({ ...task, ...patch, id, state: to });
    return this.getTask(id);
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

  decideApproval(id, { status, decidedBy, reason }) {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE approvals SET status=?, decided_by=?, reason=?, decided_at=? WHERE id=?')
      .run(status, decidedBy, reason ?? null, now, id);
    return this.getApproval(id);
  }

  // ── events ────────────────────────────────────────────────────────────────

  persistEvent(event) {
    this.db
      .prepare('INSERT INTO events(id, ts, type, payload) VALUES (?,?,?,?)')
      .run(event.id, event.ts, event.type, JSON.stringify(event.payload));
  }

  listEvents(afterId = null, limit = 500) {
    // Replay in insertion order; afterId enables incremental SSE catch-up.
    const rows = this.db
      .prepare('SELECT rowid, * FROM events ORDER BY rowid LIMIT ?')
      .all(limit);
    const idx = afterId ? rows.findIndex((r) => r.id === afterId) : -1;
    return (idx >= 0 ? rows.slice(idx + 1) : rows).map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      payload: JSON.parse(r.payload),
    }));
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  appendAudit({ actor, tier, action, decision, reason }) {
    const ts = new Date().toISOString();
    this.db
      .prepare('INSERT INTO audit(ts, actor, tier, action, decision, reason) VALUES (?,?,?,?,?,?)')
      .run(ts, actor, tier ?? null, action, decision, reason ?? null);
    return { ts, actor, tier, action, decision, reason };
  }

  listAudit(limit = 200) {
    return this.db
      .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit);
  }
}
