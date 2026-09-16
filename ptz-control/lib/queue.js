'use strict';

/**
 * Per-camera command queue + motion watchdog.
 *
 * Why this exists (production-network safety):
 *  - VISCA control must be a polite participant on a PoE switch that is
 *    also carrying live NDI video. The queue serializes commands per
 *    camera and enforces a minimum spacing, so no user input pattern can
 *    flood the network or the camera's control port.
 *  - Rapid joystick input is COALESCED: a newer movement command replaces
 *    a queued one instead of piling up, so a backlog can never keep a
 *    camera moving after the operator has let go.
 *  - STOP is prioritized: it discards every queued movement command, jumps
 *    the queue, and is sent twice (spaced apart) because control runs over
 *    UDP and a single lost stop packet must not leave a camera drifting
 *    across the stage.
 *  - The MotionGuard is a dead-man switch: if the client stops sending
 *    keepalives while a camera is moving (crashed browser window, dropped
 *    Wi-Fi, sleeping laptop), the server sends stop on its own.
 *
 * None of this touches video: only control-port payloads pass through.
 */

const KIND = { MOVE: 'move', STOP: 'stop', ONESHOT: 'oneshot' };

class CameraQueue {
  /**
   * @param {(payload: Buffer) => void} send  transmit one payload now
   * @param {{minIntervalMs?: number, maxQueue?: number, onDrop?: Function}} opts
   */
  constructor(send, { minIntervalMs = 40, maxQueue = 16, onDrop } = {}) {
    this.send = send;
    this.minIntervalMs = minIntervalMs;
    this.maxQueue = maxQueue;
    this.onDrop = onDrop || (() => {});
    this.items = []; // { payload, kind }
    this.lastSentAt = 0;
    this.timer = null;
    this.closed = false;
  }

  /**
   * Enqueue a payload.
   * kind 'move'    - continuous motion (pan/tilt/zoom/focus drive): coalesced.
   * kind 'stop'    - flushes all queued 'move' items, jumps the queue, and is
   *                  sent redundantly (twice).
   * kind 'oneshot' - presets, image commands: kept in order.
   */
  push(payload, kind = KIND.ONESHOT) {
    if (this.closed || !payload) return;

    if (kind === KIND.MOVE) {
      const i = this.items.findIndex((it) => it.kind === KIND.MOVE);
      if (i >= 0) {
        this.items[i] = { payload, kind }; // newest movement wins
        this._schedule();
        return;
      }
    } else if (kind === KIND.STOP) {
      // A stop makes every queued movement obsolete.
      this.items = this.items.filter((it) => it.kind !== KIND.MOVE);
      this.items.unshift({ payload, kind });
      this.items.splice(1, 0, { payload, kind }); // redundant second send
      this._schedule();
      return;
    }

    if (this.items.length >= this.maxQueue) {
      // Never grow unbounded: drop the oldest movement first, else the
      // oldest one-shot. Stops are never dropped.
      const i = this.items.findIndex((it) => it.kind === KIND.MOVE);
      const dropped = this.items.splice(i >= 0 ? i : 0, 1)[0];
      if (dropped) this.onDrop(dropped);
    }
    this.items.push({ payload, kind });
    this._schedule();
  }

  _schedule() {
    if (this.timer || this.closed || this.items.length === 0) return;
    const wait = Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const item = this.items.shift();
      if (!item) return;
      this.lastSentAt = Date.now();
      try { this.send(item.payload); } catch { /* socket errors must not throw here */ }
      this._schedule();
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  get pending() {
    return this.items.length;
  }

  close() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.items = [];
  }
}

/** One queue per camera, created on demand and disposed with the camera. */
class QueueHub {
  constructor(opts = {}) {
    this.opts = opts;
    this.queues = new Map(); // ip -> CameraQueue
  }

  get(ip, send) {
    let q = this.queues.get(ip);
    if (!q) {
      q = new CameraQueue(send, this.opts);
      this.queues.set(ip, q);
    }
    return q;
  }

  remove(ip) {
    const q = this.queues.get(ip);
    if (q) q.close();
    this.queues.delete(ip);
  }

  closeAll() {
    for (const q of this.queues.values()) q.close();
    this.queues.clear();
  }
}

/**
 * Dead-man switch for camera motion.
 *
 * The client re-sends its movement command periodically while a control is
 * held (a keepalive). If keepalives stop arriving while a camera is marked
 * moving - crashed UI, lost Wi-Fi, closed laptop lid - the guard sends stop
 * itself so no camera keeps moving unattended during a service.
 */
class MotionGuard {
  /**
   * @param {(ip: string) => void} stopFn  issue a full stop to the camera
   * @param {{timeoutMs?: number, tickMs?: number, onTrigger?: Function}} opts
   */
  constructor(stopFn, { timeoutMs = 1300, tickMs = 250, onTrigger } = {}) {
    this.stopFn = stopFn;
    this.timeoutMs = timeoutMs;
    this.tickMs = tickMs;
    this.onTrigger = onTrigger || (() => {});
    this.moving = new Map(); // ip -> last keepalive timestamp
    this.timer = null;
  }

  noteMotion(ip) {
    this.moving.set(ip, Date.now());
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  noteStop(ip) {
    this.moving.delete(ip);
    this._maybeIdle();
  }

  /** Check for stale motion; exposed for tests. */
  tick(now = Date.now()) {
    for (const [ip, last] of this.moving) {
      if (now - last > this.timeoutMs) {
        this.moving.delete(ip);
        this.onTrigger(ip);
        try { this.stopFn(ip); } catch { /* never throw from the guard */ }
      }
    }
    this._maybeIdle();
  }

  /** Stop everything that is currently moving (sleep, quit, panic). */
  stopAll() {
    for (const ip of [...this.moving.keys()]) {
      this.moving.delete(ip);
      try { this.stopFn(ip); } catch {}
    }
    this._maybeIdle();
  }

  _maybeIdle() {
    if (this.moving.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { CameraQueue, QueueHub, MotionGuard, KIND };
