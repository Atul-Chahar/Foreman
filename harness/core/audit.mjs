// Audit log: every decision the harness makes — human or policy — is written
// twice, to SQLite (queryable, authoritative) and to evidence/audit.log
// (greppable, survives without the database). No decision is ever silent.
//
// The two copies carry a shared autoincrement id. A failed file append never
// blocks or rolls back the SQLite record; syncFromDb() repairs the gap by
// replaying rows the file has not yet seen.

import fs from 'node:fs';
import path from 'node:path';

export class AuditLog {
  /**
   * @param {import('./store.mjs').Store} store
   * @param {string} file path to the JSONL audit file
   */
  constructor(store, file) {
    this.store = store;
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Record a decision. `entry.id` + `entry.ts` come back stamped. */
  record(entry) {
    const stamped = this.store.appendAudit(entry);
    try {
      this._appendLine(stamped);
    } catch (err) {
      // The database row is the source of truth; a broken evidence file is
      // repaired from it via syncFromDb() rather than losing the decision.
      console.error(`[audit] jsonl append failed (db id=${stamped.id}):`, err.message);
    }
    return stamped;
  }

  /**
   * Replay any audit rows the JSONL file is missing (e.g. after a failed
   * append). Idempotent: keyed on the last id already present in the file.
   */
  syncFromDb(limit = 10_000) {
    let lastId = this._lastFileId();
    const rows = this.store.listAudit(limit).reverse(); // ascending by id
    for (const row of rows) {
      if (row.id > lastId) {
        this._appendLine(row);
        lastId = row.id;
      }
    }
    return lastId;
  }

  _appendLine(row) {
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, 'utf8');
  }

  _lastFileId() {
    if (!fs.existsSync(this.file)) return -1;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return -1;
    try {
      return Number(JSON.parse(lines.at(-1)).id ?? -1);
    } catch {
      return -1; // torn final line — syncFromDb rewrites from the db
    }
  }

  rows(limit) {
    return this.store.listAudit(limit);
  }
}
