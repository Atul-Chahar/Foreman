// Audit log: every decision the harness makes — human or policy — is written
// twice, to SQLite (queryable, authoritative) and to evidence/audit.log
// (greppable, survives without the database). No decision is ever silent.
//
// Design:
// - The store owns ONE write path: appendAudit() inserts the row, then calls
//   the JSONL sink registered by this class. Callers cannot create a
//   database-only decision by bypassing the file, and a failed file append
//   never loses or rolls back the decision.
// - Both copies share a stable autoincrement id. syncFromDb() repairs any gap
//   (failed append, truncated or torn file) by replaying rows the file has
//   not yet seen, paging through the FULL history — not just recent rows.

import fs from 'node:fs';
import path from 'node:path';

const PAGE = 1000;

export class AuditLog {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {string} file path to the JSONL audit file
   */
  constructor(store, file) {
    this.store = store;
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Single JSONL write path: the store notifies us for every audit row,
    // including rows written internally (e.g. task transitions).
    store.auditSink = (row) => this._appendLine(row);
  }

  /** Record a decision. `entry.id` + `entry.ts` come back stamped. The
   *  JSONL copy is written by the store's sink call inside appendAudit(). */
  record(entry) {
    return this.store.appendAudit(entry);
  }

  /**
   * Repair the JSONL file from SQLite. Idempotent and complete:
   * - missing tail rows are appended from the last good id;
   * - a torn final line (crash mid-append) triggers a full rebuild from the
   *   database, so the file is always valid JSONL afterwards;
   * - interior gaps are caught because replay pages from id > lastGoodId
   *   through the entire history, not just the newest window.
   */
  syncFromDb() {
    const state = this._fileState();
    if (state.rebuild) {
      fs.writeFileSync(this.file, '', 'utf8'); // drop corrupt content; db wins
      return this._replayAfter(-1);
    }
    return this._replayAfter(state.lastGoodId);
  }

  _replayAfter(afterId) {
    let cursor = afterId;
    for (;;) {
      const rows = this.store.listAuditAfter(cursor, PAGE);
      if (rows.length === 0) break;
      for (const row of rows) {
        this._appendLine(row);
        cursor = row.id;
      }
      if (rows.length < PAGE) break;
    }
    return cursor;
  }

  /** Inspect the file: last fully-valid row id, and whether it needs a full
   *  rebuild (torn trailing line or unparsable content). */
  _fileState() {
    if (!fs.existsSync(this.file)) return { lastGoodId: -1, rebuild: false };
    const data = fs.readFileSync(this.file, 'utf8');
    if (data === '') return { lastGoodId: -1, rebuild: false };
    const lines = data.split('\n');
    const trailingNewline = data.endsWith('\n');
    const body = lines.filter(Boolean);
    // A line is only trustworthy if it was terminated — an unterminated
    // final line means we crashed mid-write.
    const complete = trailingNewline ? body : body.slice(0, -1);
    if (complete.length === 0) return { lastGoodId: -1, rebuild: true };
    try {
      const lastGoodId = Number(JSON.parse(complete.at(-1)).id);
      if (!Number.isInteger(lastGoodId)) throw new Error('bad id');
      return { lastGoodId, rebuild: !trailingNewline };
    } catch {
      return { lastGoodId: -1, rebuild: true };
    }
  }

  _appendLine(row) {
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, 'utf8');
  }

  rows(limit) {
    return this.store.listAudit(limit);
  }
}
