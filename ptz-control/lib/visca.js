'use strict';

/**
 * VISCA over IP for Hollyland Astra (and other VISCA) PTZ cameras.
 *
 * Two transports are supported, both over UDP:
 *  - "sony"  : Sony VISCA-over-IP framing on port 52381 (Astra default).
 *              Each packet gets an 8-byte header: payload type, length, sequence.
 *  - "raw"   : Bare VISCA bytes on port 1259 (Astra's plain UDP port).
 *
 * ============================ SAFETY BOUNDARY ============================
 * This module is the ONLY place PTZ Control builds camera commands, and it
 * deliberately implements control-safe commands only:
 *
 *   SAFE LIVE CONTROL (allowed in Live Control mode):
 *     pan/tilt drive + stop, zoom, focus, autofocus mode, preset recall,
 *     home, version inquiry (used as a lightweight health check),
 *     picture freeze (only as the operator-chosen freeze-on-recall option)
 *   ADVANCED IMAGE / SHADING (operator-initiated only):
 *     exposure mode, iris/shutter/gain/brightness steps, exposure comp,
 *     white balance modes, one-push WB, backlight compensation
 *   PRESET SAVE: only from Edit Presets (Setup mode)
 *
 * There are intentionally NO commands here that touch the camera's video
 * pipeline or platform: no NDI/RTSP/SRT/stream configuration, no output,
 * resolution, frame-rate, bitrate or encoder changes, no IP/network
 * settings, no reboot/reset/power/firmware operations. Adding any such
 * command to the live path would violate the app's non-disruption policy
 * (see docs/SAFETY.md) - the NDI feed to the YoloBox Extreme must keep
 * running no matter what this app does. Do not add them.
 * =========================================================================
 */

const dgram = require('dgram');

const SONY_PORT = 52381;
const RAW_PORT = 1259;

// ---- VISCA byte builders (address 1 -> 0x81) ----------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

const cmd = {
  // panDir/tiltDir: 1 = left/up, 2 = right/down, 3 = stop
  panTilt(panSpeed, tiltSpeed, panDir, tiltDir) {
    return Buffer.from([
      0x81, 0x01, 0x06, 0x01,
      clamp(panSpeed, 1, 0x18),
      clamp(tiltSpeed, 1, 0x14),
      panDir, tiltDir, 0xff,
    ]);
  },
  panTiltStop() {
    return cmd.panTilt(1, 1, 0x03, 0x03);
  },
  home() {
    return Buffer.from([0x81, 0x01, 0x06, 0x04, 0xff]);
  },
  // dir: 'tele' | 'wide' | 'stop', speed 0-7
  zoom(dir, speed) {
    const s = clamp(speed, 0, 7);
    const b = dir === 'tele' ? 0x20 | s : dir === 'wide' ? 0x30 | s : 0x00;
    return Buffer.from([0x81, 0x01, 0x04, 0x07, b, 0xff]);
  },
  // dir: 'far' | 'near' | 'stop', speed 0-7
  focus(dir, speed) {
    const s = clamp(speed, 0, 7);
    const b = dir === 'far' ? 0x20 | s : dir === 'near' ? 0x30 | s : 0x00;
    return Buffer.from([0x81, 0x01, 0x04, 0x08, b, 0xff]);
  },
  autoFocus(on) {
    return Buffer.from([0x81, 0x01, 0x04, 0x38, on ? 0x02 : 0x03, 0xff]);
  },
  // mode: 'set' | 'recall' | 'reset', slot 0-127
  preset(mode, slot) {
    const m = mode === 'set' ? 0x01 : mode === 'recall' ? 0x02 : 0x00;
    return Buffer.from([0x81, 0x01, 0x04, 0x3f, m, clamp(slot, 0, 127), 0xff]);
  },
  versionInq() {
    return Buffer.from([0x81, 0x09, 0x00, 0x02, 0xff]);
  },

  // ---- Image / exposure ----

  // mode: 'auto' | 'manual' | 'shutter' | 'iris' | 'bright'
  exposureMode(mode) {
    const m = { auto: 0x00, manual: 0x03, shutter: 0x0a, iris: 0x0b, bright: 0x0d }[mode];
    return m === undefined ? null : Buffer.from([0x81, 0x01, 0x04, 0x39, m, 0xff]);
  },
  // One VISCA step. what: 'iris'|'shutter'|'gain'|'bright'|'expcomp', dir: 'up'|'down'|'reset'
  imageStep(what, dir) {
    const code = { iris: 0x0b, shutter: 0x0a, gain: 0x0c, bright: 0x0d, expcomp: 0x0e }[what];
    const d = { reset: 0x00, up: 0x02, down: 0x03 }[dir];
    if (code === undefined || d === undefined) return null;
    return Buffer.from([0x81, 0x01, 0x04, code, d, 0xff]);
  },
  expCompOn(on) {
    return Buffer.from([0x81, 0x01, 0x04, 0x3e, on ? 0x02 : 0x03, 0xff]);
  },
  // mode: 'auto' | 'indoor' | 'outdoor' | 'onepush' | 'manual'
  whiteBalance(mode) {
    const m = { auto: 0x00, indoor: 0x01, outdoor: 0x02, onepush: 0x03, manual: 0x05 }[mode];
    return m === undefined ? null : Buffer.from([0x81, 0x01, 0x04, 0x35, m, 0xff]);
  },
  onePushWBTrigger() {
    return Buffer.from([0x81, 0x01, 0x04, 0x10, 0x05, 0xff]);
  },
  backlight(on) {
    return Buffer.from([0x81, 0x01, 0x04, 0x33, on ? 0x02 : 0x03, 0xff]);
  },
  /**
   * CAM_PictureFreeze (standard Sony VISCA). Used only for the optional,
   * per-camera "image freeze during preset recall" feature: freeze is sent
   * right before a recall and unfreeze is sent redundantly afterwards.
   * This freezes the camera's OWN output image momentarily by design - it
   * is an operator-chosen visual effect, not a video-pipeline change.
   */
  pictureFreeze(on) {
    return Buffer.from([0x81, 0x01, 0x04, 0x62, on ? 0x02 : 0x03, 0xff]);
  },
};

// ---- Sony VISCA-over-IP framing -----------------------------------------

function sonyWrap(payload, seq, type) {
  // type: 0x0100 command, 0x0110 inquiry, 0x0200 control
  const header = Buffer.alloc(8);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(payload.length, 2);
  header.writeUInt32BE(seq >>> 0, 4);
  return Buffer.concat([header, payload]);
}

const CONTROL_RESET = Buffer.from([0x01]); // resets the camera's sequence counter

/**
 * One shared UDP socket that talks to any number of cameras.
 * Keeps a per-camera sequence counter for Sony framing.
 */
class ViscaClient {
  constructor() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', () => {}); // an unreachable host must not crash us
    this.seq = new Map(); // "ip:port" -> counter
    this.listeners = new Set(); // fn(rinfo, msg)
    this.socket.on('message', (msg, rinfo) => {
      for (const fn of this.listeners) fn(rinfo, msg);
    });
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _nextSeq(key) {
    const n = ((this.seq.get(key) || 0) + 1) >>> 0;
    this.seq.set(key, n);
    return n;
  }

  /**
   * Send a VISCA payload to a camera.
   * camera: { ip, protocol: 'sony'|'raw', port? }
   */
  send(camera, payload, { inquiry = false } = {}) {
    const protocol = camera.protocol === 'raw' ? 'raw' : 'sony';
    const port = camera.port || (protocol === 'sony' ? SONY_PORT : RAW_PORT);
    const key = `${camera.ip}:${port}`;

    let packet = payload;
    if (protocol === 'sony') {
      const seq = this._nextSeq(key);
      if (seq === 1) {
        // First contact: reset the camera's sequence counter so ours line up.
        this.socket.send(sonyWrap(CONTROL_RESET, seq, 0x0200), port, camera.ip);
      }
      packet = sonyWrap(payload, this._nextSeq(key), inquiry ? 0x0110 : 0x0100);
    }
    this.socket.send(packet, port, camera.ip, () => {});
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

module.exports = { cmd, sonyWrap, ViscaClient, SONY_PORT, RAW_PORT };
