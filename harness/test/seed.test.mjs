import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { seedDemo } from '../../scripts/seed.mjs';

function scratchConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-seed-'));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  return {
    root,
    dataDir,
    evidenceDir: path.join(dataDir, 'evidence'),
    targetLocal: path.join(dataDir, 'demo-target'),
    targetGithub: '',
    mcpCommand: '',
    mcpArgs: [],
  };
}

test('seed: creates a green demo target and a seeded backlog, idempotently', async () => {
  const cfg = scratchConfig();
  const first = await seedDemo(cfg, { quiet: true });
  assert.ok(first.issues >= 3);
  assert.ok(fs.existsSync(path.join(cfg.targetLocal, '.git')));
  // the starter suite really is green
  const check = spawnSync(process.execPath, ['--test', 'test/'], {
    cwd: cfg.targetLocal, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(check.status, 0, 'seeded starter must be green');

  // second run reuses everything — no duplicate issues
  const second = await seedDemo(cfg, { quiet: true });
  assert.equal(second.issues, first.issues);
});

test('seed: --reset wipes target, localhub AND foreman task state', async () => {
  const cfg = scratchConfig();
  await seedDemo(cfg, { quiet: true });
  // simulate prior run state that reset must clear
  fs.writeFileSync(path.join(cfg.dataDir, 'foreman.db'), 'stale');
  fs.writeFileSync(path.join(cfg.dataDir, 'localhub', 'state.json'), '{}');

  await seedDemo(cfg, { quiet: true, reset: true });
  assert.equal(fs.existsSync(path.join(cfg.dataDir, 'foreman.db')), false, 'task store must not survive reset');
  const again = await seedDemo(cfg, { quiet: true });
  assert.ok(again.issues >= 3, 'backlog reseeds cleanly after reset');
});
