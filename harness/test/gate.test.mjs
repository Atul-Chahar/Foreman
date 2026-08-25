import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../core/store.mjs';
import { AuditLog } from '../core/audit.mjs';
import { EventBus } from '../core/events.mjs';
import { PolicyEngine } from '../policy/engine.mjs';
import { ApprovalGate } from '../gate/approval_gate.mjs';
import { STATES } from '../core/state.mjs';

function rig({ t1Auto = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-'));
  const store = new Store(path.join(dir, 't.db'));
  store.upsertTask({ id: 'task-007', title: 'add search' });
  const bus = new EventBus();
  const gate = new ApprovalGate({
    store,
    audit: new AuditLog(store, path.join(dir, 'audit.log')),
    bus,
    policy: new PolicyEngine({ t1Auto, store, audit: new AuditLog(store, path.join(dir, 'audit.log')), bus }),
  });
  return { dir, store, bus, gate };
}

test('gate: T2 merge creates a pending approval and waits', async () => {
  const { gate, store } = rig();
  const waiting = gate.request({
    taskId: 'task-007', action: 'merge_to_main',
    summary: 'Merge foreman/task-007 into main', detail: { diff: '+10 -2' },
  });
  await sleep(50);
  assert.equal(gate.pending().length, 1);
  const a = gate.pending()[0];
  assert.equal(a.tier, 'T2');
  assert.equal(a.action, 'merge_to_main');

  await gate.approve(a.id, 'human:alice', 'tests pass');
  const outcome = await waiting;
  assert.equal(outcome.outcome, 'approved');
  assert.equal(outcome.auto, false);
  assert.equal(store.listAudit(5)[0].actor, 'human:alice');
  store.close();
});

test('gate: reject is final and audited', async () => {
  const { gate, store } = rig();
  const waiting = gate.request({ taskId: 'task-007', action: 'merge_to_main', summary: 'merge' });
  await sleep(50);
  const [a] = gate.pending();
  await gate.reject(a.id, 'human:bob', 'wrong file');
  assert.equal((await waiting).outcome, 'rejected');
  const audit = store.listAudit(5);
  assert.ok(audit.some((x) => x.decision === 'rejected' && x.reason === 'wrong file'));
  store.close();
});

test('gate: T0 reads pass straight through, visibly', async () => {
  const { gate, bus } = rig();
  const seen = [];
  bus.onAny((e) => seen.push(e));
  const out = await gate.request({ taskId: 'task-007', action: 'read_issue', summary: 'read #12' });
  assert.equal(out.outcome, 'auto');
  assert.equal(out.auto, true);
  assert.ok(seen.some((e) => e.type === 'approval.auto'), 'auto-approval must be a visible event');
});

test('gate: T1 with opt-in auto-approves; default stops', async () => {
  const gated = rig();
  const w1 = gated.gate.request({ taskId: 'task-007', action: 'open_pr', summary: 'pr' });
  await sleep(50);
  assert.equal(gated.gate.pending().length, 1);
  gated.gate.cancel(gated.gate.pending()[0].id);

  const fast = rig({ t1Auto: true });
  const out = await fast.gate.request({ taskId: 'task-007', action: 'open_pr', summary: 'pr' });
  assert.equal(out.outcome, 'auto');
});

test('gate: a pending approval survives a full restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-2'));
  const mk = () => {
    const store = new Store(path.join(dir, 't.db'));
    store.upsertTask({ id: 'task-007', title: 'x', state: STATES.AWAITING_APPROVAL });
    const bus = new EventBus();
    return {
      store, bus,
      gate: new ApprovalGate({
        store, bus,
        audit: new AuditLog(store, path.join(dir, 'a.log')),
        policy: new PolicyEngine({ store, audit: new AuditLog(store, path.join(dir, 'a.log')), bus }),
      }),
    };
  };

  const first = mk();
  const waiting = first.gate
    .request({ taskId: 'task-007', action: 'merge_to_main', summary: 'merge' })
    .catch(() => 'waiter-died-with-process'); // the old process is gone
  await sleep(50);
  const id = first.gate.pending()[0].id;
  first.store.close(); // process dies mid-wait

  const second = mk(); // fresh process, same database
  assert.equal(second.gate.pending().length, 1, 'approval must still be waiting');
  assert.equal(second.gate.pending()[0].id, id);

  // the resumed flow waits on the SAME approval and completes
  const resumed = second.gate.waitFor(id);
  await second.gate.approve(id, 'human:after-restart');
  assert.equal(await resumed, 'approved');
  assert.equal(await waiting, 'waiter-died-with-process');
  second.store.close();
});

test('gate: double-decide is refused', async () => {
  const { gate } = rig();
  const w = gate.request({ taskId: 'task-007', action: 'merge_to_main', summary: 'm' });
  await sleep(50);
  const [a] = gate.pending();
  await gate.approve(a.id);
  await assert.rejects(() => gate.approve(a.id));
  await w;
});

test('gate: under the kill switch, decisions are recorded but nothing executes', async () => {
  const { gate } = rig();
  const { policy } = gate;
  const w = gate.request({ taskId: 'task-007', action: 'merge_to_main', summary: 'm' });
  await sleep(50);
  const [a] = gate.pending();

  policy.engageKillSwitch('human:op', 'incident');
  // NEW gated work is refused outright while frozen
  await assert.rejects(
    () => gate.request({ taskId: 'task-007', action: 'merge_to_main', summary: 'm2' }),
    (e) => e.name === 'PolicyViolation',
  );
  // the human's decision on EXISTING work is still recordable...
  await gate.approve(a.id, 'human:alice');
  // ...but execution holds until the switch is released
  let settled = false;
  void w.then(() => { settled = true; });
  await sleep(80);
  assert.equal(settled, false, 'approved work must not execute while frozen');

  policy.releaseKillSwitch('human:op');
  assert.equal((await w).outcome, 'approved', 'work resumes once released');
});

test('gate: an approval granted during the kill switch executes after release', async () => {
  const { gate } = rig();
  const { policy } = gate;
  const w = gate.request({ taskId: 'task-007', action: 'merge_to_main', summary: 'm' });
  await sleep(50);
  const [a] = gate.pending();

  policy.engageKillSwitch('human:op', 'incident');
  await gate.approve(a.id, 'human:alice'); // decision recorded...
  await sleep(80);
  assert.equal(gate.pending().length, 0);
  let settled = false;
  void w.then(() => { settled = true; });
  await sleep(80);
  assert.equal(settled, false, 'execution holds while frozen');

  policy.releaseKillSwitch('human:op');
  assert.equal((await w).outcome, 'approved', 'held approval resumes once released');
});

test('gate: cancellation is audited and surfaces as cancelled — not rejected', async () => {
  const { gate, store } = rig();
  const w = gate.request({ taskId: 'task-007', action: 'open_pr', summary: 'pr' });
  await sleep(50);
  const [a] = gate.pending();
  gate.cancel(a.id, 'superseded by task-008');
  const outcome = await w;
  assert.equal(outcome.outcome, 'cancelled');
  const audit = store.listAudit(10);
  assert.ok(audit.some((x) => x.decision === 'cancelled' && x.reason === 'superseded by task-008'));
  store.close();
});

test('gate: approval ids never collide across harness restarts or instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gate-seq-'));
  const mkGate = () => {
    const store = new Store(path.join(dir, 't.db'));
    const bus = new EventBus();
    return new ApprovalGate({
      store, bus,
      audit: new AuditLog(store, path.join(dir, 'a.log')),
      policy: new PolicyEngine({ store, audit: new AuditLog(store, path.join(dir, 'a.log')), bus }),
    });
  };
  const seen = new Set();
  for (let round = 0; round < 3; round++) {
    const gate = mkGate(); // fresh instance each round, same database
    for (let n = 0; n < 3; n++) {
      gate.store.createApproval({
        id: `appr-${String(gate._nextSeq()).padStart(4, '0')}`,
        taskId: 't', action: 'read_issue', tier: 'T2', summary: 'x',
      });
    }
    for (const a of gate.pending()) {
      assert.ok(!seen.has(a.id), `duplicate approval id ${a.id}`);
      seen.add(a.id);
      gate.cancel(a.id);
    }
  }
  assert.equal(seen.size, 9);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
