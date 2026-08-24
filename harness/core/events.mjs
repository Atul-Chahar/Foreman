// The harness event bus. The Supervisor Console subscribes over SSE;
// persisted events are replayed on reconnect, which is what makes a browser
// refresh mid-run survivable (see harness/session.mjs).

import { EventEmitter } from 'node:events';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /** Emit a domain event. `persist` is a callback into the store so events
   *  survive a process restart; pass a no-op for ephemeral test buses. */
  emitEvent(type, payload, persist = null) {
    const event = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type,
      payload,
    };
    if (persist) persist(event);
    this.emit('event', event);
    this.emit(type, event);
    return event;
  }

  /** Subscribe to every event (used by the SSE stream and the audit sink). */
  onAny(fn) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
