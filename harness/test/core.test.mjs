import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../core/store.mjs';
import { STATES, canTransition, assertTransition, InvalidTransition } from '../core/state.mjs';
import { branchForTask, taskForBranch, slug } from '../core/ids.mjs';
import { EventBus } from '../core/events.mjs';
import { AuditLog } from '../core/audit.mjs';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-test-'));
  return { dir, store: new Store(path.join(dir, 'test.db')) };
}

test('state machine: happy path backlog -> merged is legal', () => {
  const pathStates = [
    STATES.PLANNED, STATES.DISPATCHED, STATES.RUNNING, STATES.TESTS_PASSED,
    STATES.PR_OPEN, STATES.AWAITING_APPROVAL, STATES.MERGED,
  ];
  for (let i = 0; i < pathStates.length - 1; i++) {
    assert.ok(canTransition(pathStates[i], pathStates[i + 1]));
  }
});

test('state machine: no transition escapes a terminal state', () => {
  assert.equal(canTransition(STATES.MERGED, STATES.PLANNED), false);
  assert.equal(canTransition(STATES.REJECTED, STATES.DISPATCHED), false);
});

test('state machine: cannot skip running', () => {
  assert.equal(canTransition(STATES.PLANNED, STATES.PR_OPEN), false);
});

test('store: transitionTask enforces the state machine', () => {
  const { store } = tmpStore();
  store.upsertTask({ id: 'task-001', title: 'add search' });
  assert.throws(() => store.transitionTask('task-001', STATES.MERGED), InvalidTransition);
  store.transitionTask('task-001', STATES.DISPATCHED);
  assert.equal(store.getTask('task-001').state, STATES.DISPATCHED);
  store.close();
});

test('store: upsertTask is idempotent on task id', () => {
  const { store } = tmpStore();
  store.upsertTask({ id: 'task-001', title: 'add search', spec: { a: 1 } });
  store.upsertTask({ id: 'task-001', title: 'add search' }); // re-run of dispatch
  const all = store.listTasks();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].spec, { a: 1 });
  store.close();
});

test('store: approvals persist across restart (session durability)', () => {
  const { dir, store } = tmpStore();
  store.createApproval({ id: 'appr-0001', taskId: 'task-001', action: 'merge_to_main', tier: 'T2', summary: 'merge task-001' });
  store.close();

  const reopened = new Store(path.join(dir, 'test.db'));
  const pending = reopened.listApprovals('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].action, 'merge_to_main');
  reopened.close();
});

test('store: events replay in order with afterId catch-up', () => {
  const { store } = tmpStore();
  const bus = new EventBus();
  bus.emitEvent('run.started', { n: 1 }, (e) => store.persistEvent(e));
  bus.emitEvent('task.running', { id: 'task-001' }, (e) => store.persistEvent(e));
  bus.emitEvent('task.pr_open', { id: 'task-001' }, (e) => store.persistEvent(e));
  const [a, b, c] = store.listEvents();
  assert.equal(a.type, 'run.started');
  const after = store.listEvents(b.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].type, c.type);
  store.close();
});

test('audit: decisions land in sqlite and the JSONL file', () => {
  const { dir, store } = tmpStore();
  const log = new AuditLog(store, path.join(dir, 'audit.log'));
  log.record({ actor: 'human:alice', tier: 'T2', action: 'merge_to_main', decision: 'approved', reason: 'looks good' });
  log.record({ actor: 'policy:T1', tier: 'T1', action: 'open_pr', decision: 'auto-approved' });
  const fileLines = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n');
  assert.equal(fileLines.length, 2);
  assert.equal(JSON.parse(fileLines[0]).action, 'merge_to_main');
  assert.equal(log.rows(10).length, 2);
  store.close();
});

test('ids: task <-> branch mapping round-trips', () => {
  assert.equal(branchForTask('task-007'), 'foreman/task-007');
  assert.equal(taskForBranch('foreman/task-007'), 'task-007');
  assert.equal(taskForBranch('main'), null);
  assert.equal(slug('Add search endpoint to /todos!!'), 'add-search-endpoint-to-t');
});
