// The Reconciler. Watches the health of main after every merge; when the
// build breaks, it dispatches a high-priority fix subagent carrying the
// failing output as context.
//
// Bulkheaded: at most RECONCILER_MAX_FIX_ATTEMPTS fix attempts per failure,
// then it escalates to a human instead of looping against itself.
// Self-healing does not mean self-approving: the fix PR goes through the
// same T2 gate as everything else.

import { STATES } from './core/state.mjs';

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

  /** Create or advance the fix task for the current breakage. Bulkheaded. */
  _dispatchFix(test) {
    const culprit = this._lastMergedTask();
    const fixTaskId = `fix-${culprit?.id ?? 'unknown'}`;

    const existing = this.store.getTask(fixTaskId);
    if (existing) {
      const attempts = existing.attempts;
      if (attempts >= RECONCILER_MAX_FIX_ATTEMPTS) {
        if (existing.state !== STATES.NEEDS_HUMAN) {
          this.store.transitionTask(existing.id, STATES.NEEDS_HUMAN, {
            result: { ...(existing.result ?? {}), escalated: 'reconciler bulkhead: max fix attempts reached' },
          });
          this.bus.emitEvent('reconciler.escalated', { fixTaskId, attempts }, (e) => this.store.persistEvent(e));
        }
        return fixTaskId;
      }
      // reset for another bounded attempt
      this.store.transitionTask(existing.id, STATES.PLANNED);
      return fixTaskId;
    }

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

  _lastMergedTask() {
    const merged = this.store.listTasksInStates([STATES.MERGED]);
    return merged.at(-1) ?? null;
  }
}

function tail(s, n) {
  return String(s ?? '').slice(-n);
}
