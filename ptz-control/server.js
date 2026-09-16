#!/usr/bin/env node
'use strict';

/**
 * Astra PTZ Control - multi-camera dashboard for Hollyland Astra PTZ cameras.
 *
 * - Auto-discovers cameras on the local network (VISCA-over-IP probe)
 * - Unified PTZ control panel + broadcast-to-all commands
 * - Live multiview of every camera (RTSP relayed to MJPEG via ffmpeg)
 *
 * Run:  node server.js [--port 8300] [--no-autoscan]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { cmd, ViscaClient } = require('./lib/visca');
const discovery = require('./lib/discovery');
const { StreamHub } = require('./lib/stream');

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = parseInt(argVal('--port', process.env.PORT || '8300'), 10);
const AUTOSCAN = !args.includes('--no-autoscan');
const CONFIG_FILE = path.join(__dirname, 'cameras.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const visca = new ViscaClient();
const streams = new StreamHub();

// ---- Camera registry ------------------------------------------------------

/** ip -> { ip, name, protocol, port?, rtsp?, source, lastSeen } */
const cameras = new Map();

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    for (const c of saved.cameras || []) {
      if (c && c.ip) cameras.set(c.ip, { source: 'saved', lastSeen: 0, ...c });
    }
    console.log(`Loaded ${cameras.size} saved camera(s) from cameras.json`);
  } catch {
    /* first run: no config yet */
  }
}

let saveTimer = null;
function writeConfigNow() {
  const out = { cameras: [...cameras.values()].map(({ lastSeen, ...c }) => c) };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2)); } catch {}
}
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfigNow, 250);
}

function addCamera({ ip, name, protocol, port, rtsp, source }) {
  const existing = cameras.get(ip);
  const camera = {
    ip,
    name: name || (existing && existing.name) || `Camera ${cameras.size + 1}`,
    protocol: protocol || (existing && existing.protocol) || 'sony',
    port: port || (existing && existing.port) || undefined,
    rtsp: rtsp || (existing && existing.rtsp) || undefined,
    source: source || (existing && existing.source) || 'manual',
    lastSeen: existing ? existing.lastSeen : 0,
  };
  cameras.set(ip, camera);
  saveConfig();
  return camera;
}

// ---- Liveness: mark a camera online whenever it answers VISCA -------------

visca.onMessage((rinfo) => {
  const camera = cameras.get(rinfo.address);
  if (camera) camera.lastSeen = Date.now();
});

function pollStatus() {
  for (const camera of cameras.values()) {
    visca.send(camera, cmd.versionInq(), { inquiry: true });
  }
}
setInterval(pollStatus, 5000).unref();

// ---- Discovery ------------------------------------------------------------

let scanning = false;
async function runScan(subnets) {
  if (scanning) return { scanning: true, found: [] };
  scanning = true;
  try {
    const found = await discovery.scan(subnets);
    const added = [];
    for (const hit of found) {
      const isNew = !cameras.has(hit.ip);
      const camera = addCamera({ ...hit, source: 'discovered' });
      camera.lastSeen = Date.now();
      if (isNew) added.push(camera);
    }
    if (added.length) {
      console.log(`Discovered ${added.length} new camera(s): ${added.map((c) => c.ip).join(', ')}`);
    }
    return { scanning: false, found, added };
  } finally {
    scanning = false;
  }
}

// ---- PTZ dispatch ---------------------------------------------------------

function ptzCommand(body) {
  const speed = Math.max(1, Math.min(24, body.speed || 12));
  const zoomSpeed = Math.max(0, Math.min(7, body.speed != null ? Math.round(body.speed / 3.5) : 4));
  switch (body.action) {
    case 'move': {
      // dir: up, down, left, right, upleft, upright, downleft, downright
      const d = String(body.dir || '');
      const panDir = d.includes('left') ? 0x01 : d.includes('right') ? 0x02 : 0x03;
      const tiltDir = d.includes('up') ? 0x01 : d.includes('down') ? 0x02 : 0x03;
      return cmd.panTilt(speed, Math.min(speed, 0x14), panDir, tiltDir);
    }
    case 'stop': return cmd.panTiltStop();
    case 'home': return cmd.home();
    case 'zoom': return cmd.zoom(body.dir, zoomSpeed); // dir: tele|wide|stop
    case 'focus': return cmd.focus(body.dir, zoomSpeed); // dir: far|near|stop
    case 'autofocus': return cmd.autoFocus(body.on !== false);
    case 'preset': return cmd.preset(body.mode, body.slot); // mode: set|recall|reset
    default: return null;
  }
}

// ---- HTTP server ----------------------------------------------------------

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 65536) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
  });
}

function cameraList() {
  const now = Date.now();
  return [...cameras.values()].map((c) => ({
    ...c,
    online: now - c.lastSeen < 16000,
  }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // --- API ---
    if (parts[0] === 'api') {
      if (req.method === 'GET' && url.pathname === '/api/cameras') {
        return json(res, 200, {
          cameras: cameraList(),
          ffmpeg: streams.available,
          scanning,
          subnets: discovery.localSubnets(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/cameras') {
        const body = await readBody(req);
        if (!body.ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(body.ip)) {
          return json(res, 400, { error: 'valid ip required' });
        }
        const camera = addCamera({ ...body, source: 'manual' });
        visca.send(camera, cmd.versionInq(), { inquiry: true });
        return json(res, 200, { camera });
      }
      if (req.method === 'DELETE' && parts[1] === 'cameras' && parts[2]) {
        cameras.delete(parts[2]);
        saveConfig();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && parts[1] === 'cameras' && parts[2]) {
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        const body = await readBody(req);
        if (body.name) camera.name = String(body.name).slice(0, 60);
        if (body.protocol) camera.protocol = body.protocol === 'raw' ? 'raw' : 'sony';
        if (body.rtsp !== undefined) camera.rtsp = body.rtsp || undefined;
        saveConfig();
        return json(res, 200, { camera });
      }
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        const body = await readBody(req).catch(() => ({}));
        const result = await runScan(body.subnets);
        return json(res, 200, { ...result, cameras: cameraList() });
      }
      if (req.method === 'POST' && parts[1] === 'camera' && parts[2] && parts[3] === 'ptz') {
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        const body = await readBody(req);
        const payload = ptzCommand(body);
        if (!payload) return json(res, 400, { error: 'unknown action' });
        visca.send(camera, payload);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/all/ptz') {
        const body = await readBody(req);
        const payload = ptzCommand(body);
        if (!payload) return json(res, 400, { error: 'unknown action' });
        for (const camera of cameras.values()) visca.send(camera, payload);
        return json(res, 200, { ok: true, sentTo: cameras.size });
      }
      return json(res, 404, { error: 'not found' });
    }

    // --- MJPEG video relay ---
    if (parts[0] === 'stream' && parts[1]) {
      const camera = cameras.get(parts[1]);
      if (!camera) { res.writeHead(404); return res.end(); }
      return streams.addClient(camera, res);
    }

    // --- Static UI ---
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

loadConfig();
server.listen(PORT, () => {
  console.log(`\nAstra PTZ Control running at  http://localhost:${PORT}\n`);
  if (!streams.available) {
    console.log('NOTE: ffmpeg not found on PATH - PTZ control will work, but video');
    console.log('      previews are disabled. Install ffmpeg to enable multiview.\n');
  }
  pollStatus();
  if (AUTOSCAN) {
    console.log(`Auto-scanning subnets: ${discovery.localSubnets().join(', ') || '(none found)'}`);
    runScan();
    setInterval(() => runScan(), 5 * 60 * 1000).unref();
  }
});

process.on('SIGINT', () => {
  if (saveTimer) { clearTimeout(saveTimer); writeConfigNow(); }
  streams.stopAll();
  visca.close();
  process.exit(0);
});
