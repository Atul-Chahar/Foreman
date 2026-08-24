import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from '../core/store.mjs';
import { AuditLog } from '../core/audit.mjs';
import { EventBus } from '../core/events.mjs';
import { PolicyEngine } from '../policy/engine.mjs';
import { ApprovalGate } from '../gate/approval_gate.mjs';
import { SandboxRunner } from '../sandbox_runner.mjs';
import { LocalGitMCP } from '../mcp_clients/local_git.mjs';
import { GitHubMCP } from '../mcp_clients/github.mjs';
import { MergeQueue } from '../merge_queue.mjs';
import { STATES } from '../core/state.mjs';

function scratchTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-mq-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","type":"module"}');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'a.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict";\nimport { add } from "../src/a.mjs";\ntest("add", () => assert.equal(add(1, 2), 3));\n');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  return { dir, git };
}

function rig(t1Auto = false) {
  const target = scratchTarget();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-mqdb-'));
  const store = new Store(path.join(dbDir, 't.db'));
  const bus = new EventBus();
  const audit = new AuditLog(store, path.join(dbDir, 'audit.log'));
  const policy = new PolicyEngine({ t1Auto, store, audit, bus });
  const gate = new ApprovalGate({ store, audit, bus, policy });
  const github = new GitHubMCP({
    config: { mcpCommand: '', mcpArgs: [], targetLocal: target.dir, dataDir: dbDir, targetGithub: '' },
    audit,
  });
  const sandbox = new SandboxRunner({
    repoDir: target.dir,
    sandboxRoot: path.join(dbDir, 'sbx'),
    timeoutMs: 30_000,
  });
  const queue = new MergeQueue({ store, bus, gate, github, sandbox });
  return { target, store, bus, gate, github, queue, audit };
}

function makeTaskBranch(target, id, implPath, implContent, testCommand = 'node --test test/*.test.mjs') {
  const { git, dir } = target;
  git(['checkout', '-b', `foreman/${id}`]);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, implPath), implContent);
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', id]);
  git(['checkout', 'main']);
  return {
    id,
    title: `task ${id}`,
    state: STATES.TESTS_PASSED,
    branch: `foreman/${id}`,
    spec: { id, issue_number: 1, test_command: testCommand, touches: [implPath], acceptance_criteria: ['it works'] },
    result: { test: { ok: true, exitCode: 0 }, files: [implPath] },
  };
}

test('merge queue: PR opens, merge waits at the T2 gate, human approves, merge lands', async () => {
  const r = rig(true);
  // agent already produced a passing branch
  r.target.git(['checkout', '-b', 'foreman/task-001']);
  fs.mkdirSync(path.join(r.target.dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r.target.dir, 'src', 'a.mjs'), 'export const add = (a, b) => a + b;\n');
  r.target.git(['add', '.']);
  r.target.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'a']);
  r.target.git(['checkout', 'main']);

  r.store.upsertTask({
    id: 'task-001', title: 'add module', state: STATES.TESTS_PASSED, branch: 'foreman/task-001',
    spec: { id: 'task-001', issue_number: 1, test_command: 'node --test test/*.test.mjs', touches: ['src/a.mjs'], acceptance_criteria: [] },
    result: { test: { ok: true, exitCode: 0, stdout: 'ok' }, files: ['src/a.mjs'] },
  });

  const processing = r.queue.processAll();
  await sleep(150);
  // merge is T2: must be waiting for a human now
  const pending = r.gate.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'merge_to_main');
  assert.equal(r.store.getTask('task-001').state, STATES.AWAITING_APPROVAL);

  await r.gate.approve(pending[0].id, 'human:alice', 'lgtm');
  await processing;

  const task = r.store.getTask('task-001');
  assert.equal(task.state, STATES.MERGED);
  // really on main
  const onMain = spawnSync('git', ['-C', r.target.dir, 'show', 'main:src/a.mjs'], { encoding: 'utf8' });
  assert.match(onMain.stdout, /add/);
});

test('merge queue: rejection at the gate is final and recorded', async () => {
  const r = rig(true);
  r.store.upsertTask(makeTaskBranch(r.target, 'task-002', 'src/b.mjs', 'export const b = 1;\n'));
  const processing = r.queue.processAll();
  await sleep(120);
  const [a] = r.gate.pending();
  await r.gate.reject(a.id, 'human:bob', 'wrong approach');
  await processing;
  assert.equal(r.store.getTask('task-002').state, STATES.REJECTED);
  assert.ok(r.audit.rows(20).some((x) => x.decision === 'rejected'));
});

test('merge queue: post-rebase test failure blocks the merge, flags needs_human', async () => {
  const r = rig(true);
  // task-003 branch passes ALONE, but main gains a change after approval
  // that breaks it (test asserts add(1,2)=3; main changes semantics)
  r.store.upsertTask(makeTaskBranch(r.target, 'task-003', 'src/a.mjs', 'export const add = (a, b) => a + b;\n'));

  const processing = r.queue.processAll();
  await sleep(120);
  const [a] = r.gate.pending();

  // meanwhile, another PR lands on main and breaks task-003's world
  r.target.git(['checkout', 'main']);
  fs.writeFileSync(path.join(r.target.dir, 'test', 'a.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict";\nimport { add } from "../src/a.mjs";\ntest("add", () => assert.equal(add(1, 2), 4));\n');
  r.target.git(['add', '.']);
  r.target.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'evil semantics change']);
  r.target.git(['checkout', 'main']);

  await r.gate.approve(a.id, 'human:alice');
  await processing;

  const task = r.store.getTask('task-003');
  assert.equal(task.state, STATES.NEEDS_HUMAN);
  assert.match(task.result.merge_block, /post-rebase tests failed/);
});

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
