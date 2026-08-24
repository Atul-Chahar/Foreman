import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from '../core/store.mjs';
import { AuditLog } from '../core/audit.mjs';
import { EventBus } from '../core/events.mjs';
import { SandboxRunner } from '../sandbox_runner.mjs';
import { Reconciler } from '../reconciler.mjs';
import { STATES } from '../core/state.mjs';

function targetRepo({ broken = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rec-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","type":"module"}');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test', 'main.test.mjs'),
    `import test from "node:test"; import assert from "node:assert/strict";\nimport { health } from "../src/health.mjs";\ntest("healthy", () => assert.equal(health(), ${broken ? 0 : 1}));\n`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'health.mjs'), 'export const health = () => 1;\n');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  return { dir, git };
}

function rig({ broken } = {}) {
  const target = targetRepo({ broken });
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-recdb-'));
  const store = new Store(path.join(dbDir, 't.db'));
  const bus = new EventBus();
  const audit = new AuditLog(store, path.join(dbDir, 'a.log'));
  const sandbox = new SandboxRunner({ repoDir: target.dir, sandboxRoot: path.join(dbDir, 'sbx'), timeoutMs: 20_000 });
  const reconciler = new Reconciler({ store, bus, audit, sandbox });
  return { target, store, bus, reconciler };
}

test('reconciler: green main reports healthy, no fix spawned', async () => {
  const r = rig();
  const res = await r.reconciler.reconcile();
  assert.equal(res.ok, true);
  assert.equal(r.store.listTasks().length, 0);
});

test('reconciler: broken main spawns a priority fix task with failure context', async () => {
  const r = rig({ broken: true });
  r.store.upsertTask({
    id: 'task-005', title: 'broke it', state: STATES.MERGED, branch: 'foreman/task-005',
    spec: { id: 'task-005', touches: ['src/health.mjs'], test_command: 'x' }, result: {},
  });
  const events = [];
  r.bus.onAny((e) => events.push(e.type));

  const res = await r.reconciler.reconcile();
  assert.equal(res.ok, false);
  assert.equal(res.fixTaskId, 'fix-task-005');

  const fix = r.store.getTask('fix-task-005');
  assert.equal(fix.kind, 'fix');
  assert.equal(fix.priority, 10);
  assert.equal(fix.state, STATES.PLANNED);
  assert.match(fix.spec.failure_output, /healthy|AssertionError|fail/);
  assert.ok(events.includes('reconciler.main_broken'));
  assert.ok(events.includes('reconciler.fix_dispatched'));
});

test('reconciler: bulkhead — max 2 fix attempts, then escalate to human', async () => {
  const r = rig({ broken: true });
  r.store.upsertTask({
    id: 'task-005', title: 'broke it', state: STATES.MERGED, branch: 'foreman/task-005',
    spec: { id: 'task-005', touches: ['src/health.mjs'] }, result: {},
  });

  await r.reconciler.reconcile(); // creates fix-task-005 (attempt 0)
  const fix = r.store.getTask('fix-task-005');

  // two failed fix rounds
  fix.attempts = 2;
  r.store.upsertTask({ ...fix, state: STATES.FAILED });
  const res = await r.reconciler.reconcile();
  assert.equal(res.fixTaskId, 'fix-task-005');
  assert.equal(r.store.getTask('fix-task-005').state, STATES.NEEDS_HUMAN);
});
