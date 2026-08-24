// The policy engine. Decides, for every requested action, whether it may
// proceed automatically or must stop at the approval gate. Also owns the
// global kill switch: when engaged, EVERYTHING stops, regardless of tier.

import { classify, TIERS, T2_AUTO_APPROVABLE } from './tiers.mjs';

export class PolicyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

export class PolicyEngine {
  /**
   * @param {object} opts
   * @param {boolean} opts.t1Auto human opted into T1 auto-approval (default false:
   *        a fresh clone is fully gated — the judge hits the gate immediately)
   * @param {import('../core/store.mjs').Store} opts.store
   * @param {import('../core/audit.mjs').AuditLog} opts.audit
   * @param {import('../core/events.mjs').EventBus} opts.bus
   */
  constructor({ t1Auto = false, store, audit, bus }) {
    this.store = store;
    this.audit = audit;
    this.bus = bus;
    // persisted so a restart honors the human's last choice
    this._t1Auto = this.store.getMeta('policy.t1_auto') !== null
      ? this.store.getMeta('policy.t1_auto') === 'true'
      : t1Auto;
  }

  get t1Auto() {
    return this._t1Auto;
  }

  setT1Auto(enabled, actor) {
    this._assertNotPaused();
    this._t1Auto = Boolean(enabled);
    this.store.setMeta('policy.t1_auto', String(this._t1Auto));
    this.audit.record({
      actor, tier: TIERS.T1, action: 'set_policy',
      decision: 'policy-updated',
      reason: `T1 auto-approval ${this._t1Auto ? 'enabled' : 'disabled'} (T2 is always gated)`,
    });
    this.bus.emitEvent('policy.updated', { t1Auto: this._t1Auto }, (e) => this.store.persistEvent(e));
  }

  // ── kill switch ───────────────────────────────────────────────────────────

  get paused() {
    return this.store.getMeta('killswitch') === 'engaged';
  }

  /** Freeze all pending swarm actions instantly. */
  engageKillSwitch(actor, reason = 'manual') {
    this.store.setMeta('killswitch', 'engaged');
    this.audit.record({ actor, tier: null, action: 'killswitch', decision: 'engaged', reason });
    this.bus.emitEvent('swarm.paused', { by: actor, reason }, (e) => this.store.persistEvent(e));
  }

  releaseKillSwitch(actor) {
    this.store.setMeta('killswitch', 'released');
    this.audit.record({ actor, tier: null, action: 'killswitch', decision: 'released', reason: 'manual resume' });
    this.bus.emitEvent('swarm.resumed', { by: actor }, (e) => this.store.persistEvent(e));
  }

  _assertNotPaused() {
    if (this.paused) throw new PolicyViolation('swarm is paused (kill switch engaged)');
  }

  // ── decisions ─────────────────────────────────────────────────────────────

  /**
   * Decide what happens to a requested action.
   * Returns one of:
   *   { decision: 'auto',  tier, reason }  — proceed, logged as a policy event
   *   { decision: 'gate',  tier, reason }  — create an approval, wait for human
   *   { decision: 'block', tier, reason }  — refused outright, never retried
   * @param {string} action registered action name
   * @param {object} [context] free-form context for the audit trail
   */
  decide(action, context = {}) {
    this._assertNotPaused();

    const tier = classify(action);
    if (tier === null) {
      // Fail closed: an action the registry does not know can never run.
      const entry = this.audit.record({
        actor: 'policy:engine', tier: null, action,
        decision: 'blocked', reason: 'unclassified action — fail closed',
      });
      this.bus.emitEvent('policy.blocked', { action, ...context }, (e) => this.store.persistEvent(e));
      return { decision: 'block', tier: null, reason: entry.reason };
    }

    if (tier === TIERS.T2) {
      // T2_AUTO_APPROVABLE is a constant false. There is no code path that
      // turns this into an auto-approval — see harness/policy/tiers.mjs.
      if (!T2_AUTO_APPROVABLE) {
        this.audit.record({
          actor: 'policy:engine', tier, action,
          decision: 'gated', reason: 'T2 irreversible — requires human approval (cannot be auto-approved)',
        });
        return { decision: 'gate', tier, reason: 'T2 irreversible action — waiting for a human' };
      }
      // Unreachable while T2_AUTO_APPROVABLE === false. Kept explicit so a
      // reviewer can see the shape of the guarantee we refuse to build.
      throw new PolicyViolation('T2 auto-approval attempted — this is a bug');
    }

    if (tier === TIERS.T1 && this._t1Auto) {
      this.audit.record({
        actor: 'policy:T1', tier, action,
        decision: 'auto-approved', reason: 'human enabled T1 auto-approval',
      });
      this.bus.emitEvent('policy.auto_approved', { action, tier, ...context }, (e) => this.store.persistEvent(e));
      return { decision: 'auto', tier, reason: 'auto-approved by policy T1' };
    }

    // T0, or T1 while gated
    this.audit.record({
      actor: tier === TIERS.T0 ? 'policy:T0' : 'policy:engine',
      tier, action,
      decision: tier === TIERS.T0 ? 'auto-approved' : 'gated',
      reason: tier === TIERS.T0 ? 'read-only' : 'T1 gated by default — enable auto-approval in the console',
    });
    if (tier === TIERS.T0) {
      return { decision: 'auto', tier, reason: 'auto-approved by policy T0 (read-only)' };
    }
    return { decision: 'gate', tier, reason: 'T1 reversible write — gated until a human opts in' };
  }

  /** Convenience for call sites: proceed without a gate? */
  allows(action, context) {
    return this.decide(action, context).decision === 'auto';
  }
}
