'use strict';

/**
 * Optional RTSP -> MJPEG preview relay.
 *
 * SAFETY: previews are strictly optional and read-only. This module PULLS a
 * copy of the camera's RTSP stream; it never configures, restarts, or
 * probes the camera's video services, and it never touches NDI. Camera
 * control works fully with previews disabled, and stopping a preview only
 * closes our own ffmpeg process. To stay light on the production network
 * (which also carries live NDI to the YoloBox Extreme), the relay uses the
 * camera's LOW-BANDWIDTH SUB STREAM by default:
 *
 *   Astra P1 sub stream:  rtsp://<ip>:554/live/av1   (default here)
 *   Astra P1 main stream: rtsp://<ip>:554/live/av0   (fallback only)
 *
 * One ffmpeg process per camera, shared by every connected viewer, started
 * on the first viewer and torn down shortly after the last one leaves.
 */

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const BOUNDARY = 'ffmpeg'; // ffmpeg's mpjpeg muxer default boundary
const SUB_STREAM_PATH = '/live/av1';
const MAIN_STREAM_PATH = '/live/av0';

/** Prefer a bundled ffmpeg-static binary (Electron app), else the system one. */
function resolveFfmpeg() {
  try {
    // Inside a packaged Electron app the binary lives in app.asar.unpacked.
    let p = require('ffmpeg-static');
    if (p) {
      p = p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* ffmpeg-static not installed: plain `node server.js` usage */
  }
  return 'ffmpeg';
}

function ffmpegAvailable(bin) {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

class StreamHub {
  constructor({ log } = {}) {
    this.relays = new Map(); // ip -> { proc, clients:Set<res>, stopTimer, failures, useMain }
    this.ffmpeg = resolveFfmpeg();
    this.available = ffmpegAvailable(this.ffmpeg);
    this.log = log || { info() {}, warn() {} };
  }

  rtspUrl(camera, relay) {
    if (camera.rtsp) return camera.rtsp; // explicit per-camera override
    const streamPath = relay && relay.useMain ? MAIN_STREAM_PATH : SUB_STREAM_PATH;
    return `rtsp://${camera.ip}:554${streamPath}`;
  }

  /** Attach an HTTP response as an MJPEG viewer of the camera. */
  addClient(camera, res) {
    if (!this.available) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('ffmpeg not found - install ffmpeg to enable video previews');
      return;
    }
    const relay = this._relayFor(camera);
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    relay.clients.add(res);
    if (relay.stopTimer) {
      clearTimeout(relay.stopTimer);
      relay.stopTimer = null;
    }
    res.on('close', () => {
      relay.clients.delete(res);
      if (relay.clients.size === 0) {
        relay.stopTimer = setTimeout(() => this._stop(camera.ip), 8000);
      }
    });
  }

  _relayFor(camera) {
    let relay = this.relays.get(camera.ip);
    if (relay && relay.proc) return relay;

    relay = relay || { proc: null, clients: new Set(), stopTimer: null, failures: 0, useMain: false };
    this.relays.set(camera.ip, relay);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', this.rtspUrl(camera, relay),
      '-an',
      '-vf', 'scale=480:-2',
      '-r', '10',
      '-q:v', '8',
      '-f', 'mpjpeg',
      'pipe:1',
    ];
    const startedAt = Date.now();
    const proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    relay.proc = proc;

    proc.stdout.on('data', (chunk) => {
      relay.failures = 0; // producing frames = healthy
      for (const res of relay.clients) {
        if (!res.writableEnded) res.write(chunk);
      }
    });
    proc.on('exit', () => {
      if (relay.proc !== proc) return;
      relay.proc = null;
      // A quick exit usually means the RTSP path was refused. After two
      // rapid failures on the default sub stream, fall back to the main
      // stream path once (some firmware exposes only av0).
      if (Date.now() - startedAt < 5000) {
        relay.failures += 1;
        if (relay.failures === 2 && !camera.rtsp && !relay.useMain) {
          relay.useMain = true;
          this.log.info('preview_fallback_main_stream', { camera: camera.ip });
        }
      }
      if (relay.clients.size > 0) {
        setTimeout(() => {
          if (relay.clients.size > 0 && !relay.proc) this._relayFor(camera);
        }, 3000);
      }
    });
    return relay;
  }

  _stop(ip) {
    const relay = this.relays.get(ip);
    if (!relay) return;
    if (relay.clients.size > 0) return;
    if (relay.proc) {
      try { relay.proc.kill('SIGKILL'); } catch {}
      relay.proc = null;
    }
    this.relays.delete(ip);
  }

  stopAll() {
    for (const ip of [...this.relays.keys()]) {
      const relay = this.relays.get(ip);
      for (const res of relay.clients) { try { res.end(); } catch {} }
      relay.clients.clear();
      this._stop(ip);
    }
  }
}

module.exports = { StreamHub };
