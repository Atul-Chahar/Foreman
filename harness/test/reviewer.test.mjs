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
import { GitHubMCP } from '../mcp_clients/github.mjs';
import { MergeQueue } from '../merge_queue.mjs';
import { ReviewStage, parseChangedFiles, addedLines, scanAddedLines } from '../reviewer.mjs';
import { STATES } from '../core/state.mjs';

function scratchTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rev-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","type":"module"}');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'health.mjs'), 'export const health = () => 1;\n');
  fs.writeFileSync(path.join(dir, 'test', 'health.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict";\nimport { health } from "../src/health.mjs";\ntest("healthy", () => assert.equal(health(), 1));\n');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  return { dir, git };
}

function makeBranch({ git, dir }, id, files, message = id) {
  git(['checkout', '-b', `foreman/${id}`]);
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(path.dirname(path.join(dir, p))), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message]);
  git(['checkout', 'main']);
}

function rig() {
  const target = scratchTarget();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-revdb-'));
  const store = new Store(path.join(dbDir, 't.db'));
  const bus = new EventBus();
  const audit = new AuditLog(store, path.join(dbDir, 'a.log'));
  const github = new GitHubMCP({
    config: { mcpCommand: '', mcpArgs: [], targetLocal: target.dir, dataDir: dbDir, targetGithub: '' },
    audit,
  });
  const reviewer = new ReviewStage({ github, bus, persist: (e) => store.persistEvent(e) });
  const policy = new PolicyEngine({ t1Auto: true, store, audit, bus });
  const gate = new ApprovalGate({ store, audit, bus, policy });
  const sandbox = new SandboxRunner({ repoDir: target.dir, sandboxRoot: path.join(dbDir, 'sbx'), timeoutMs: 20_000 });
  const queue = new MergeQueue({ store, bus, gate, github, sandbox, reviewer });
  return { target, dbDir, store, bus, gate, reviewer, queue, github };
}

const FAKE_TOKEN = 'ghp_' + 'FAKEFAKEFAKEFAKEFAKEFAKE1234';

function taskFor(id, touches) {
  return {
    id, title: `task ${id}`, state: STATES.TESTS_PASSED, branch: `foreman/${id}`,
    spec: { id, issue_number: 1, test_command: 'node --test test/health.test.mjs', touches, acceptance_criteria: [] },
    result: { test: { ok: true, exitCode: 0 }, files: touches },
  };
}

test('reviewer: clean in-scope change with a test passes', async () => {
  const r = rig();
  makeBranch(r.target, 'task-clean', { 'src/feature.mjs': 'export const f = 1;\n', 'test/feature.test.mjs': 'import test from "node:test"; test("f", () => {});\n' });
  const review = await r.reviewer.run({ task: { ...taskFor('task-clean', ['src/feature.mjs', 'test/feature.test.mjs']), branch: 'foreman/task-clean' } });
  assert.equal(review.ok, true);
  assert.deepEqual(review.findings.filter((f) => f.severity === 'blocking'), []);
});

test('reviewer: hardcoded secrets block', async () => {
  const r = rig();
  makeBranch(r.target, 'task-secret', { 'src/tokens.mjs': `export const TOKEN = "${FAKE_TOKEN}";\n` });
  const review = await r.reviewer.run({ task: { ...taskFor('task-secret', ['src/tokens.mjs']), branch: 'foreman/task-secret' } });
  assert.equal(review.ok, false);
  assert.ok(review.findings.some((f) => f.rule === 'hardcoded-secret'));
});

test('reviewer: eval and injected commands block', async () => {
  const r = rig();
  makeBranch(r.target, 'task-eval', { 'src/evil.mjs': 'export const run = (s) => eval(s);\n' });
  let review = await r.reviewer.run({ task: { ...taskFor('task-eval', ['src/evil.mjs']), branch: 'foreman/task-eval' } });
  assert.ok(!review.ok && review.findings.some((f) => f.rule === 'dynamic-execution'));

  makeBranch(r.target, 'task-inj', { 'src/shell.mjs': `import { execSync } from "node:child_process";\nexport const clean = (name) => execSync(\`rm \${name}\`);\n` });
  review = await r.reviewer.run({ task: { ...taskFor('task-inj', ['src/shell.mjs']), branch: 'foreman/task-inj' } });
  assert.ok(!review.ok && review.findings.some((f) => f.rule === 'command-injection'));
});

test('reviewer: modifying an out-of-scope file blocks; adding one warns', async () => {
  const r = rig();
  // modify a file NOT in touches
  makeBranch(r.target, 'task-oos', { 'src/health.mjs': 'export const health = () => 2;\n' });
  let review = await r.reviewer.run({ task: { ...taskFor('task-oos', ['src/other.mjs']), branch: 'foreman/task-oos' } });
  assert.ok(!review.ok && review.findings.some((f) => f.rule === 'scope-violation'));

  // brand-new file not in touches: warning only
  makeBranch(r.target, 'task-newfile', { 'src/brandnew.mjs': 'export const n = 1;\n' });
  review = await r.reviewer.run({ task: { ...taskFor('task-newfile', ['src/declared.mjs']), branch: 'foreman/task-newfile' } });
  const newFile = review.findings.find((f) => f.rule === 'new-file-outside-scope');
  assert.ok(newFile, 'new file outside scope should be flagged');
  assert.equal(newFile.severity, 'warning');
  assert.equal(review.ok, true, 'warnings never block');
});

test('merge queue: blocking review stops the PR and flags needs_human', async () => {
  const r = rig();
  makeBranch(r.target, 'task-block', { 'src/leak.mjs': `export const K = "${FAKE_TOKEN}";\n` });
  r.store.upsertTask(taskFor('task-block', ['src/leak.mjs']));

  await r.queue.processAll();

  const task = r.store.getTask('task-block');
  assert.equal(task.state, STATES.NEEDS_HUMAN);
  assert.equal(task.result.review.ok, false);
  assert.equal(r.store.listApprovals().length, 0, 'no PR, no approvals for a blocked task');
});

test('merge queue: passing review attaches findings to the T2 approval detail', async () => {
  const r = rig();
  makeBranch(r.target, 'task-pass', {
    'src/routes/todos.mjs': 'export const search = () => [];\n',
    'test/todos.test.mjs': 'import test from "node:test"; test("search", () => {});\n',
  });
  r.store.upsertTask(taskFor('task-pass', ['src/routes/todos.mjs', 'test/todos.test.mjs']));

  const processing = r.queue.processAll();
  await new Promise((res) => setTimeout(res, 150));
  const pending = r.gate.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'merge_to_main');
  assert.ok(pending[0].detail.review, 'review must ride along with diff and tests');
  assert.equal(pending[0].detail.review.ok, true);
  assert.equal(r.store.getTask('task-pass').state, STATES.AWAITING_APPROVAL);
  r.gate.cancel(pending[0].id);
  await processing;
});

test('reviewer: a crash fails closed — blocking, never a silent pass', async () => {
  const r = rig();
  makeBranch(r.target, 'task-crash', { 'src/fine.mjs': 'export const ok = true;\n' });
  r.github.getBranchDiff = async () => { throw new Error('diff backend down'); };
  const review = await r.reviewer.run({ task: { ...taskFor('task-crash', ['src/fine.mjs']), branch: 'foreman/task-crash' } });
  assert.equal(review.ok, false, 'an unreviewable branch must not pass review');
  assert.equal(review.degraded, true);
  assert.ok(review.findings.some((f) => f.rule === 'review-crashed' && f.severity === 'blocking'));
});

test('diff parsing: statuses and added lines extract correctly', () => {
  const diff = [
    'diff --git a/src/a.mjs b/src/a.mjs',
    'index 111..222 100644',
    '--- a/src/a.mjs',
    '+++ b/src/a.mjs',
    '@@ -1,2 +1,3 @@',
    ' const old = 1;',
    '+const added = 2;',
    'diff --git a/src/new.mjs b/src/new.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.mjs',
    '@@ -0,0 +1 @@',
    '+export const n = 1;',
  ].join('\n');
  const changed = parseChangedFiles(diff);
  assert.deepEqual(changed.map((c) => [c.path, c.status]), [
    ['src/a.mjs', 'modified'],
    ['src/new.mjs', 'added'],
  ]);
  const added = addedLines(diff);
  assert.deepEqual(added.get('src/a.mjs'), [{ n: 2, text: 'const added = 2;' }]);
  assert.deepEqual(added.get('src/new.mjs'), [{ n: 1, text: 'export const n = 1;' }]);
});

test('diff parsing: quoted headers and remote synthesized diffs classify correctly', () => {
  // remote backends (GitHub compare API) emit no "new file mode" marker
  const remoteDiff = [
    'diff --git "a/src/with space.mjs" "b/src/with space.mjs"',
    '--- /dev/null',
    '+++ b/src/with space.mjs',
    '@@ -0,0 +1,2 @@',
    '+export const q = 1;',
    '+export const w = 2;',
  ].join('\n');
  const changed = parseChangedFiles(remoteDiff);
  assert.deepEqual(changed.map((c) => [c.path, c.status]), [
    ['src/with space.mjs', 'added'],
  ]);
  const lines = addedLines(remoteDiff).get('src/with space.mjs');
  assert.deepEqual(lines.map((l) => l.n), [1, 2], 'new-file line numbers come from the hunk header');
});

test('reviewer: command-injection heuristic ignores static concatenation but flags interpolation', () => {
  const diff = [
    'diff --git a/src/run.mjs b/src/run.mjs',
    '--- a/src/run.mjs',
    '+++ b/src/run.mjs',
    '@@ -1,2 +1,4 @@',
    "+exec('git ' + subcommand);", // static concat: NOT flagged
    '+const cmd = build();', // no exec: NOT flagged
    '+exec(`ls ${userPath}`);', // interpolation into exec: flagged
  ].join('\n');
  const findings = scanAddedLines('src/run.mjs', addedLines(diff).get('src/run.mjs'));
  assert.deepEqual(findings.map((f) => f.line), [3], 'interpolation into exec flags; static concat does not');
});

