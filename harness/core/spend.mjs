// Spend meter. Parallel agents multiply cost by the swarm size; this meter
// is the hard ceiling. Every dispatch costs a fixed estimate; when the
// running total reaches the cap the meter engages the kill switch itself —
// no agent, planner, or reconciler may spend past it.

export class SpendMeter {
  /**
   * @param {object} opts
   * @param {number} opts.capUsd hard ceiling for the whole run
   * @param {number} opts.perRunUsd estimated cost of one subagent run
   * @param {import('./store.mjs').Store} opts.store
   * @param {import('./audit.mjs').AuditLog} opts.audit
   * @param {import('./events.mjs').EventBus} opts.bus
   */
  constructor({ capUsd, perRunUsd, store, audit, bus }) {
    this.capUsd = capUsd;
    this.perRunUsd = perRunUsd;
    this.store = store;
    this.audit = audit;
    this.bus = bus;
  }

  get spentUsd() {
    const runs = Number(this.store.getMeta('spend.runs') || 0);
    return round(runs * this.perRunUsd);
  }

  get overCap() {
    return this.spentUsd >= this.capUsd;
  }

  /** Reserve one agent run. Returns false (and fires the cap event once)
   *  when the budget is exhausted — including a reservation that would land
   *  exactly ON the cap: that run is allowed and immediately flagged, so
   *  nothing can ever slip past the ceiling unnoticed. */
  reserve(actor = 'system:dispatcher') {
    const fireCapHit = () => {
      if (this.store.getMeta('spend.cap_hit') !== '1') {
        this.store.setMeta('spend.cap_hit', '1');
        this.audit.record({
          actor: 'system:spendmeter', tier: null, action: 'spend_cap',
          decision: 'engaged', reason: `spent $${this.spentUsd} of $${this.capUsd} cap`,
        });
        this.bus.emitEvent('spend.cap_hit', { spentUsd: this.spentUsd, capUsd: this.capUsd }, (e) => this.store.persistEvent(e));
      }
    };

    if (this.overCap || this.spentUsd + this.perRunUsd > this.capUsd) {
      fireCapHit();
      return false;
    }
    const runs = Number(this.store.getMeta('spend.runs') || 0) + 1;
    this.store.setMeta('spend.runs', String(runs));
    this.bus.emitEvent('spend.tick', { runs, spentUsd: round(runs * this.perRunUsd), capUsd: this.capUsd }, (e) => this.store.persistEvent(e));
    if (this.overCap) fireCapHit();
    return true;
  }

  snapshot() {
    return { spentUsd: this.spentUsd, capUsd: this.capUsd, overCap: this.overCap };
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}
