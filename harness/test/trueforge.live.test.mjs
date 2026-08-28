import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTrueForgeSmoke } from '../../scripts/tf-smoke.mjs';
import { loadConfig } from '../config.mjs';
import { GitHubMCP } from '../mcp_clients/github.mjs';
import { SandboxRunner } from '../sandbox_runner.mjs';
import { TrueForgeBackend, extractTrueForgeFiles } from '../subagents/backends.mjs';

const enabled = process.env.FOREMAN_TRUEFORGE_LIVE === 'true';
let smokePromise;
const liveSmoke = () => (smokePromise ??= runTrueForgeSmoke());

test('trueforge live: session -> turn -> terminal output', { skip: !enabled, timeout: 200_000 }, async () => {
  const result = await liveSmoke();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.sessionId);
  assert.ok(result.turnId);
  assert.deepEqual(extractTrueForgeFiles(result.output).map((file) => file.path), ['smoke.txt']);
});

test('trueforge live: output is authorized, committed, and tested on a real branch', {
  skip: !enabled,
  timeout: 200_000,
}, async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tf-live-target-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tf-live-data-'));
  const git = (...args) => spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' });
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(target, 'README.md'), '# TrueForge live target\n');
  fs.mkdirSync(path.join(target, 'test'));
  fs.writeFileSync(path.join(target, 'test', 'smoke.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "test('materialized smoke file', () => assert.match(fs.readFileSync('smoke.txt', 'utf8'), /TrueForge/));",
    '',
  ].join('\n'));
  git('add', '.');
  git('-c', 'user.name=foreman-test', '-c', 'user.email=foreman@test', 'commit', '-m', 'init');

  const config = {
    ...loadConfig(),
    dataDir,
    targetLocal: target,
    targetGithub: '',
    mcpCommand: '',
    mcpArgs: [],
    agentTimeoutMs: 180_000,
  };
  const github = new GitHubMCP({ config, audit: { record() {} } });
  const sandbox = new SandboxRunner({
    repoDir: target,
    sandboxRoot: path.join(dataDir, 'sandbox'),
    timeoutMs: 60_000,
  });
  const authorized = [];
  const backend = new TrueForgeBackend({
    config,
    github,
    sandbox,
    authorize: async (action, ctx) => {
      authorized.push([action, ctx]);
      return { allowed: true };
    },
  });

  await github.connect();
  try {
    const completed = await liveSmoke();
    const result = await backend.materializeCompletion({
      completed,
      branch: 'foreman/live-materialization',
      spec: {
        id: 'live-materialization',
        title: 'Materialize the live smoke result',
        acceptance_criteria: ['the streamed smoke file is committed and tested'],
        touches: ['smoke.txt'],
        context_files: [],
        test_command: 'node --test test/smoke.test.mjs',
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(authorized.map(([action]) => action), ['create_branch', 'commit_files']);
    assert.match(git('show', 'foreman/live-materialization:smoke.txt').stdout, /TrueForge/);
    assert.equal(result.test.exitCode, 0);
  } finally {
    await github.close();
  }
});
