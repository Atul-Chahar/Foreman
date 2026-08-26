import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../core/store.mjs';
import { AuditLog } from '../core/audit.mjs';
import { EventBus } from '../core/events.mjs';
import { PolicyEngine } from '../policy/engine.mjs';
import { SpendMeter } from '../core/spend.mjs';
import { Dispatcher } from '../subagents/dispatcher.mjs';
import { implementationFor } from '../subagents/backends.mjs';
import { STATES } from '../core/state.mjs';

function rig({ tasks = [], backend, capUsd = 100, maxConcurrency = 3, timeoutMs = 5000, maxRetries = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-disp-'));
  const store = new Store(path.join(dir, 't.db'));
  for (const t of tasks) store.upsertTask(t);
  const bus = new EventBus();
  const policy = new PolicyEngine({ store, audit: store.__audit ?? new AuditLog(store, path.join(dir, 'a.log')), bus });
  const spend = new SpendMeter({ capUsd, perRunUsd: 1, store, audit: new AuditLog(store, path.join(dir, 'a.log')), bus });
  const dispatcher = new Dispatcher({ store, bus, spend, policy, backend, maxConcurrency, timeoutMs, maxRetries });
  return { dir, store, bus, dispatcher };
}

const spec = (touches = [], impl = null) => ({
  id: 'task-001', title: 't', context_files: touches, touches,
  acceptance_criteria: [], test_command: 'node --test test/', risk_tier: 'T1',
  conflicts_with: [], impl, body_excerpt: '',
});

function fakeBackend(results, { latency = 20 } = {}) {
  let calls = 0;
  return {
    name: 'fake',
    calls: () => calls,
    async run({ spec: s }) {
      calls++;
      await new Promise((r) => setTimeout(r, latency));
      const r = results[Math.min(calls - 1, results.length - 1)];
      if (typeof r === 'function') return r(s);
      return r;
    },
  };
}

test('dispatcher: runs tasks and records success', async () => {
  const { dispatcher, store } = rig({
    tasks: [{ id: 'task-001', title: 'a', spec: spec() }],
    backend: fakeBackend([{ ok: true, test: { ok: true } }]),
  });
  await dispatcher.drain();
  assert.equal(store.getTask('task-001').state, STATES.TESTS_PASSED);
});

test('dispatcher: respects the concurrency cap', async () => {
  let peak = 0;
  let live = 0;
  const backend = {
    name: 'fake',
    async run() {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 60));
      live--;
      return { ok: true };
    },
  };
  const tasks = Array.from({ length: 8 }, (_, i) => ({
    id: `task-00${i + 1}`, title: `t${i}`, spec: spec([`src/f${i}.mjs`]),
  }));
  const { dispatcher, store } = rig({ tasks, backend, maxConcurrency: 3 });
  await dispatcher.drain();
  assert.ok(peak <= 3, `peak ${peak} exceeded cap 3`);
  assert.equal(store.listTasksInStates([STATES.TESTS_PASSED]).length, 8);
});

test('dispatcher: tasks touching the same file never run concurrently', async () => {
  const overlaps = [];
  const running = new Set();
  const backend = {
    name: 'fake',
    async run({ spec: s }) {
      running.add(s.id);
      for (const other of running) {
        if (other !== s.id) {
          const a = s.touches ?? [], b = tasksById[other]?.spec.touches ?? [];
          if (a.some((f) => b.includes(f))) overlaps.push([s.id, other]);
        }
      }
      await new Promise((r) => setTimeout(r, 40));
      running.delete(s.id);
      return { ok: true };
    },
  };
  const tasks = [
    { id: 'task-001', title: 'a', spec: spec(['src/shared.mjs']) },
    { id: 'task-002', title: 'b', spec: spec(['src/shared.mjs']) },
    { id: 'task-003', title: 'c', spec: spec(['src/other.mjs']) },
  ];
  const tasksById = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const { dispatcher } = rig({ tasks, backend, maxConcurrency: 3 });
  await dispatcher.drain();
  assert.deepEqual(overlaps, []);
});

test('dispatcher: hung agents are timed out, retried, then failed', async () => {
  const backend = {
    name: 'fake',
    async run() { await new Promise(() => {}); }, // hangs forever
  };
  const { dispatcher, store } = rig({
    tasks: [{ id: 'task-001', title: 'a', spec: spec() }],
    backend, timeoutMs: 80, maxRetries: 2,
  });
  await dispatcher.drain();
  const t = store.getTask('task-001');
  assert.equal(t.state, STATES.FAILED);
  assert.equal(t.attempts, 3); // initial + 2 retries
});

test('dispatcher: spend cap stops dispatch and flags needs_human', async () => {
  const backend = fakeBackend([{ ok: true }]);
  const tasks = [
    { id: 'task-001', title: 'a', spec: spec(['src/a.mjs']) },
    { id: 'task-002', title: 'b', spec: spec(['src/b.mjs']) },
    { id: 'task-003', title: 'c', spec: spec(['src/c.mjs']) },
  ];
  const { dispatcher, store } = rig({ tasks, backend, capUsd: 2 }); // 2 runs max
  await dispatcher.drain();
  const states = store.listTasks().map((t) => t.state);
  assert.ok(states.includes(STATES.TESTS_PASSED));
  assert.ok(states.includes(STATES.NEEDS_HUMAN));
  assert.ok(!states.includes(STATES.PLANNED), 'nothing may be left undecided');
});

test('dispatcher: fix agents jump the queue by priority', async () => {
  const order = [];
  const backend = {
    name: 'fake',
    async run({ taskId }) { order.push(taskId); await new Promise((r) => setTimeout(r, 10)); return { ok: true }; },
  };
  const tasks = [
    { id: 'task-001', title: 'old', spec: spec(['src/a.mjs']) },
    { id: 'task-002', title: 'old2', spec: spec(['src/b.mjs']) },
    { id: 'fix-003', title: 'fix build', priority: 10, spec: spec(['src/c.mjs']) },
  ];
  const { dispatcher } = rig({ tasks, backend, maxConcurrency: 1 });
  await dispatcher.drain();
  assert.equal(order[0], 'fix-003');
});

test('backends: impl blocks are sanitized (no traversal, no absolute paths)', () => {
  const files = implementationFor({
    impl: [
      { path: 'src/ok.mjs', content: 'x' },
      { path: '../escape.mjs', content: 'x' },
      { path: 'C:/abs.mjs', content: 'x' },
      { path: '/rooted.mjs', content: 'x' },
      { nope: true },
    ],
  });
  assert.deepEqual(files, [{ path: 'src/ok.mjs', content: 'x' }]);
});
