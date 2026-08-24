import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../core/store.mjs';
import { AuditLog } from '../core/audit.mjs';
import { EventBus } from '../core/events.mjs';
import { PolicyEngine, PolicyViolation } from '../policy/engine.mjs';
import { classify, TIERS, T2_AUTO_APPROVABLE, AUTO_APPROVABLE_TIERS } from '../policy/tiers.mjs';

function rig({ t1Auto = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-policy-'));
  const store = new Store(path.join(dir, 't.db'));
  return {
    dir,
    store,
    engine: new PolicyEngine({
      t1Auto,
      store,
      audit: new AuditLog(store, path.join(dir, 'audit.log')),
      bus: new EventBus(),
    }),
  };
}

test('tiers: read-only actions are T0, writes T1, irreversible T2', () => {
  assert.equal(classify('read_issue'), TIERS.T0);
  assert.equal(classify('open_pr'), TIERS.T1);
  assert.equal(classify('merge_to_main'), TIERS.T2);
  assert.equal(classify('force_push'), TIERS.T2);
});

test('tiers: unknown actions are unclassified (fail closed)', () => {
  assert.equal(classify('delete_main'), null);
});

test('policy: THE test — T2 can never be auto-approved, under any configuration', () => {
  assert.equal(T2_AUTO_APPROVABLE, false);
  assert.ok(!AUTO_APPROVABLE_TIERS.has(TIERS.T2));

  // Even with every opt-in enabled, T2 still gates:
  const { engine } = rig({ t1Auto: true });
  const d = engine.decide('merge_to_main', { task: 'task-007' });
  assert.equal(d.decision, 'gate');
  assert.equal(d.tier, TIERS.T2);
});

test('policy: fresh default is fully gated — T1 stops too', () => {
  const { engine } = rig();
  assert.equal(engine.decide('open_pr').decision, 'gate');
  assert.equal(engine.decide('push_branch').decision, 'gate');
});

test('policy: T0 read-only is always auto', () => {
  const { engine } = rig();
  assert.equal(engine.decide('read_issue').decision, 'auto');
});

test('policy: human can opt into T1 auto, and it is audited', () => {
  const { engine, store } = rig();
  engine.setT1Auto(true, 'human:demo');
  assert.equal(engine.decide('open_pr').decision, 'auto');
  const audit = store.listAudit(10);
  assert.ok(audit.some((a) => a.decision === 'policy-updated' && a.actor === 'human:demo'));

  // and can be turned back off
  engine.setT1Auto(false, 'human:demo');
  assert.equal(engine.decide('open_pr').decision, 'gate');
});

test('policy: T1 preference survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-policy-2'));
  const store = new Store(path.join(dir, 't.db'));
  const e1 = new PolicyEngine({ t1Auto: true, store, audit: new AuditLog(store, path.join(dir, 'a.log')), bus: new EventBus() });
  e1.setT1Auto(true, 'human:demo');
  store.close();

  const store2 = new Store(path.join(dir, 't.db'));
  const e2 = new PolicyEngine({ t1Auto: false, store: store2, audit: new AuditLog(store2, path.join(dir, 'a.log')), bus: new EventBus() });
  assert.equal(e2.t1Auto, true, 'persisted T1 choice must win over the default');
});

test('policy: unclassified actions are blocked, not guessed', () => {
  const { engine } = rig();
  const d = engine.decide('yolo_everything');
  assert.equal(d.decision, 'block');
});

test('policy: kill switch freezes every tier, even T0, and survives restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-policy-3'));
  const store = new Store(path.join(dir, 't.db'));
  const engine = new PolicyEngine({ store, audit: new AuditLog(store, path.join(dir, 'a.log')), bus: new EventBus() });
  engine.engageKillSwitch('human:ops', 'spend cap');
  assert.throws(() => engine.decide('read_issue'), PolicyViolation);

  const store2 = new Store(path.join(dir, 't.db'));
  const engine2 = new PolicyEngine({ store: store2, audit: new AuditLog(store2, path.join(dir, 'a.log')), bus: new EventBus() });
  assert.equal(engine2.paused, true, 'kill switch must survive restart');
  engine2.releaseKillSwitch('human:ops');
  assert.equal(engine2.decide('read_issue').decision, 'auto');
});
