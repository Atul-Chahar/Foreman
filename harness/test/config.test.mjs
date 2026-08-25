import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_DOTENV = '/nonexistent/.env'; // keep tests hermetic — never read the real .env

test('config: ROOT resolves to the repository root, not its parent', () => {
  const cfg = loadConfig({}, { dotenvFile: NO_DOTENV });
  assert.equal(cfg.root, REPO_ROOT);
  assert.equal(cfg.dataDir, path.join(REPO_ROOT, 'data'));
  assert.equal(cfg.evidenceDir, path.join(REPO_ROOT, 'evidence'));
});

test('config: defaults are fully gated and safe', () => {
  const cfg = loadConfig({}, { dotenvFile: NO_DOTENV });
  assert.equal(cfg.t1Auto, false, 'fresh clone must be fully gated');
  assert.equal(cfg.trueforgeUrl, '');
  assert.equal(cfg.mcpCommand, '', 'no MCP command by default — local-git adapter');
});

test('config: explicit env wins over defaults', () => {
  const cfg = loadConfig(
    {
      FOREMAN_T1_AUTO: 'true',
      FOREMAN_MAX_CONCURRENCY: '3',
      FOREMAN_TRUEFORGE_URL: 'http://localhost:8790',
      FOREMAN_TARGET_LOCAL: '/tmp/target',
    },
    { dotenvFile: NO_DOTENV },
  );
  assert.equal(cfg.t1Auto, true);
  assert.equal(cfg.maxConcurrency, 3);
  assert.equal(cfg.trueforgeUrl, 'http://localhost:8790');
  assert.equal(cfg.targetLocal, '/tmp/target');
});

test('config: dotenv values reach the returned config; explicit env wins', () => {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
  const dot = path.join(os.tmpdir(), `foreman-env-${Date.now()}`);
  fs.writeFileSync(dot, 'FOREMAN_MAX_CONCURRENCY=5\nFOREMAN_T1_AUTO=true\n');
  const savedConcurrency = process.env.FOREMAN_MAX_CONCURRENCY;
  const savedT1 = process.env.FOREMAN_T1_AUTO;
  try {
    const cfg = loadConfig({}, { dotenvFile: dot });
    assert.equal(cfg.maxConcurrency, 5, '.env value used when env is silent');
    assert.equal(cfg.t1Auto, true);

    const overridden = loadConfig({ FOREMAN_MAX_CONCURRENCY: '2' }, { dotenvFile: dot });
    assert.equal(overridden.maxConcurrency, 2, 'explicit env beats .env');
  } finally {
    // loadConfig exports missing keys to process.env for child processes;
    // restore them so other tests stay hermetic
    if (savedConcurrency === undefined) delete process.env.FOREMAN_MAX_CONCURRENCY;
    else process.env.FOREMAN_MAX_CONCURRENCY = savedConcurrency;
    if (savedT1 === undefined) delete process.env.FOREMAN_T1_AUTO;
    else process.env.FOREMAN_T1_AUTO = savedT1;
    fs.rmSync(dot);
  }
});

test('config: T2 is not configurable anywhere in the config surface', () => {
  const cfg = loadConfig({ FOREMAN_T2_AUTO: 'true' }, { dotenvFile: NO_DOTENV });
  assert.ok(!('t2Auto' in cfg), 'no t2Auto knob may exist');
});
