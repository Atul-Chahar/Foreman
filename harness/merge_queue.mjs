// The merge queue. Parallel work, SERIAL integration — the invariant that
// keeps main green while eight agents land changes.
//
//   1. A tests-passed task opens its PR (T1 action: auto when the human has
//      opted in, gated otherwise).
//   2. Merge itself is T2: it stops at the approval gate, always.
//   3. AFTER the human approves, the branch is rebased onto the CURRENT
//      main and the tests re-run in the sandbox. A PR that passed alone can
//      break after its neighbor landed; that is caught here, not on main.
//   4. Only then does the real merge execute (over MCP). Conflicts and
//      post-rebase failures mark the PR needs_human and the queue moves on.
//
// A single lock guarantees one merge in flight at any moment. There is no
// force-push anywhere in this file — that is T2 policy, enforced upstream.

import { spawnSync } from 'node:child_process';
import { STATES } from './core/state.mjs';

export class MergeQueue {
  /**
   * @param {object} deps
   * @param {import('./core/store.mjs').Store} deps.store
   * @param {import('./core/events.mjs').EventBus} deps.bus
   * @param {import('./gate/approval_gate.mjs').ApprovalGate} deps.gate
   * @param {import('./mcp_clients/github.mjs').GitHubMCP} deps.github
   * @param {import('./sandbox_runner.mjs').SandboxRunner} deps.sandbox
   * @param {import('./core/spend.mjs').SpendMeter} [deps.spend]
   */
  constructor({ store, bus, gate, github, sandbox, spend }) {
    this.store = store;
    this.bus = bus;
    this.gate = gate;
    this.github = github;
    this.sandbox = sandbox;
    this.spend = spend;
    this._busy = false;
  }

  /**
   * Process every task that has passed tests: open PRs, then drive each
   * through the gate and the serialized merge. Sequential by design.
   */
  async processAll() {
    if (this._busy) return;
    this._busy = true;
    try {
      // 1) open PRs for everything tests-passed (T1)
      for (const task of this.store.listTasksInStates([STATES.TESTS_PASSED])) {
        await this.openPR(task);
      }
      // 2) drive PRs and approved tasks through the serial merge section
      for (const task of this.store.listTasksInStates([STATES.PR_OPEN, STATES.AWAITING_APPROVAL])) {
        await this.drive(task);
      }
    } finally {
      this._busy = false;
    }
  }

  async openPR(task) {
    const branch = task.branch;
    const result = task.result ?? {};
    const body = [
      `Closes #${task.spec?.issue_number ?? '?'}`,
      '',
      '## Acceptance criteria',
      ...(task.spec?.acceptance_criteria ?? []).map((c) => `- [x] ${c}`),
      '',
      '## Sandbox test run',
      '```',
      `exit=${result.test?.exitCode} timedOut=${result.test?.timedOut ?? false} durationMs=${result.test?.durationMs ?? 0}`,
      (result.test?.stdout ?? '').slice(0, 1500),
      '```',
      '',
      '---',
      'Opened by a foreman subagent. Merge requires human approval (T2).',
    ].join('\n');

    const verdict = await this.gate.request({
      taskId: task.id,
      action: 'open_pr',
      summary: `Open PR for ${task.id} (${branch})`,
      detail: { files: result.files ?? [], tests: result.test ?? {} },
    });
    if (verdict.outcome === 'rejected') {
      this.store.transitionTask(task.id, STATES.REJECTED, { result: { ...result, rejected_at: 'open_pr' } });
      return;
    }

    const pr = await this.github.createPR(branch, `${task.title} [${task.id}]`, body);
    this.store.transitionTask(task.id, STATES.PR_OPEN, { pr_number: pr.number });
    this.bus.emitEvent('pr.opened', { taskId: task.id, pr: pr.number, branch }, (e) => this.store.persistEvent(e));
    this.store.setMeta(`pr.${task.id}`, String(pr.number));
  }

  /** One task from pr_open/awaiting_approval to a terminal-or-gated state. */
  async drive(task) {
    if (task.state === STATES.PR_OPEN) {
      // enter the gate: merge is T2, so this waits for a human by design
      const waiting = this.gate.request({
        taskId: task.id,
        action: 'merge_to_main',
        summary: `Merge PR #${task.pr_number} (${task.branch}) into main — irreversible`,
        detail: {
          diff: await this.safeDiff(task),
          tests: task.result?.test ?? {},
          files: task.result?.files ?? [],
        },
      });
      this.store.transitionTask(task.id, STATES.AWAITING_APPROVAL);
      const verdict = await waiting; // resolves when the human decides
      if (verdict.outcome !== 'approved') {
        this.store.transitionTask(task.id, STATES.REJECTED, {
          result: { ...(task.result ?? {}), gate: 'rejected by human' },
        });
        this.bus.emitEvent('pr.rejected', { taskId: task.id, pr: task.pr_number }, (e) => this.store.persistEvent(e));
        return;
      }
      await this.executeMerge(task, this._authorizationFor(task, verdict));
      return;
    }

    if (task.state === STATES.AWAITING_APPROVAL) {
      // approved earlier (e.g. process restarted between approve and merge)
      const auth = this._authorizationFor(task);
      if (!auth) return; // still pending; nothing to do
      await this.executeMerge(task, auth);
      return;
    }

    await this.executeMerge(task);
  }

  /**
   * The T2 authorization that travels with the merge call: the approval id
   * and the human who made the decision. The merge facade refuses to execute
   * without it — the gate's yes is what unlocks the irreversible action.
   */
  _authorizationFor(task, verdict = null) {
    let a = null;
    if (verdict?.id) {
      const row = this.store.getApproval(verdict.id);
      if (row?.status === 'approved') a = row;
    }
    if (!a) {
      [a] = this.store
        .listApprovals('approved')
        .filter((x) => x.task_id === task.id && x.action === 'merge_to_main');
    }
    return a ? { approvalId: a.id, decidedBy: a.decided_by ?? 'human:unknown' } : null;
  }

  /** The serialized, verified merge. One at a time, rebase-test first. */
  async executeMerge(task, authorization) {
    this.bus.emitEvent('merge.started', { taskId: task.id, pr: task.pr_number }, (e) => this.store.persistEvent(e));
    try {
      // rebase + re-test against the current main
      const verified = await this.rebaseAndTest(task);
      if (!verified.ok) {
        this.store.transitionTask(task.id, STATES.NEEDS_HUMAN, {
          result: { ...(task.result ?? {}), merge_block: verified.reason },
        });
        this.bus.emitEvent('merge.blocked', {
          taskId: task.id, pr: task.pr_number, reason: verified.reason,
        }, (e) => this.store.persistEvent(e));
        return; // queue keeps moving; one conflict never stalls it
      }

      const merged = await this.github.mergePR(task.pr_number, authorization);
      this.store.transitionTask(task.id, STATES.MERGED, { result: { ...(task.result ?? {}), merged: merged } });
      this.bus.emitEvent('merge.completed', {
        taskId: task.id, pr: task.pr_number, head: merged.head,
      }, (e) => this.store.persistEvent(e));
    } catch (err) {
      if (err.code === 'MERGE_CONFLICT' || /conflict/i.test(err.message ?? '')) {
        this.store.transitionTask(task.id, STATES.NEEDS_HUMAN, {
          result: { ...(task.result ?? {}), merge_block: err.message },
        });
        this.bus.emitEvent('merge.blocked', { taskId: task.id, pr: task.pr_number, reason: err.message }, (e) => this.store.persistEvent(e));
        return;
      }
      throw err;
    }
  }

  /**
   * Rebase the task branch onto current main and re-run the test suite in
   * the sandbox. Returns {ok} or {ok:false, reason}.
   */
  async rebaseAndTest(task) {
    const branch = task.branch;
    const repo = this.sandbox.repoDir;

    // bring branch up to date with main (no force anywhere: rebase writes a
    // new head for THIS branch only; main is never rewritten)
    const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    git(['checkout', branch]);
    const r = git(['rebase', 'main']);
    if (r.status !== 0) {
      git(['rebase', '--abort'], { allowFail: true });
      git(['checkout', 'main'], { allowFail: true });
      return { ok: false, reason: `rebase onto main conflicted: ${(r.stderr || '').trim().slice(0, 300)}` };
    }

    const test = await this.sandbox.exec({
      branch,
      command: task.spec?.test_command || 'node --test test/',
      taskId: `${task.id}-reverify`,
    });
    git(['checkout', 'main'], { allowFail: true });

    if (!test.ok) {
      return {
        ok: false,
        reason: test.refused ?? (test.timedOut
          ? `post-rebase tests timed out after ${test.durationMs}ms`
          : `post-rebase tests failed (exit ${test.exitCode})`),
      };
    }
    return { ok: true, test };
  }

  async safeDiff(task) {
    try {
      return await this.github.getPRDiff(task.pr_number);
    } catch {
      return '(diff unavailable)';
    }
  }
}
