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

test('store: upsertTask can never move state — only transitionTask can', () => {
  const { store } = tmpStore();
  store.upsertTask({ id: 'task-001', title: 'x', state: STATES.DISPATCHED });
  store.upsertTask({ id: 'task-001', title: 'x', state: STATES.MERGED }); // bypass attempt
  assert.equal(store.getTask('task-001').state, STATES.DISPATCHED);
  assert.throws(() => store.transitionTask('task-001', STATES.PLANNED), InvalidTransition);
  assert.equal(store.getTask('task-001').state, STATES.DISPATCHED);
  store.close();
});

test('store: every state transition writes an audit record', () => {
  const { store } = tmpStore();
  store.upsertTask({ id: 'task-001', title: 'x' });
  store.transitionTask('task-001', STATES.DISPATCHED, {}, { actor: 'system:test', reason: 'dispatching' });
  const audit = store.listAudit(10).filter((r) => r.action === 'task.transition');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, 'system:test');
  assert.match(audit[0].decision, /planned -> dispatched/);
  assert.equal(audit[0].reason, 'dispatching');
  store.close();
});

test('store: event paging advances past any window size (cursor before limit)', () => {
  const { store } = tmpStore();
  for (let i = 1; i <= 7; i++) {
    store.persistEvent({ id: `evt-${i}`, ts: new Date().toISOString(), type: `t${i}`, payload: { i } });
  }
  const page1 = store.listEvents(null, 3);
  assert.equal(page1.length, 3);
  const page2 = store.listEvents(page1.at(-1).id, 3);
  assert.equal(page2[0].id, 'evt-4');
  const rest = store.listEvents(page2.at(-1).id, 500);
  assert.deepEqual(rest.map((e) => e.id), ['evt-7']);
  // unknown cursor falls back to the beginning rather than empty
  assert.equal(store.listEvents('evt-nope', 2).length, 2);
  store.close();
});

test('store: only one winner when an approval is decided twice concurrently', () => {
  const { store } = tmpStore();
  store.createApproval({ id: 'appr-0001', taskId: 'task-001', action: 'merge_to_main', tier: 'T2', summary: 'm' });
  const first = store.decideApproval('appr-0001', { status: 'approved', decidedBy: 'human:a' });
  const second = store.decideApproval('appr-0001', { status: 'rejected', decidedBy: 'human:b' });
  assert.equal(first.status, 'approved');
  assert.equal(second, null, 'loser must not overwrite the human decision');
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

test('audit: jsonl gaps are repaired from sqlite by stable id', () => {
  const { dir, store } = tmpStore();
  const file = path.join(dir, 'audit.log');
  const log = new AuditLog(store, file);
  const e1 = log.record({ actor: 'a', action: 'x1', decision: 'd' });
  const e2 = log.record({ actor: 'b', action: 'x2', decision: 'd' });
  fs.writeFileSync(file, ''); // evidence file lost — db still authoritative
  log.syncFromDb();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), [e1.id, e2.id]);
  // idempotent: syncing again appends nothing new
  log.syncFromDb();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.ok(e2.id > e1.id, 'db ids are strictly increasing');
  store.close();
});

test('audit: task transitions land in the jsonl evidence copy too', () => {
  const { dir, store } = tmpStore();
  const file = path.join(dir, 'audit.log');
  new AuditLog(store, file); // registers the sink
  store.upsertTask({ id: 'task-001', title: 'x' });
  store.transitionTask('task-001', STATES.DISPATCHED);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.action === 'task.transition' && /planned -> dispatched/.test(l.decision)));
  store.close();
});

test('audit: torn final line triggers a full rebuild — file stays valid jsonl', () => {
  const { dir, store } = tmpStore();
  const file = path.join(dir, 'audit.log');
  const log = new AuditLog(store, file);
  log.record({ actor: 'a', action: 'x1', decision: 'd' });
  log.record({ actor: 'b', action: 'x2', decision: 'd' });
  // simulate a crash mid-append: valid line + unterminated fragment
  fs.appendFileSync(file, '{"id":99,"actor":"c"');
  log.syncFromDb();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(lines.length, 2, 'rebuild restores exactly the db rows');
  store.close();
});

test('ids: task <-> branch mapping round-trips', () => {
  assert.equal(branchForTask('task-007'), 'foreman/task-007');
  assert.equal(taskForBranch('foreman/task-007'), 'task-007');
  assert.equal(taskForBranch('main'), null);
  assert.equal(slug('Add search endpoint to /todos!!'), 'add-search-endpoint-to-t');
});
