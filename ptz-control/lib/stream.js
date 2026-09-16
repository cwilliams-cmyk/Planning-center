'use strict';

/**
 * RTSP -> MJPEG relay so camera video can render in a plain <img> tag.
 *
 * One ffmpeg process per camera, shared by every connected browser client.
 * The process starts on the first viewer and is torn down a few seconds
 * after the last viewer disconnects.
 *
 * Astra P1 main stream: rtsp://<ip>:554/live/av0  (sub stream: /live/av1)
 */

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const BOUNDARY = 'ffmpeg'; // ffmpeg's mpjpeg muxer default boundary

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
  constructor() {
    this.relays = new Map(); // ip -> { proc, clients:Set<res>, stopTimer }
    this.ffmpeg = resolveFfmpeg();
    this.available = ffmpegAvailable(this.ffmpeg);
  }

  rtspUrl(camera) {
    return camera.rtsp || `rtsp://${camera.ip}:554/live/av0`;
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

    relay = relay || { proc: null, clients: new Set(), stopTimer: null };
    this.relays.set(camera.ip, relay);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', this.rtspUrl(camera),
      '-an',
      '-vf', 'scale=640:-2',
      '-r', '12',
      '-q:v', '7',
      '-f', 'mpjpeg',
      'pipe:1',
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    relay.proc = proc;

    proc.stdout.on('data', (chunk) => {
      for (const res of relay.clients) {
        if (!res.writableEnded) res.write(chunk);
      }
    });
    proc.on('exit', () => {
      if (relay.proc !== proc) return;
      relay.proc = null;
      if (relay.clients.size > 0) {
        // Camera dropped or stream hiccup: retry while viewers remain.
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
