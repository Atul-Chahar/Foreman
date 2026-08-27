import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

test('cli demo stays alive while a human approval is pending', { timeout: 15_000 }, async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cli-demo-'));
  fs.cpSync(path.join(root, 'harness'), path.join(stubRoot, 'harness'), { recursive: true });
  fs.cpSync(path.join(root, 'scripts'), path.join(stubRoot, 'scripts'), { recursive: true });
  fs.cpSync(path.join(root, 'skills'), path.join(stubRoot, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(stubRoot, '.env'), [
    `FOREMAN_TARGET_LOCAL=${path.join(stubRoot, 'demo-target')}`,
    'FOREMAN_T1_AUTO=false',
    'FOREMAN_MAX_CONCURRENCY=2',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, [path.join(stubRoot, 'harness', 'cli.mjs'), 'demo'], {
    cwd: stubRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    const deadline = Date.now() + 8_000;
    const db = path.join(stubRoot, 'data', 'foreman.db');
    while (!fs.existsSync(db) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(db), `demo never initialized its durable store:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(child.exitCode, null, `demo exited while approval work was pending:\n${output}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
});
