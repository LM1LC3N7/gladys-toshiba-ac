// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// The live link reports every change of a unit and a heartbeat with its
// temperatures; a fleet of units after a reconnection reports everything at
// once. The publisher keeps the LAST value of each feature, sends the pending
// ones every second within a per-minute budget and skips the unchanged ones
// (publishChangedStates, with a heartbeat so a stable value stays recently
// dated in Gladys). A value that could not be sent is kept for the next round,
// unless a newer one arrived meanwhile.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = Date.now,
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state } | { text } */
    this.pending = new Map();
    /** send times of the last minute */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger?.warn?.(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forget the pending values of a device (deleted, or before a resync). */
  forget(prefix) {
    for (const key of this.pending.keys()) {
      if (key === prefix || key.startsWith(`${prefix}:`)) {
        this.pending.delete(key);
      }
    }
  }

  clear() {
    this.pending.clear();
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    if (room <= 0 || this.pending.size === 0) {
      return 0;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (room <= 0) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      const count = result?.count ?? batch.length;
      for (let i = 0; i < count; i += 1) {
        this.window.push(now);
      }
      return count;
    } catch (err) {
      for (const entry of batch) {
        const { device_feature_external_id: id, ...value } = entry;
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
