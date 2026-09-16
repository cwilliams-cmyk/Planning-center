'use strict';

/**
 * Per-camera control-connection health monitor.
 *
 * Health is judged ONLY from replies to a tiny VISCA version inquiry on the
 * camera's control port. The monitor never opens video connections, never
 * uses NDI or RTSP as a health signal, and never sends configuration
 * commands - a camera that stops answering control inquiries is simply
 * marked offline while its video output continues untouched.
 *
 * States:
 *   connecting - camera added/rebooted, no reply seen yet in this phase
 *   connected  - answering inquiries
 *   degraded   - 1-2 recent inquiries unanswered (intermittent)
 *   offline    - 3+ unanswered; probes back off exponentially with jitter
 *                so a powered-off camera is never hammered
 *
 * Recovery is automatic and conservative: a single reply restores the
 * camera to connected and resets the backoff. Probing is independent per
 * camera - one dead camera never delays another camera's schedule.
 */

const OFFLINE_AFTER_MISSES = 3;
const MAX_BACKOFF_MS = 60000;
const JITTER = 0.2; // +/-20%

class HealthMonitor {
  /**
   * @param {(camera: object) => void} inquire  send a version inquiry
   * @param {{baseMs?: number, liveBaseMs?: number, onTransition?: Function}} opts
   */
  constructor(inquire, { baseMs = 5000, liveBaseMs = 10000, onTransition } = {}) {
    this.inquire = inquire;
    this.baseMs = baseMs;
    this.liveBaseMs = liveBaseMs;
    this.live = false;
    this.onTransition = onTransition || (() => {});
    this.records = new Map(); // ip -> record
    this.suspended = false;
  }

  setLiveMode(live) {
    this.live = !!live;
  }

  get _base() {
    return this.live ? this.liveBaseMs : this.baseMs;
  }

  add(camera) {
    if (this.records.has(camera.ip)) {
      this.records.get(camera.ip).camera = camera;
      return;
    }
    const rec = {
      camera,
      state: 'connecting',
      everSeen: false,
      misses: 0,
      lastSeen: 0,
      pendingSince: 0,
      backoffMs: 0,
      timer: null,
    };
    this.records.set(camera.ip, rec);
    this._scheduleNext(rec, 100 + Math.random() * 400); // stagger initial probes
  }

  remove(ip) {
    const rec = this.records.get(ip);
    if (rec && rec.timer) clearTimeout(rec.timer);
    this.records.delete(ip);
  }

  /** Call when any VISCA reply arrives from this ip. */
  noteReply(ip, now = Date.now()) {
    const rec = this.records.get(ip);
    if (!rec) return;
    rec.lastSeen = now;
    rec.everSeen = true;
    rec.misses = 0;
    rec.backoffMs = 0;
    this._setState(rec, 'connected');
  }

  /**
   * One probe cycle for a camera: account for the previous inquiry, update
   * state, send a new inquiry, and return the delay until the next probe.
   * Exposed (and timer-free) so tests can drive it deterministically.
   */
  probe(ip, now = Date.now()) {
    const rec = this.records.get(ip);
    if (!rec) return null;

    if (rec.pendingSince && rec.lastSeen < rec.pendingSince) {
      rec.misses += 1;
    }

    if (rec.misses === 0) {
      this._setState(rec, rec.everSeen ? 'connected' : 'connecting');
    } else if (rec.misses < OFFLINE_AFTER_MISSES) {
      this._setState(rec, rec.everSeen ? 'degraded' : 'connecting');
    } else {
      this._setState(rec, 'offline');
    }

    if (!this.suspended) {
      rec.pendingSince = now;
      try { this.inquire(rec.camera); } catch { /* send errors are not fatal */ }
    }

    // Offline cameras get exponential backoff so a powered-off camera is
    // probed at most once a minute instead of being hammered.
    let delay;
    if (rec.state === 'offline') {
      rec.backoffMs = Math.min(rec.backoffMs ? rec.backoffMs * 2 : this._base * 2, MAX_BACKOFF_MS);
      delay = rec.backoffMs;
    } else {
      delay = this._base;
    }
    delay = Math.round(delay * (1 + (Math.random() * 2 - 1) * JITTER));
    return delay;
  }

  _scheduleNext(rec, delay) {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      const next = this.probe(rec.camera.ip);
      if (next != null) this._scheduleNext(rec, next);
    }, delay);
    if (rec.timer.unref) rec.timer.unref();
  }

  _setState(rec, state) {
    if (rec.state === state) return;
    const prev = rec.state;
    rec.state = state;
    this.onTransition(rec.camera.ip, state, prev);
  }

  /** Pause probing (macOS sleep). Existing state is kept. */
  suspend() {
    this.suspended = true;
  }

  /**
   * Resume after wake: revalidate every camera with gently staggered
   * probes instead of a burst, so waking a laptop can't spike the network.
   */
  resume() {
    this.suspended = false;
    let i = 0;
    for (const rec of this.records.values()) {
      rec.misses = 0; // don't count sleep time as missed probes
      rec.pendingSince = 0;
      rec.backoffMs = 0;
      if (!rec.everSeen) this._setState(rec, 'connecting');
      this._scheduleNext(rec, 300 + i * 400 + Math.random() * 200);
      i += 1;
    }
  }

  status(ip) {
    const rec = this.records.get(ip);
    if (!rec) return { state: 'connecting', lastSeen: 0 };
    return { state: rec.state, lastSeen: rec.lastSeen, misses: rec.misses };
  }

  stopAll() {
    for (const rec of this.records.values()) {
      if (rec.timer) clearTimeout(rec.timer);
    }
  }
}

module.exports = { HealthMonitor, OFFLINE_AFTER_MISSES, MAX_BACKOFF_MS };
