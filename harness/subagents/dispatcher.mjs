// The subagent dispatcher: one subagent per task, bounded and contained.
//
//   - semaphore caps concurrency (frozen swarm size)
//   - conflict locks: two tasks that touch the same file never run at once
//   - hard timeout per agent: a hung agent is killed and marked failed,
//     it never holds a slot
//   - bounded retries with backoff (max 2), then needs_human
//   - spend meter gates every dispatch; the cap engages the kill switch
//   - fix agents (reconciler) run at high priority and jump the queue
//
// The dispatcher never merges, never approves, never bypasses the gate. It
// delivers PRs to `pr_open` and stops. Integration is the merge queue's job.

import { STATES } from '../core/state.mjs';
import { branchForTask } from '../core/ids.mjs';

export class Dispatcher {
  /**
   * @param {object} deps
   * @param {import('../core/store.mjs').Store} deps.store
   * @param {import('../core/events.mjs').EventBus} deps.bus
   * @param {import('../core/spend.mjs').SpendMeter} deps.spend
   * @param {object} deps.backend subagent execution backend
   * @param {import('../policy/engine.mjs').PolicyEngine} deps.policy
   * @param {object} opts
   * @param {number} opts.maxConcurrency
   * @param {number} opts.timeoutMs
   * @param {number} opts.maxRetries
   */
  constructor({ store, bus, spend, backend, policy, ...opts }) {
    this.store = store;
    this.bus = bus;
    this.spend = spend;
    this.backend = backend;
    this.policy = policy;
    this.maxConcurrency = opts.maxConcurrency ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this._active = new Set(); // task ids currently running
    this._fileLocks = new Map(); // file -> task id holding it
    this._wake = () => {};
  }

  get activeCount() { return this._active.size; }

  /**
   * Entry point: pump the ready queue until everything is terminal or the
   * swarm is paused. In-flight agents are awaited before returning, so a
   * paused swarm still reports its last steps honestly.
   */
  async drain() {
    const inFlight = new Set();
    for (;;) {
      if (this.policy.paused || this.spend.overCap) {
        await Promise.allSettled(inFlight);
        this._flagBlockedWork(this.policy.paused ? 'swarm paused (kill switch)' : 'spend cap reached');
        return;
      }
      const next = this._pickNext();
      if (!next) {
        if (this._active.size === 0) return;
        await this._waitForSlot();
        continue;
      }
      const p = this._launch(next)
        .catch((err) => this._crash(next, err))
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
  }

  /** Work that can no longer start is marked needs_human with a reason —
   *  the console must show WHY the swarm stopped, not just that it did. */
  _flagBlockedWork(reason) {
    for (const t of this.store.listTasksInStates([STATES.PLANNED])) {
      this.store.transitionTask(t.id, STATES.NEEDS_HUMAN, {
        result: { ...(t.result ?? {}), blocked: reason },
      });
      this.bus.emitEvent('agent.blocked', { taskId: t.id, reason }, (e) => this.store.persistEvent(e));
    }
  }

  /** Priority order: fixes first, then planned/queued, oldest first. */
  _pickNext() {
    if (this._active.size >= this.maxConcurrency) return null;
    const candidates = this.store
      .listTasksInStates([STATES.PLANNED, STATES.TESTS_FAILED, STATES.FAILED])
      .filter((t) => !this._active.has(t.id))
      .filter((t) => t.attempts <= this.maxRetries)
      .filter((t) => this._filesFree(t));
    const ready = candidates.filter((t) => t.state !== STATES.FAILED || t.attempts < this.maxRetries);
    if (ready.length === 0) return null;
    return ready.sort((a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at))[0];
  }

  _filesFree(task) {
    const spec = task.spec ?? {};
    const touches = spec.touches?.length ? spec.touches : [`*${task.id}`];
    return touches.every((f) => !this._fileLocks.has(f) || this._fileLocks.get(f) === task.id);
  }

  _lockFiles(task) {
    const spec = task.spec ?? {};
    const touches = spec.touches?.length ? spec.touches : [`*${task.id}`];
    for (const f of touches) this._fileLocks.set(f, task.id);
  }

  _unlockFiles(task) {
    const spec = task.spec ?? {};
    const touches = spec.touches?.length ? spec.touches : [`*${task.id}`];
    for (const f of touches) {
      if (this._fileLocks.get(f) === task.id) this._fileLocks.delete(f);
    }
  }

  async _launch(task) {
    this._active.add(task.id);
    this._lockFiles(task);
    const attempts = task.attempts + 1;
    this.store.transitionTask(task.id, STATES.DISPATCHED, { attempts, branch: branchForTask(task.id) });
    this.store.transitionTask(task.id, STATES.RUNNING);

    if (!this.spend.reserve(`agent:${task.id}`)) {
      this.store.transitionTask(task.id, STATES.NEEDS_HUMAN, {
        result: { reason: 'spend cap reached before dispatch' },
      });
      this._release(task.id);
      return;
    }

    this.bus.emitEvent('agent.started', {
      taskId: task.id, title: task.title, backend: this.backend.name, attempt: attempts,
    }, (e) => this.store.persistEvent(e));
    this._wake();

    try {
      const result = await withTimeout(
        this.backend.run({ spec: task.spec, branch: branchForTask(task.id), taskId: task.id }),
        this.timeoutMs,
        `agent ${task.id} timed out after ${this.timeoutMs}ms`,
      );

      if (result?.ok) {
        this.store.transitionTask(task.id, STATES.TESTS_PASSED, { result });
        this.bus.emitEvent('agent.tests_passed', { taskId: task.id, branch: branchForTask(task.id) }, (e) => this.store.persistEvent(e));
      } else if (attempts <= this.maxRetries) {
        this.store.transitionTask(task.id, STATES.TESTS_FAILED, { result: result ?? {} });
        this.bus.emitEvent('agent.tests_failed', {
          taskId: task.id, attempt: attempts, reason: result?.reason ?? 'tests failed', retry: true,
        }, (e) => this.store.persistEvent(e));
      } else {
        this.store.transitionTask(task.id, STATES.FAILED, { result: result ?? {} });
        this.bus.emitEvent('agent.failed', { taskId: task.id, attempts, reason: result?.reason ?? 'tests failed, retries exhausted' }, (e) => this.store.persistEvent(e));
      }
    } catch (err) {
      if (attempts <= this.maxRetries) {
        this.store.transitionTask(task.id, STATES.TESTS_FAILED, { result: { error: err.message } });
        this.bus.emitEvent('agent.retry', { taskId: task.id, attempt: attempts, error: err.message }, (e) => this.store.persistEvent(e));
        await backoff(attempts);
      } else {
        this.store.transitionTask(task.id, STATES.FAILED, { result: { error: err.message } });
        this.bus.emitEvent('agent.failed', { taskId: task.id, attempts, error: err.message }, (e) => this.store.persistEvent(e));
      }
    } finally {
      this._release(task.id);
      this._wake();
    }
  }

  _release(taskId) {
    this._active.delete(taskId);
    const t = this.store.getTask(taskId);
    if (t) this._unlockFiles({ id: taskId, spec: t.spec });
    else this._unlockFiles({ id: taskId, spec: {} });
  }

  _crash(task, err) {
    // a launch crash must never wedge the swarm
    try {
      this.store.transitionTask(task.id, STATES.NEEDS_HUMAN, { result: { crash: err.message } });
    } catch { /* already moved on */ }
    this._release(task.id);
    this._wake();
  }

  _waitForSlot() {
    return new Promise((resolve) => {
      this._wake = () => { this._wake = () => {}; resolve(); };
    });
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function backoff(attempt) {
  await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10_000)));
}
