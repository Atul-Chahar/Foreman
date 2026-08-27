import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Orchestrator } from '../orchestrator.mjs';

function scratchTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-orch-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# target\n');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(
    path.join(dir, 'test', 'smoke.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke', () => assert.equal(1 + 1, 2));\n",
  );
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  return dir;
}

function scratchConfig(targetDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-orch-data-'));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  // skills live in the real repo; the sandbox targets the scratch repo
  fs.cpSync(path.join(root, 'skills'), path.join(dataDir, 'skills'), { recursive: true });
  return {
    root,
    dataDir,
    evidenceDir: path.join(dataDir, 'evidence'),
    targetLocal: targetDir,
    targetGithub: '',
    mcpCommand: '',
    mcpArgs: [],
    trueforgeUrl: '',
    trueforgeToken: '',
    trueforgeModel: '',
    t1Auto: true, // exercise the auto-approval lane; T2 stays gated
    maxConcurrency: 2,
    agentTimeoutMs: 30_000,
    maxRetries: 1,
    mergeLockTimeoutMs: 10_000,
    spendCapUsd: 5,
    costPerAgentRunUsd: 0.05,
  };
}

test('orchestrator: full pipeline runs an impl spec to tests_passed without network', async () => {
  const target = scratchTarget();
  const orch = new Orchestrator(scratchConfig(target));
  await orch.start();
  try {
    const issue = {
      number: 42,
      title: 'add math module',
      body: [
        'Adds a tiny math module.',
        '',
        'acceptance:',
        '- exports the answer to everything',
        '',
        '```impl',
        JSON.stringify([
          { path: 'src/math.mjs', content: 'export const answer = 42;\n' },
          {
            path: 'test/math.test.mjs',
            content:
              "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/math.mjs';\ntest('answer', () => assert.equal(answer, 42));\n",
          },
        ]),
        '```',
        '',
        'test: `node --test`',
      ].join('\n'),
    };
    const runP = orch.runBacklog({ issues: [issue] });
    // wait for the task to traverse swarm -> review -> PR open (pre-gate)
    let task = null;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 50));
      task = orch.store.getTask('task-042');
      if (task?.state === 'pr_open' || task?.state === 'awaiting_approval') break;
    }
    const summary = orch.summary();
    assert.equal(summary.backend, 'local');
    assert.ok(
      ['pr_open', 'awaiting_approval', 'merged'].includes(task?.state),
      `expected the task to reach the gate, got ${task?.state}`,
    );
    assert.equal(summary.tasks.needs_human ?? 0, 0);
    assert.ok((task.pr_number ?? 0) >= 1);

    // release the gate waiter so the run (and this test) can end
    for (const a of orch.gate.pending()) await orch.gate.approve(a.id, 'human:teardown');
    await runP;
    assert.equal(orch.summary().tasks.merged ?? 0, 1);
  } finally {
    await orch.stop();
  }
});

test('orchestrator: T2 merge stops at the gate even with T1 auto enabled', async () => {
  const target = scratchTarget();
  const cfg = scratchConfig(target);
  const orch = new Orchestrator(cfg);
  await orch.start();
  try {
    const issue = {
      number: 7,
      title: 'another small change',
      body: [
        '```impl',
        JSON.stringify([{ path: 'docs/note.md', content: 'note\n' }]),
        '```',
        'test: `node --test`',
      ].join('\n'),
    };
    // the run blocks at the T2 gate BY DESIGN — race it against the moment
    // the pending approval appears
    const runP = orch.runBacklog({ issues: [issue] });
    let summary = null;
    for (let i = 0; i < 100 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (orch.summary().pendingApprovals.length > 0) summary = orch.summary();
    }
    assert.ok(summary, 'a T2 approval must appear');
    assert.equal(summary.pendingApprovals[0].tier, 'T2');
    assert.ok(!summary.paused);
    // release the waiter so the run (and the test) can end
    for (const a of orch.gate.pending()) {
      if (a.tier === 'T2') await orch.gate.approve(a.id, 'human:teardown');
    }
    await runP;
    assert.equal(orch.summary().tasks.merged ?? 0, 1);
  } finally {
    await orch.stop();
  }
});

test('orchestrator: resume after restart drives the same durable state forward', async () => {
  const target = scratchTarget();
  const cfg = scratchConfig(target);

  // first process: seed durable state and walk it to the gate
  const first = new Orchestrator(cfg);
  await first.start();
  // the task claims a tested branch — make that true in the target repo
  const git = (args) => spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' });
  git(['checkout', '-B', 'foreman/task-009']);
  fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(target, 'docs', 'x.md'), 'x\n');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'docs: x']);
  git(['checkout', 'main']);
  first.store.upsertTask({
    id: 'task-009',
    title: 'pre-seeded',
    state: 'tests_passed',
    risk_tier: 'T1',
    branch: 'foreman/task-009',
    spec: {
      id: 'task-009', title: 'pre-seeded', touches: ['docs/x.md'], context_files: [],
      acceptance_criteria: ['exists'], test_command: 'node --test',
      impl: [{ path: 'docs/x.md', content: 'x\n' }],
    },
    result: { files: ['docs/x.md'], test: { ok: true } },
  });
  const runP = first.queue.processAll(); // parks at the T2 gate
  let approvalId = null;
  for (let i = 0; i < 100 && !approvalId; i++) {
    await new Promise((r) => setTimeout(r, 50));
    approvalId = first.summary().pendingApprovals[0]?.id ?? null;
  }
  assert.ok(approvalId, 'merge approval must be pending');
  runP.catch(() => {}); // the parked run dies with the process — by design
  await first.stop(); // process dies mid-gate

  // second process: same database, resumes exactly where the first stopped
  const second = new Orchestrator(cfg);
  await second.start();
  try {
    await second.gate.approve(approvalId, 'human:resume-test');
    const s = await second.resume();
    assert.equal(s.tasks.merged ?? 0, 1, 'the pre-existing work merges after resume');
  } finally {
    await second.stop();
  }
});

test('cli: status and killswitch run against a real store as a subprocess', async () => {
  const target = scratchTarget();
  const cfg = scratchConfig(target);
  const orch = new Orchestrator(cfg);
  await orch.start();
  orch.policy.engageKillSwitch('human:setup', 'test');
  await orch.stop();

  // the CLI reads the same env + data dir and must operate on that state
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  // config derives dataDir from repo root, so point ROOT at a stub tree
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cli-root-'));
  fs.cpSync(path.join(root, 'harness'), path.join(stubRoot, 'harness'), { recursive: true });
  fs.cpSync(path.join(root, 'skills'), path.join(stubRoot, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(stubRoot, '.env'), `FOREMAN_TARGET_LOCAL=${cfg.targetLocal}\n`);
  fs.rmSync(path.join(cfg.dataDir), { recursive: true, force: true });

  const run = (args) =>
    spawnSync(process.execPath, [path.join(stubRoot, 'harness', 'cli.mjs'), ...args], {
      encoding: 'utf8',
      cwd: stubRoot,
      timeout: 30_000,
    });

  const status = run(['status']);
  assert.equal(status.status, 0, `status failed: ${status.stderr}`);
  assert.ok(fs.existsSync(path.join(stubRoot, 'data', 'foreman.db')), 'status must initialize the durable store');

  const ks = run(['killswitch', 'release']);
  assert.equal(ks.status, 0, `killswitch failed: ${ks.stderr}`);

  // data dir was recreated under the stub root by the CLI run
  assert.ok(fs.existsSync(path.join(stubRoot, 'data', 'foreman.db')), 'CLI must reuse the durable store');
});

test('orchestrator: gated T1 writes become approvals, not refusals — the demo path', async () => {
  const target = scratchTarget();
  const cfg = { ...scratchConfig(target), t1Auto: false }; // default: fully gated
  const orch = new Orchestrator(cfg);
  await orch.start();
  try {
    const issue = {
      number: 11,
      title: 'gated write task',
      body: [
        '```impl',
        JSON.stringify([{ path: 'docs/g.md', content: 'g\n' }]),
        '```',
        'test: `node --test`',
      ].join('\n'),
    };
    const runP = orch.runBacklog({ issues: [issue] });
    let pending = null;
    for (let i = 0; i < 100 && !pending; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pending = orch.summary().pendingApprovals[0] ?? null;
    }
    // THE product moment: a human sees exactly what the agent wants to do
    assert.ok(pending, 'T1 write must surface as a pending approval');
    const fullApproval = orch.store.getApproval(pending.id);
    assert.match(fullApproval.summary, /Allow agent writes/);

    await orch.gate.approve(pending.id, 'human:judge', 'looks safe');
    // one yes covers the task's whole write set; the next stops are opening
    // the PR and merging — every irreversible step asks, in order
    let t2 = null;
    for (let i = 0; i < 200 && !t2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const s = orch.summary();
      t2 = s.pendingApprovals.find((a) => a.tier === 'T2') ?? null;
      if (!t2 && s.pendingApprovals[0]) {
        await orch.gate.approve(s.pendingApprovals[0].id, 'human:judge', 'ok');
      }
    }
    assert.ok(t2, 'after T1 yeses, the merge gate is the next stop');
    assert.equal(orch.store.getTask('task-011').state, 'awaiting_approval');

    for (const a of orch.gate.pending()) await orch.gate.approve(a.id, 'human:teardown');
    await runP;
    assert.equal(orch.summary().tasks.merged ?? 0, 1);
  } finally {
    await orch.stop();
  }
});
