// Audit log: every decision the harness makes — human or policy — is written
// twice, to SQLite (queryable) and to evidence/audit.log (greppable,
// survives without the database). No decision is ever silent.

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

  /** Record a decision. `entry.ts` comes back stamped. */
  record(entry) {
    const stamped = this.store.appendAudit(entry);
    fs.appendFileSync(this.file, `${JSON.stringify(stamped)}\n`, 'utf8');
    return stamped;
  }

  rows(limit) {
    return this.store.listAudit(limit);
  }
}
