import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceSpec, Planner } from '../planner/spec_enhancer.mjs';
import { EventBus } from '../core/events.mjs';

const ISSUE = {
  number: 7,
  title: 'Add search endpoint to /todos',
  body: [
    'Users need to filter their todo list.',
    '',
    'Touches `src/routes/todos.mjs` and `src/db/schema.mjs`.',
    '',
    'acceptance:',
    '- GET /todos?q= returns filtered results',
    '- empty q returns all todos',
    '',
    'test: `node --test test/todos.test.mjs`',
  ].join('\n'),
};

test('enhance: extracts context files, criteria, test command, tier', () => {
  const spec = enhanceSpec(ISSUE, { taskId: 'task-007' });
  assert.deepEqual(spec.context_files, ['src/routes/todos.mjs', 'src/db/schema.mjs', 'test/todos.test.mjs']);
  assert.deepEqual(spec.acceptance_criteria, [
    'GET /todos?q= returns filtered results',
    'empty q returns all todos',
  ]);
  assert.equal(spec.test_command, 'node --test test/todos.test.mjs');
  assert.deepEqual(spec.touches, ['src/routes/todos.mjs', 'src/db/schema.mjs']);
  assert.equal(spec.risk_tier, 'T1');
});

test('enhance: destructive language escalates the risk tier', () => {
  const spec = enhanceSpec(
    { number: 9, title: 'Drop legacy table', body: 'delete the old table in src/db/schema.mjs' },
    { taskId: 'task-009' },
  );
  assert.equal(spec.risk_tier, 'T2');
});

test('enhance: bare issues still produce a valid spec', () => {
  const spec = enhanceSpec({ number: 2, title: 'add favicon', body: '' }, { taskId: 'task-002' });
  assert.deepEqual(spec.context_files, []);
  assert.deepEqual(spec.acceptance_criteria, []);
  assert.equal(spec.test_command, null);
  assert.equal(spec.risk_tier, 'T1');
});

test('planner: conflict graph — same file means mutual conflict', () => {
  const planner = new Planner({ bus: new EventBus(), persist: () => {} });
  const specs = planner.plan([
    ISSUE,
    { number: 3, title: 'Pagination', body: 'touches src/routes/todos.mjs\n- page param' },
    { number: 4, title: 'Health check', body: 'adds src/routes/health.mjs' },
  ]);
  const byId = Object.fromEntries(specs.map((s) => [s.id, s]));
  assert.ok(byId['task-007'].conflicts_with.includes('task-003'));
  assert.ok(byId['task-003'].conflicts_with.includes('task-007'));
  assert.deepEqual(byId['task-004'].conflicts_with, []);
});

test('planner: emits one spec_ready event per issue', () => {
  const bus = new EventBus();
  const seen = [];
  bus.onAny((e) => { if (e.type === 'planner.spec_ready') seen.push(e.payload.taskId); });
  const planner = new Planner({ bus, persist: () => {} });
  planner.plan([ISSUE, { number: 4, title: 'x', body: '' }]);
  assert.deepEqual(seen.sort(), ['task-004', 'task-007']);
});
