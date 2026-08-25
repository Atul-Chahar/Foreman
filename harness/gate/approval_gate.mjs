// The approval gate — the entire product in one file.
//
// Every irreversible action stops here and waits for a human. A pending
// approval lives in SQLite, not in memory: the process can restart, the
// browser can refresh, the approval is still waiting. The human's decision
// is the only thing that moves it.
//
// Auto-approvals (T0, opted-in T1) pass through, but they are never silent:
// each one is audited and surfaces in the console as its own event.

import { TIERS } from '../policy/tiers.mjs';

const POLL_MS = 400;

export class ApprovalGate {
  /**
   * @param {object} deps
   * @param {import('../core/store.mjs').Store} deps.store
   * @param {import('../core/audit.mjs').AuditLog} deps.audit
   * @param {import('../core/events.mjs').EventBus} deps.bus
   * @param {import('../policy/engine.mjs').PolicyEngine} deps.policy
   */
  constructor({ store, audit, bus, policy }) {
    this.store = store;
    this.audit = audit;
    this.bus = bus;
    this.policy = policy;
    this._onResolution = new Map(); // approvalId -> Set<fn>
  }

  /**
   * Approval ids come from a persisted counter incremented inside a
   * transaction — two harness processes sharing the database can never
   * allocate the same id.
   */
  _nextSeq() {
    return this.store._tx(() => {
      const cur = Number(this.store.getMeta('approval.seq') ?? '0');
      const next = cur + 1;
      this.store.setMeta('approval.seq', String(next));
      return next;
    });
  }

  /**
   * Route a requested action through policy. If it may proceed automatically,
   * resolves immediately (audited + visible). Otherwise creates a pending
   * approval and waits — possibly forever, possibly across a restart —
   * for a human decision.
   *
   * @returns {{ id: string|null, tier: string, auto: boolean, outcome: 'auto'|'approved'|'rejected'|'blocked' }}
   */
  async request({ taskId, action, summary, detail = {} }) {
    const verdict = this.policy.decide(action, { taskId });

    if (verdict.decision === 'block') {
      throw new Error(`policy refused action '${action}': ${verdict.reason}`);
    }
    if (verdict.decision === 'auto') {
      // visible, never silent: event + audit already written by the engine
      this.bus.emitEvent(
        'approval.auto',
        { taskId, action, tier: verdict.tier, reason: verdict.reason },
        (e) => this.store.persistEvent(e),
      );
      return { id: null, tier: verdict.tier, auto: true, outcome: 'auto' };
    }

    const id = `appr-${String(this._nextSeq()).padStart(4, '0')}`;
    this.store.createApproval({
      id,
      taskId,
      action,
      tier: verdict.tier,
      summary,
      detail,
    });
    this.bus.emitEvent(
      'approval.pending',
      { approvalId: id, taskId, action, tier: verdict.tier, summary },
      (e) => this.store.persistEvent(e),
    );

    const status = await this.waitFor(id);

    // The human may have approved while the kill switch was engaged. The
    // decision stands in the record, but execution fails closed until the
    // switch is released.
    if (status === 'approved' && this.policy.paused) {
      return { id, tier: verdict.tier, auto: false, outcome: 'blocked' };
    }
    return {
      id,
      tier: verdict.tier,
      auto: false,
      outcome:
        status === 'approved' ? 'approved'
        : status === 'cancelled' ? 'cancelled'
        : 'rejected',
    };
  }

  /**
   * Wait for an approval to be decided. Polls the store rather than holding
   * an in-memory promise chain, so a process restart mid-wait loses nothing:
   * the caller that resumes simply waits again on the same approval id.
   */
  async waitFor(id) {
    for (;;) {
      const a = this.store.getApproval(id);
      if (!a) throw new Error(`waitFor: unknown approval ${id}`);
      if (a.status === 'approved') return 'approved';
      if (a.status === 'rejected') return 'rejected';
      if (a.status === 'cancelled') return 'cancelled';
      await sleep(POLL_MS);
    }
  }

  /** Human says yes. Only the console (or CLI) calls this. */
  async approve(id, actor = 'human:console', reason = '') {
    return this._resolve(id, 'approved', actor, reason);
  }

  /** Human says no. The task is marked needs_human / rejected by callers. */
  async reject(id, actor = 'human:console', reason = '') {
    return this._resolve(id, 'rejected', actor, reason);
  }

  cancel(id, reason = 'superseded') {
    const a = this.store.getApproval(id);
    if (!a || a.status !== 'pending') return;
    const updated = this.store.decideApproval(id, { status: 'cancelled', decidedBy: 'system:gate', reason });
    if (!updated) return; // lost a race with a human decision — the human wins
    // a cancellation is a durable state change: it gets an audit record too
    this.audit.record({
      actor: 'system:gate',
      tier: a.tier,
      action: a.action,
      decision: 'cancelled',
      reason,
    });
    this.bus.emitEvent('approval.cancelled', { approvalId: id, taskId: a.task_id, reason }, (e) => this.store.persistEvent(e));
  }

  async _resolve(id, status, actor, reason) {
    const a = this.store.getApproval(id);
    if (!a) throw new Error(`resolve: unknown approval ${id}`);
    // Note: a human decision is always recordable, even mid-freeze — the
    // kill switch gates EXECUTION, not the human. An approval granted while
    // paused yields outcome 'blocked' below instead of running.
    const updated = this.store.decideApproval(id, { status, decidedBy: actor, reason });
    if (!updated) {
      throw new Error(`approval ${id} already ${a.status}`);
    }
    this.audit.record({
      actor,
      tier: a.tier,
      action: a.action,
      decision: status,
      reason: reason || (status === 'approved' ? 'approved by human' : 'rejected by human'),
    });
    this.bus.emitEvent(
      status === 'approved' ? 'approval.granted' : 'approval.rejected',
      { approvalId: id, taskId: a.task_id, action: a.action, tier: a.tier, actor, reason },
      (e) => this.store.persistEvent(e),
    );
    for (const fn of this._onResolution.get(id) ?? []) fn(status);
    return this.store.getApproval(id);
  }

  /** Everything waiting for a human, newest last. This is the console inbox. */
  pending() {
    return this.store.listApprovals('pending');
  }

  /** On startup: cancel approvals whose tasks have moved on. */
  cancelOrphans() {
    const activeStates = new Set(['awaiting_approval', 'pr_open']);
    for (const a of this.pending()) {
      const task = this.store.getTask(a.task_id);
      if (!task || !activeStates.includes(task.state)) this.cancel(a.id, 'task no longer awaiting approval');
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
