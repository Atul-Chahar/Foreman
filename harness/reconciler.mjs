// The Reconciler. Watches the health of main after every merge; when the
// build breaks, it dispatches a high-priority fix subagent carrying the
// failing output as context.
//
// Bulkheaded: at most RECONCILER_MAX_FIX_ATTEMPTS fix attempts per failure,
// then it escalates to a human instead of looping against itself.
// Self-healing does not mean self-approving: the fix PR goes through the
// same T2 gate as everything else.

import { STATES, canTransition } from './core/state.mjs';

const RECONCILER_MAX_FIX_ATTEMPTS = 2;

export class Reconciler {
  /**
   * @param {object} deps
   * @param {import('./core/store.mjs').Store} deps.store
   * @param {import('./core/events.mjs').EventBus} deps.bus
   * @param {import('./core/audit.mjs').AuditLog} deps.audit
   * @param {import('./sandbox_runner.mjs').SandboxRunner} deps.sandbox
   */
  constructor({ store, bus, audit, sandbox }) {
    this.store = store;
    this.bus = bus;
    this.audit = audit;
    this.sandbox = sandbox;
  }

  /**
   * Run the suite on main. Healthy -> {ok:true}. Broken -> create a fix
   * task (or advance the existing one) and return {ok:false, fixTaskId}.
   */
  async reconcile({ trigger = 'post-merge' } = {}) {
    const test = await this.sandbox.exec({
      branch: 'main',
      command: this._mainTestCommand(),
      taskId: 'reconciler-health',
    });

    if (test.ok) {
      this.store.setMeta('main.health', 'green');
      this.bus.emitEvent('reconciler.healthy', { trigger, durationMs: test.durationMs }, (e) => this.store.persistEvent(e));
      return { ok: true, test };
    }

    this.store.setMeta('main.health', 'red');
    this.bus.emitEvent('reconciler.main_broken', {
      trigger,
      exitCode: test.exitCode,
      timedOut: test.timedOut,
      output: tail(test.stdout + test.stderr, 4000),
    }, (e) => this.store.persistEvent(e));
    this.audit.record({
      actor: 'system:reconciler', tier: null, action: 'health_check',
      decision: 'main-broken', reason: `trigger=${trigger} exit=${test.exitCode}`,
    });

    return { ok: false, test, fixTaskId: this._dispatchFix(test) };
  }

  _mainTestCommand() {
    return this.store.getMeta('main.test_command') || 'node --test test/*.test.mjs';
  }

  /**
   * Create the NEXT bounded fix round for the current breakage. Bulkheaded
   * in two layers: the reconciler caps ROUNDS via meta, and each round is a
   * fresh task so resetting never needs an illegal state transition.
   */
  _dispatchFix(test) {
    const culprit = this._lastMergedTask();
    const culpritId = culprit?.id ?? 'unknown';
    const attemptsKey = `fix.attempts.${culpritId}`;
    const attempts = Number(this.store.getMeta(attemptsKey) || '0');

    if (attempts >= RECONCILER_MAX_FIX_ATTEMPTS) {
      this._escalate(culpritId, attempts);
      return `fix-${culpritId}-r${attempts}`;
    }

    // a fresh task per round: PLANNED start is always legal, and the old
    // round's history stays intact for the audit trail
    const fixTaskId = `fix-${culpritId}-r${attempts + 1}`;
    this.store.setMeta(attemptsKey, String(attempts + 1));

    const spec = {
      id: fixTaskId,
      title: `Fix broken main after ${culprit ? `"${culprit.title}"` : 'unknown merge'}`,
      issue_number: culprit?.spec?.issue_number ?? null,
      source: 'reconciler',
      context_files: culprit?.spec?.touches ?? [],
      acceptance_criteria: ['test suite on main passes again'],
      test_command: this._mainTestCommand(),
      touches: culprit?.spec?.touches ?? [],
      risk_tier: 'T1',
      conflicts_with: [],
      // The fix context the fix-agent receives: what failed, where, and what
      // the culprit changed. An LLM fix agent works from this; the local
      // backend can carry an explicit revert in `impl`.
      failure_output: tail((test.stdout || '') + (test.stderr || ''), 6000),
      culprit: culprit ? { id: culprit.id, title: culprit.title, branch: culprit.branch } : null,
    };

    this.store.upsertTask({
      id: fixTaskId,
      title: spec.title,
      state: STATES.PLANNED,
      priority: 10, // fixes jump the dispatcher queue
      kind: 'fix',
      fix_for: culprit?.id ?? null,
      spec,
    });
    this.bus.emitEvent('reconciler.fix_dispatched', {
      fixTaskId, culprit: culprit?.id ?? null, priority: 10,
    }, (e) => this.store.persistEvent(e));
    return fixTaskId;
  }

  /** Mark the latest round escalated — via a legal transition when one
   *  exists, and always with a loud event + audit row regardless. */
  _escalate(culpritId, attempts) {
    const latest = this.store.getTask(`fix-${culpritId}-r${attempts}`);
    if (latest && latest.state !== STATES.NEEDS_HUMAN && canTransition(latest.state, STATES.NEEDS_HUMAN)) {
      this.store.transitionTask(latest.id, STATES.NEEDS_HUMAN, {
        result: { ...(latest.result ?? {}), escalated: 'reconciler bulkhead: max fix rounds reached' },
      }, { actor: 'system:reconciler', reason: 'max fix rounds' });
    }
    this.bus.emitEvent('reconciler.escalated', { culpritId, attempts }, (e) => this.store.persistEvent(e));
    this.audit.record({
      actor: 'system:reconciler', tier: null, action: 'reconciler_escalate',
      decision: 'needs_human', reason: `${attempts} fix rounds exhausted for ${culpritId}`,
    });
  }

  /**
   * The culprit is the task merged MOST RECENTLY by merge sequence number —
   * creation order says nothing about what landed on main last.
   */
  _lastMergedTask() {
    const merged = this.store.listTasksInStates([STATES.MERGED]);
    return (
      merged.sort((a, b) => (b.result?.merged?.seq ?? 0) - (a.result?.merged?.seq ?? 0))[0] ?? null
    );
  }
}

function tail(s, n) {
  return String(s ?? '').slice(-n);
}
