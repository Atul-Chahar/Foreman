#!/usr/bin/env node
// foreman — the operator's entry point.
//
//   foreman demo                       seed + run the full gated pipeline
//   foreman run [--t1-auto]            backlog -> swarm -> review -> PRs -> gate
//   foreman resume                     continue after a restart or a decision
//   foreman status                     counts, pending approvals, spend, health
//   foreman approvals                  list what is waiting for a human
//   foreman approve <id> [--reason s]  satisfy the gate (prints the case first)
//   foreman reject <id> --reason s     refuse the gate (prints the case first)
//   foreman tasks list [--state s]     every task and where it stands
//   foreman tasks retry <id>           needs_human -> planned (human resolves)
//   foreman tasks reject <id>          needs_human -> rejected (human drops it)
//   foreman policy t1 auto <on|off>    opt in/out of T1 auto-approval
//   foreman killswitch <engage|release> freeze / thaw the whole swarm
//   foreman skills list                the skill pack the swarm runs on
//
// T2 (merge to main) can never be auto-approved. There is no flag for it.

import { Orchestrator } from './orchestrator.mjs';
import { loadConfig } from './config.mjs';
import { STATES } from './core/state.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function arg(flag, { fallback = null } = {}) {
  const i = rest.indexOf(flag);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : fallback;
}
function has(flag) { return rest.includes(flag); }

function fail(msg, code = 1) {
  console.error(`foreman: ${msg}`);
  process.exit(code);
}

async function withOrchestrator(fn) {
  const orch = new Orchestrator(loadConfig());
  try {
    await orch.start();
    console.log(`foreman: backend=${orch.backend.name} target=${orch.config.targetLocal}`);
    return await fn(orch);
  } finally {
    await orch.stop();
  }
}

function printSummary(orch, s) {
  console.log('\n── run summary ' + '─'.repeat(30));
  const tasks = Object.entries(s.tasks);
  if (tasks.length === 0) console.log('  tasks: (none)');
  for (const [state, n] of tasks) console.log(`  ${state.padEnd(20)} ${n}`);
  console.log(`  backend=${s.backend}  main=${s.mainHealth}  paused=${s.paused}`);
  console.log(`  spend=$${s.spend.spentUsd}/$${s.spend.capUsd}${s.spend.overCap ? ' (CAP HIT)' : ''}`);
  printPending(orch);
}

function printPending(orch) {
  const pending = orch.gate.pending();
  if (pending.length === 0) {
    console.log('\n  pending approvals: none');
    return;
  }
  console.log(`\n  ⚠ PENDING HUMAN APPROVALS (${pending.length}):`);
  for (const a of pending) {
    console.log(`    ${a.id}  [${a.tier}] ${a.action}  task=${a.task_id}`);
    console.log(`        ${a.summary}`);
  }
  console.log('    -> foreman approvals / foreman approve <id> / foreman reject <id> --reason s');
}

function printApprovalCase(a) {
  console.log(`\n┌─ ${a.id} [${a.tier}] ${a.action}  (task ${a.task_id})`);
  console.log(`│  ${a.summary}`);
  const d = a.detail ?? {};
  if (d.tests) {
    console.log(`│  sandbox tests: exit=${d.tests.exitCode} timedOut=${d.tests.timedOut ?? false} durationMs=${d.tests.durationMs ?? 0}`);
  }
  if (d.review) {
    console.log(`│  review: ${d.review.ok ? 'passed' : 'BLOCKED'}${d.review.degraded ? ' (degraded)' : ''}`);
    for (const f of d.review.findings ?? []) {
      console.log(`│    ${f.severity === 'blocking' ? '✖' : '△'} ${f.rule}${f.file ? ` (${f.file})` : ''}: ${f.message}`);
    }
  } else {
    console.log('│  review: (not run)');
  }
  if (typeof d.diff === 'string' && d.diff.length > 0) {
    const lines = d.diff.split('\n');
    const shown = lines.slice(0, 40);
    console.log(`│  diff (first ${shown.length} of ${lines.length} lines):`);
    for (const l of shown) console.log(`│  ${l}`);
  }
  console.log('└─');
}

async function main() {
  switch (cmd) {
    case 'demo': {
      // lazy import: the seed script is optional tooling and must never be a
      // module-loading dependency of the CLI itself
      const { seedDemo } = await import('../scripts/seed.mjs');
      await seedDemo(loadConfig(), { quiet: false });
      await withOrchestrator(async (orch) => {
        const s = await orch.runBacklog();
        printSummary(orch, s);
      });
      break;
    }

    case 'run': {
      await withOrchestrator(async (orch) => {
        if (has('--t1-auto') && !orch.policy.t1Auto) {
          orch.policy.setT1Auto(true, 'human:cli');
          console.log('policy: T1 auto-approval ON (reversible writes proceed automatically; T2 stays gated)');
        }
        const s = await orch.runBacklog();
        printSummary(orch, s);
      });
      break;
    }

    case 'resume': {
      await withOrchestrator(async (orch) => {
        const s = await orch.resume();
        printSummary(orch, s);
      });
      break;
    }

    case 'status': {
      await withOrchestrator(async (orch) => {
        printSummary(orch, orch.summary());
      });
      break;
    }

    case 'approvals': {
      await withOrchestrator(async (orch) => {
        const pending = orch.gate.pending();
        if (pending.length === 0) {
          console.log('no pending approvals');
          return;
        }
        for (const a of pending) printApprovalCase(a);
        console.log(`\n${pending.length} approval(s) waiting. Nothing merges until you decide.`);
      });
      break;
    }

    case 'approve':
    case 'reject': {
      const id = rest[0];
      if (!id) fail(`usage: foreman ${cmd} <id> ${cmd === 'reject' ? '--reason "why" ' : ''}`);
      const reason = arg('--reason', { fallback: cmd === 'reject' ? null : '' });
      if (cmd === 'reject' && !reason) fail('rejecting requires --reason — the audit trail must say why');
      await withOrchestrator(async (orch) => {
        const a = orch.store.getApproval(id);
        if (!a) fail(`unknown approval '${id}'`);
        if (a.status !== 'pending') fail(`approval '${id}' is already ${a.status}`);
        printApprovalCase(a);
        if (cmd === 'approve') await orch.gate.approve(id, 'human:cli', reason);
        else await orch.gate.reject(id, 'human:cli', reason);
        console.log(`\n${cmd === 'approve' ? '✔ approved' : '✖ rejected'} ${id}${reason ? ` — ${reason}` : ''}`);
        // gate-watch invariant: whoever decides re-drives integration
        const s = await orch.resume();
        printSummary(orch, s);
      });
      break;
    }

    case 'tasks': {
      const sub = rest[0];
      if (sub === 'list') {
        await withOrchestrator(async (orch) => {
          const state = arg('--state');
          const tasks = state
            ? orch.store.listTasksInStates([state])
            : orch.store.listTasks();
          if (tasks.length === 0) { console.log('no tasks'); return; }
          for (const t of tasks) {
            const flags = [
              t.kind === 'fix' ? 'fix' : null,
              `try ${t.attempts}`,
              t.result?.blocked ? `blocked:${t.result.blocked}` : null,
              t.result?.review && t.result.review.ok === false ? 'review-blocked' : null,
            ].filter(Boolean).join(' ');
            console.log(`${t.id.padEnd(16)} ${t.state.padEnd(20)} ${flags}`);
            console.log(`${' '.repeat(16)} ${t.title}`);
          }
        });
      } else if (sub === 'retry' || sub === 'reject') {
        const id = rest[1];
        if (!id) fail(`usage: foreman tasks ${sub} <id>`);
        await withOrchestrator(async (orch) => {
          const t = orch.store.getTask(id);
          if (!t) fail(`unknown task '${id}'`);
          if (t.state !== STATES.NEEDS_HUMAN) fail(`task '${id}' is ${t.state}, not needs_human`);
          const to = sub === 'retry' ? STATES.PLANNED : STATES.REJECTED;
          orch.store.transitionTask(id, to);
          orch.audit.record({
            actor: 'human:cli', tier: t.risk_tier, action: `tasks.${sub}`,
            decision: sub === 'retry' ? 'requeued' : 'dropped', reason: 'human resolved needs_human',
          });
          console.log(`${id}: needs_human -> ${to}`);
          if (sub === 'retry') {
            const s = await orch.resume();
            printSummary(orch, s);
          }
        });
      } else {
        fail('usage: foreman tasks list|retry|reject');
      }
      break;
    }

    case 'policy': {
      // policy t1 auto <on|off>
      if (rest[0] !== 't1' || rest[1] !== 'auto') {
        fail('usage: foreman policy t1 auto <on|off>   (T2 is always gated; there is no command that changes it)');
      }
      const val = rest[2];
      if (val !== 'on' && val !== 'off') fail("expected 'on' or 'off'");
      await withOrchestrator(async (orch) => {
        orch.policy.setT1Auto(val === 'on', 'human:cli');
        console.log(`T1 auto-approval: ${val === 'on' ? 'ON' : 'OFF'} (T2 remains always gated — that is not configurable)`);
      });
      break;
    }

    case 'killswitch': {
      const action = rest[0];
      if (action !== 'engage' && action !== 'release') fail('usage: foreman killswitch engage|release');
      await withOrchestrator(async (orch) => {
        if (action === 'engage') {
          orch.policy.engageKillSwitch('human:cli', 'manual engage via CLI');
          console.log('kill switch ENGAGED — every pending swarm action is frozen (including T0 reads)');
        } else {
          orch.policy.releaseKillSwitch('human:cli');
          console.log('kill switch released — the swarm may proceed under policy');
        }
      });
      break;
    }

    case 'skills': {
      const orch = new Orchestrator(loadConfig());
      for (const [name, s] of orch.skills) {
        console.log(`${name.padEnd(18)} [${(s.tags.join(', ') || 'untagged')}] ${s.description}`);
      }
      orch.stop();
      break;
    }

    case 'help':
    case undefined: {
      console.log(`foreman — supervised parallel agentic development

  the swarm implements your backlog; nothing reaches main until you approve it.

  foreman demo                        seed a demo target repo + run the pipeline
  foreman run [--t1-auto]             run the backlog through the swarm and the gate
  foreman resume                      continue after a restart or a decision
  foreman status                      task counts, pending approvals, spend, health
  foreman approvals                   inspect everything waiting for a human
  foreman approve <id> [--reason s]   approve a gated action (prints the case first)
  foreman reject <id> --reason s      reject a gated action
  foreman tasks list [--state s]      all tasks and their states
  foreman tasks retry <id>            requeue a needs_human task
  foreman tasks reject <id>           drop a needs_human task
  foreman policy t1 auto <on|off>     toggle auto-approval for reversible writes
  foreman killswitch <engage|release> freeze or thaw the entire swarm
  foreman skills list                 the skill pack the swarm runs on

  T2 actions (merge to main, force-push, deletes) are always gated.
  There is no flag, env var, or command that changes that.`);
      break;
    }

    default:
      fail(`unknown command '${cmd}' — try: foreman help`);
  }
}

try {
  // Top-level await makes the CLI lifecycle explicit: Node must not finish
  // while an async command (including a durable approval wait) is unsettled.
  await main();
} catch (err) {
  fail(err.message);
}
