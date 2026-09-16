'use strict';

/**
 * Structured, privacy-conscious ring-buffer logger.
 *
 * Keeps the most recent entries in memory for the Diagnostics screen and
 * mirrors warnings/errors to the console. Never logs credentials (the app
 * holds none) and never logs raw packet dumps - only event names, camera
 * identity, and short details, which is enough to troubleshoot real-world
 * connection issues without flooding anyone.
 */

const CAPACITY = 600;

class Log {
  constructor(capacity = CAPACITY) {
    this.capacity = capacity;
    this.entries = [];
  }

  _push(level, event, detail) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(detail && typeof detail === 'object' ? detail : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    if (level !== 'debug') {
      const extra = detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
      const line = `[${entry.ts}] ${level.toUpperCase()} ${event}${extra}`;
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    }
    return entry;
  }

  debug(event, detail) { return this._push('debug', event, detail); }
  info(event, detail) { return this._push('info', event, detail); }
  warn(event, detail) { return this._push('warn', event, detail); }
  error(event, detail) { return this._push('error', event, detail); }

  /** Most recent entries, newest last. */
  list(limit = 250) {
    return this.entries.slice(-limit);
  }

  /** Plain-text export for the Diagnostics "copy support info" button. */
  toText(limit = 250) {
    return this.list(limit)
      .map((e) => {
        const { ts, level, event, ...rest } = e;
        const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
        return `${ts} ${level.toUpperCase().padEnd(5)} ${event}${extra}`;
      })
      .join('\n');
  }
}

module.exports = { Log, log: new Log() };
