// The orchestrator: one object that wires the whole harness together and
// owns the run loop. Everything is constructed from persisted state, so a
// crashed or restarted process resumes exactly where it left off — that is
// session durability, and it is a scored feature, not an accident.

import path from 'node:path';
import { loadConfig } from './config.mjs';
import { Store } from './core/store.mjs';
import { AuditLog } from './core/audit.mjs';
import { EventBus } from './core/events.mjs';
import { PolicyEngine } from './policy/engine.mjs';
import { ApprovalGate } from './gate/approval_gate.mjs';
import { GitHubMCP } from './mcp_clients/github.mjs';
import { TrueForgeBackend, LocalBackend } from './subagents/backends.mjs';
import { SandboxRunner } from './sandbox_runner.mjs';
import { Dispatcher } from './subagents/dispatcher.mjs';
import { MergeQueue } from './merge_queue.mjs';
import { Reconciler } from './reconciler.mjs';
import { Planner } from './planner/spec_enhancer.mjs';
import { SpendMeter } from './core/spend.mjs';
import { ReviewStage } from './reviewer.mjs';
import { loadSkills } from './skills/loader.mjs';
import { STATES } from './core/state.mjs';

export class Orchestrator {
  constructor(config = loadConfig()) {
    this.config = config;
    this.store = new Store(path.join(config.dataDir, 'foreman.db'));
    this.bus = new EventBus();
    this.audit = new AuditLog(this.store, path.join(config.evidenceDir, 'audit.log'));
    this.policy = new PolicyEngine({ t1Auto: config.t1Auto, store: this.store, audit: this.audit, bus: this.bus });
    this.gate = new ApprovalGate({ store: this.store, audit: this.audit, bus: this.bus, policy: this.policy });
    this.github = new GitHubMCP({ config, audit: this.audit });
    this.sandbox = new SandboxRunner({
      repoDir: config.targetLocal,
      sandboxRoot: path.join(config.dataDir, 'sandbox'),
      timeoutMs: config.agentTimeoutMs,
    });

    // skills registry: startup fails loud on any malformed skill
    this.skills = loadSkills(path.join(config.root, 'skills'));

    const authorizeWrite = async (action, ctx) => {
      const verdict = this.policy.decide(action, ctx);
      if (verdict.decision === 'auto') return { allowed: true };
      if (verdict.decision === 'block') return { allowed: false, reason: verdict.reason };
      const cacheKey = ctx.taskId ?? 'adhoc';
      this._taskWriteVerdicts ??= new Map();
      if (!this._taskWriteVerdicts.has(cacheKey)) {
        const outcome = await this.gate.request({
          taskId: ctx.taskId,
          action,
          summary: `Allow agent writes for ${cacheKey} (branch + commit on its own branch)`,
          detail: { files: ctx.files ?? [], tier: verdict.tier },
        });
        this._taskWriteVerdicts.set(cacheKey, outcome.outcome === 'approved');
      }
      return this._taskWriteVerdicts.get(cacheKey)
        ? { allowed: true }
        : { allowed: false, reason: 'human declined agent writes for this task' };
    };

    this.backend = config.trueforgeUrl
      ? new TrueForgeBackend({
          config,
          registry: this.skills,
          github: this.github,
          sandbox: this.sandbox,
          authorize: authorizeWrite,
        })
      : new LocalBackend({
          github: this.github,
          sandbox: this.sandbox,
          // The policy bridge the local backend requires. Gated actions are
          // NOT refusals — they become real pending approvals on the console;
          // one yes per task covers its write set.
          authorize: authorizeWrite,
        });

    this.spend = new SpendMeter({
      capUsd: config.spendCapUsd,
      perRunUsd: config.costPerAgentRunUsd,
      store: this.store, audit: this.audit, bus: this.bus,
    });
    this.dispatcher = new Dispatcher({
      store: this.store, bus: this.bus, spend: this.spend,
      backend: this.backend, policy: this.policy,
      maxConcurrency: config.maxConcurrency,
      timeoutMs: config.agentTimeoutMs,
      maxRetries: config.maxRetries,
    });
    this.reviewer = new ReviewStage({
      github: this.github, bus: this.bus, persist: (e) => this.store.persistEvent(e),
    });
    this.reconciler = new Reconciler({
      store: this.store, bus: this.bus, audit: this.audit, sandbox: this.sandbox,
    });
    this.queue = new MergeQueue({
      store: this.store, bus: this.bus, gate: this.gate,
      github: this.github, sandbox: this.sandbox, spend: this.spend,
      reviewer: this.reviewer,
      reconciler: this.reconciler, // main health is checked after every merge
    });
    this.planner = new Planner({ bus: this.bus, persist: (e) => this.store.persistEvent(e) });
  }

  async start() {
    this.gate.cancelOrphans();
    return this.github.connect();
  }

  async stop() {
    // release the durable merge lock before closing: a graceful shutdown
    // must not make the next process wait out the TTL
    try {
      this.queue?.releaseLock();
    } catch { /* store already closed */ }
    await this.github.close();
    this.store.close();
  }

  /** Full pipeline: backlog -> specs -> swarm -> review -> PRs -> gate. */
  async runBacklog({ issues } = {}) {
    const backlog = issues ?? await this.github.listIssues();
    this.bus.emitEvent('run.started', {
      issues: backlog.length, backend: this.backend.name,
      t1Auto: this.policy.t1Auto, spendCapUsd: this.config.spendCapUsd,
      skills: [...this.skills.keys()],
    }, (e) => this.store.persistEvent(e));

    // plan: raw issues -> structured specs (skip tasks that already exist)
    const specs = this.planner.plan(backlog);
    for (const spec of specs) {
      const existing = this.store.getTask(spec.id);
      if (!existing) {
        this.store.upsertTask({
          id: spec.id, title: spec.title, state: STATES.PLANNED,
          risk_tier: spec.risk_tier, spec, issue_number: spec.issue_number,
        });
      } else if ([STATES.MERGED, STATES.REJECTED].includes(existing.state)) {
        // terminal tasks are never re-dispatched (idempotent re-runs)
      } else {
        this.store.upsertTask({ ...existing, spec });
      }
    }

    // swarm: parallel implementation, bounded
    await this.dispatcher.drain();

    // integration: review -> PRs -> serialized verified merges (stops at the gate)
    await this.queue.processAll();

    // health: did main survive? (fixes jump the queue, still gated)
    const anyMerged = this.store.listTasksInStates([STATES.MERGED]).length > 0;
    if (anyMerged) await this.reconciler.reconcile({ trigger: 'post-run' });

    this.bus.emitEvent('run.completed', this.summary(), (e) => this.store.persistEvent(e));
    return this.summary();
  }

  /** Continue a run in progress (resume after restart or after a decision). */
  async resume() {
    this.bus.emitEvent('run.resumed', this.summary(), (e) => this.store.persistEvent(e));
    await this.dispatcher.drain();
    await this.queue.processAll();
    return this.summary();
  }

  summary() {
    const counts = {};
    for (const t of this.store.listTasks()) counts[t.state] = (counts[t.state] ?? 0) + 1;
    return {
      tasks: counts,
      pendingApprovals: this.gate.pending().map((a) => ({ id: a.id, action: a.action, tier: a.tier, taskId: a.task_id })),
      spend: this.spend.snapshot(),
      paused: this.policy.paused,
      backend: this.backend.name,
      mainHealth: this.store.getMeta('main.health') ?? 'unknown',
    };
  }
}
