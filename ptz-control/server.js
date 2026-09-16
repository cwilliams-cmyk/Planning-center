#!/usr/bin/env node
'use strict';

/**
 * PTZ Control - production PTZ control for Hollyland Astra cameras.
 *
 * NON-DISRUPTION POLICY (see docs/SAFETY.md): this app sends lightweight,
 * rate-limited VISCA control commands only. It never configures, restarts,
 * probes, or depends on the cameras' NDI/RTSP video services; the video
 * path to the YoloBox Extreme is externally owned and continues whether or
 * not this app is running, connected, or healthy.
 *
 * Run:  node server.js [--port 8300]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { cmd, ViscaClient } = require('./lib/visca');
const discovery = require('./lib/discovery');
const { StreamHub } = require('./lib/stream');
const { QueueHub, MotionGuard, KIND } = require('./lib/queue');
const { HealthMonitor } = require('./lib/health');
const { log } = require('./lib/log');

const VERSION = (() => {
  try { return require('./package.json').version; } catch { return 'unknown'; }
})();

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = parseInt(argVal('--port', process.env.PORT || '8300'), 10);
let CONFIG_FILE = argVal('--config', path.join(__dirname, 'cameras.json'));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Operating mode ---------------------------------------------------------
// The app always starts in Live Control mode: the safe, control-only mode
// meant for use while the YoloBox Extreme may be recording or streaming.
// Setup mode (scans, adding/removing cameras, editing presets) is only ever
// entered by an explicit operator action and is never entered automatically.
let mode = 'live'; // 'live' | 'setup'

const LIVE_BLOCKED_MSG =
  'This change is disabled in Live Control mode. Switch to Setup mode ' +
  '(before service) to modify cameras or presets.';
const SCAN_BLOCKED_MSG =
  'Network scan disabled in Live Control mode to protect production-network reliability.';

// ---- Core services ----------------------------------------------------------

const visca = new ViscaClient();
const streams = new StreamHub({ log });
const queues = new QueueHub({
  minIntervalMs: 40,
  maxQueue: 16,
  onDrop: () => log.debug('queue_drop_oldest'),
});

/** Everything a camera sends goes through its queue - never directly. */
function enqueue(camera, payload, kind) {
  const q = queues.get(camera.ip, (p) => visca.send(camera, p));
  q.push(payload, kind);
}

/** Full stop: pan/tilt, zoom, and focus drive all halted. */
function sendFullStop(camera) {
  enqueue(camera, cmd.panTiltStop(), KIND.STOP);
  enqueue(camera, cmd.zoom('stop', 0), KIND.STOP);
  enqueue(camera, cmd.focus('stop', 0), KIND.STOP);
}

// Dead-man switch: if movement keepalives stop arriving (crashed UI, lost
// Wi-Fi, sleeping laptop), stop the camera server-side.
const motionGuard = new MotionGuard(
  (ip) => {
    const camera = cameras.get(ip);
    if (camera) sendFullStop(camera);
  },
  { onTrigger: (ip) => log.warn('watchdog_stop', { camera: ip, reason: 'keepalive lost while moving' }) }
);

// Control-connection health, judged only from VISCA inquiry replies.
const health = new HealthMonitor(
  (camera) => visca.send(camera, cmd.versionInq(), { inquiry: true }),
  {
    onTransition: (ip, state, prev) => {
      const level = state === 'offline' ? 'warn' : 'info';
      log[level]('connection_state', { camera: ip, from: prev, to: state });
    },
  }
);

visca.onMessage((rinfo) => {
  health.noteReply(rinfo.address);
});

// ---- Camera registry --------------------------------------------------------

/**
 * ip -> { ip, name, protocol, port?, rtsp?, source, disabled,
 *         freezeOnRecall, presets: {slot: {name}}, presetOrder: [slots] }
 */
const cameras = new Map();

const DEFAULT_PRESET_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9];
// How long after a freeze-on-recall before the (redundant) unfreezes go out.
const UNFREEZE_MS = parseInt(process.env.PTZ_UNFREEZE_MS || '2500', 10);

/**
 * AI tracking state as last commanded by this app, per camera ip.
 * true = we turned tracking on, false = we turned it off, absent = unknown
 * (e.g. tracking was toggled from the camera's own remote/web UI - there is
 * no VISCA inquiry to read it back, so the UI is honest about "unknown").
 */
const trackingState = new Map();

// Astra P1 behavior (per Hollyland's FAQ): manual pan/tilt is ignored while
// AI tracking is active, so reject it with an actionable message instead of
// letting controls appear to work and silently fail.
const TRACKING_BLOCKED_MSG =
  'Manual pan/tilt is unavailable while AI Tracking is active. ' +
  'Stop tracking to take manual control.';

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function validIp(ip) {
  const m = IP_RE.exec(String(ip || '').trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
}
function validPort(port) {
  return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535);
}
function validPresetOrder(order) {
  return Array.isArray(order) && order.length === 9 &&
    [...order].sort((a, b) => a - b).every((v, i) => v === i + 1);
}
/**
 * Custom tracking command bytes (per camera): { on, off } as hex strings,
 * e.g. from Hollyland support or a capture of the camera's own web UI.
 * Kept small and even-length; sent verbatim on the control port only.
 */
const HEX_RE = /^([0-9a-fA-F]{2}){2,32}$/;
function validTrackingCustom(tc) {
  return !!tc && typeof tc === 'object' &&
    HEX_RE.test(String(tc.on || '')) && HEX_RE.test(String(tc.off || ''));
}

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return; // first run: no config yet
  }
  try {
    const saved = JSON.parse(raw);
    for (const c of saved.cameras || []) {
      if (c && validIp(c.ip)) {
        cameras.set(c.ip, {
          ip: c.ip,
          name: String(c.name || c.ip).slice(0, 60),
          protocol: c.protocol === 'raw' ? 'raw' : 'sony',
          port: validPort(c.port) ? c.port : undefined,
          rtsp: typeof c.rtsp === 'string' && c.rtsp.startsWith('rtsp://') ? c.rtsp : undefined,
          source: c.source || 'saved',
          disabled: !!c.disabled,
          freezeOnRecall: !!c.freezeOnRecall,
          trackingMethod: ['preset', 'custom'].includes(c.trackingMethod) ? c.trackingMethod : 'visca',
          trackingCustom: validTrackingCustom(c.trackingCustom) ? c.trackingCustom : undefined,
          presets: c.presets && typeof c.presets === 'object' ? c.presets : {},
          presetOrder: validPresetOrder(c.presetOrder) ? c.presetOrder : [...DEFAULT_PRESET_ORDER],
        });
      }
    }
    log.info('config_loaded', { cameras: cameras.size });
  } catch (err) {
    // Never lose the operator's camera list silently: keep the corrupt file
    // for recovery and continue with an empty list.
    const backup = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(CONFIG_FILE, backup); } catch {}
    log.error('config_corrupt', { detail: err.message, savedTo: path.basename(backup) });
  }
  for (const camera of cameras.values()) {
    if (!camera.disabled) health.add(camera);
  }
}

let saveTimer = null;
function writeConfigNow() {
  const out = { version: 1, cameras: [...cameras.values()] };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    log.error('config_save_failed', { detail: err.message });
  }
}
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfigNow, 250);
}

function addCamera({ ip, name, protocol, port, rtsp, source }) {
  const existing = cameras.get(ip);
  const camera = {
    ip,
    name: (name && String(name).slice(0, 60)) || (existing && existing.name) || `Camera ${cameras.size + 1}`,
    protocol: protocol === 'raw' ? 'raw' : (existing && existing.protocol) || 'sony',
    port: port || (existing && existing.port) || undefined,
    rtsp: rtsp || (existing && existing.rtsp) || undefined,
    source: source || (existing && existing.source) || 'manual',
    disabled: existing ? !!existing.disabled : false,
    freezeOnRecall: existing ? !!existing.freezeOnRecall : false,
    trackingMethod: (existing && existing.trackingMethod) || 'visca',
    trackingCustom: (existing && existing.trackingCustom) || undefined,
    presets: (existing && existing.presets) || {},
    presetOrder: (existing && existing.presetOrder) || [...DEFAULT_PRESET_ORDER],
  };
  cameras.set(ip, camera);
  if (!camera.disabled) health.add(camera);
  saveConfig();
  if (!existing) log.info('camera_added', { camera: ip, source: camera.source });
  return camera;
}

/**
 * Disable = the operator has intentionally parked this camera: no health
 * probes, no automatic reconnects, no commands until re-enabled. Its saved
 * configuration and preset labels are fully preserved.
 */
function setCameraDisabled(camera, disabled) {
  camera.disabled = !!disabled;
  if (camera.disabled) {
    health.remove(camera.ip);
    queues.remove(camera.ip);
    motionGuard.noteStop(camera.ip);
  } else {
    health.add(camera);
  }
  saveConfig();
  log.info(disabled ? 'camera_disabled' : 'camera_enabled', { camera: camera.ip });
}

function removeCamera(ip) {
  if (!cameras.has(ip)) return false;
  cameras.delete(ip);
  health.remove(ip);
  queues.remove(ip);
  motionGuard.noteStop(ip);
  trackingState.delete(ip);
  saveConfig();
  log.info('camera_removed', { camera: ip });
  return true;
}

// ---- Discovery (manual, Setup mode only) ------------------------------------

let scanning = false;
async function runScan(subnets) {
  if (scanning) return { scanning: true, found: [] };
  scanning = true;
  log.info('scan_started', { subnets: subnets && subnets.length ? subnets : discovery.localSubnets() });
  try {
    const found = await discovery.scan(subnets);
    const added = [];
    for (const hit of found) {
      const isNew = !cameras.has(hit.ip);
      const camera = addCamera({ ...hit, source: 'discovered' });
      health.noteReply(camera.ip);
      if (isNew) added.push(camera);
    }
    log.info('scan_finished', { found: found.length, added: added.length });
    return { scanning: false, found, added };
  } finally {
    scanning = false;
  }
}

// ---- PTZ dispatch -----------------------------------------------------------
// Live-control commands only; see the safety boundary note in lib/visca.js.

const CONTINUOUS_ACTIONS = new Set(['move', 'zoom', 'focus']);

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
    // --- operator-initiated image / shading (safe VISCA image commands) ---
    case 'exposureMode': return cmd.exposureMode(body.mode); // auto|manual|shutter|iris|bright
    case 'image': {
      // what: iris|shutter|gain|bright|expcomp, dir: up|down|reset
      const step = cmd.imageStep(body.what, body.dir);
      if (!step) return null;
      return body.what === 'expcomp' ? [cmd.expCompOn(true), step] : step;
    }
    case 'wb': {
      const wb = cmd.whiteBalance(body.mode); // auto|indoor|outdoor|onepush|manual
      if (!wb) return null;
      return body.mode === 'onepush' ? [wb, cmd.onePushWBTrigger()] : wb;
    }
    case 'backlight': return cmd.backlight(body.on !== false);
    default: return null;
  }
}

/**
 * Route one PTZ request to a camera through its queue, with the motion
 * watchdog armed for continuous movement. Returns an error string when the
 * request is not allowed in the current mode.
 */
function dispatchPTZ(camera, body) {
  if (camera.disabled) {
    return `${camera.name} is disabled in PTZ Control. Enable it in Setup mode to control it.`;
  }
  if (body.action === 'preset' && body.mode !== 'recall' && mode !== 'setup') {
    return LIVE_BLOCKED_MSG; // preset save/reset only from Edit Presets (Setup)
  }

  // AI tracking on/off: operator-initiated only, never automatic. Two
  // command conventions exist in the wild; the per-camera trackingMethod
  // picks the one this camera honors (verify in Setup before a service).
  if (body.action === 'tracking') {
    const on = body.on !== false;
    let payload;
    if (camera.trackingMethod === 'custom' && validTrackingCustom(camera.trackingCustom)) {
      payload = Buffer.from(on ? camera.trackingCustom.on : camera.trackingCustom.off, 'hex');
    } else if (camera.trackingMethod === 'preset') {
      payload = cmd.preset('recall', on ? 80 : 81);
    } else {
      payload = cmd.tracking(on);
    }
    // Turning tracking on makes queued manual movement obsolete; turning it
    // off must land reliably so the operator can take manual control. Both
    // ride the never-dropped stop lane.
    motionGuard.noteStop(camera.ip);
    enqueue(camera, payload, on ? KIND.ONESHOT : KIND.STOP);
    trackingState.set(camera.ip, on);
    log.info(on ? 'tracking_on' : 'tracking_off', { camera: camera.ip, method: camera.trackingMethod });
    return null;
  }

  // The Astra P1 ignores manual pan/tilt while tracking is active - be
  // honest instead of letting the D-pad silently do nothing.
  if (trackingState.get(camera.ip) === true &&
      (body.action === 'move' || body.action === 'home')) {
    return TRACKING_BLOCKED_MSG;
  }

  const payload = ptzCommand(body);
  if (!payload) return 'unknown action';

  const isStop = body.action === 'stop' ||
    (CONTINUOUS_ACTIONS.has(body.action) && body.dir === 'stop');

  if (isStop) {
    motionGuard.noteStop(camera.ip);
    for (const p of Array.isArray(payload) ? payload : [payload]) {
      enqueue(camera, p, KIND.STOP);
    }
    return null;
  }

  if (CONTINUOUS_ACTIONS.has(body.action)) {
    motionGuard.noteMotion(camera.ip); // client keepalives refresh this
    enqueue(camera, payload, KIND.MOVE);
    return null;
  }

  // Optional per-camera "image freeze during preset recall": freeze right
  // before the recall so the physical move is hidden on the live output,
  // then unfreeze redundantly (three sends over two timers) - a lost UDP
  // unfreeze must never leave a frozen frame on the recording.
  if (body.action === 'preset' && body.mode === 'recall' && camera.freezeOnRecall) {
    enqueue(camera, cmd.pictureFreeze(true), KIND.ONESHOT);
    const unfreeze = () => {
      if (!cameras.has(camera.ip)) return;
      enqueue(camera, cmd.pictureFreeze(false), KIND.STOP); // stop-kind = never dropped, sent twice
    };
    setTimeout(unfreeze, UNFREEZE_MS).unref();
    setTimeout(unfreeze, UNFREEZE_MS * 2).unref();
  }

  for (const p of Array.isArray(payload) ? payload : [payload]) {
    enqueue(camera, p, KIND.ONESHOT);
  }
  if (body.action === 'preset') {
    log.info(`preset_${body.mode}`, { camera: camera.ip, slot: body.slot, freeze: !!camera.freezeOnRecall });
  } else if (body.action !== 'home') {
    log.info('image_command', { camera: camera.ip, action: body.action, detail: body.mode || body.what });
  }
  return null;
}

// ---- HTTP server ------------------------------------------------------------

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
  return [...cameras.values()].map((c) => {
    const tracking = trackingState.has(c.ip) ? trackingState.get(c.ip) : null; // null = unknown
    if (c.disabled) return { ...c, state: 'disabled', lastSeen: 0, online: false, tracking };
    const h = health.status(c.ip);
    return {
      ...c, tracking,
      state: h.state, lastSeen: h.lastSeen,
      online: h.state === 'connected' || h.state === 'degraded',
    };
  });
}

function statePayload() {
  return {
    cameras: cameraList(),
    mode,
    ffmpeg: streams.available,
    scanning,
    subnets: discovery.localSubnets(),
    version: VERSION,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (parts[0] === 'api') {
      // ---- read-only ----
      if (req.method === 'GET' && url.pathname === '/api/cameras') {
        return json(res, 200, statePayload());
      }
      if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
        const NEXT_STEP = {
          connected: 'No action needed.',
          degraded: 'Control replies are intermittent - check cabling and switch port. Video is unaffected.',
          connecting: 'Waiting for the first control reply. Verify the IP address and that the camera is powered.',
          offline: 'Check the camera’s power and network cable, then use Retry. Video output continues independently.',
          disabled: 'Disabled by the operator. Enable it in Setup mode to reconnect.',
        };
        return json(res, 200, {
          version: VERSION,
          mode,
          cameras: cameraList().map(({ ip, name, state, protocol, lastSeen }) =>
            ({ ip, name, state, protocol, lastSeen, nextStep: NEXT_STEP[state] || '' })),
          log: log.list(250),
          text: [
            `PTZ Control ${VERSION} - diagnostics ${new Date().toISOString()}`,
            `Mode: ${mode === 'live' ? 'Live Control' : 'Setup'}`,
            ...cameraList().map((c) => `Camera ${c.name} (${c.ip}, ${c.protocol}): ${c.state}`),
            '',
            log.toText(250),
          ].join('\n'),
        });
      }

      // ---- mode ----
      if (req.method === 'POST' && url.pathname === '/api/mode') {
        const body = await readBody(req);
        const next = body.mode === 'setup' ? 'setup' : 'live';
        if (next !== mode) {
          mode = next;
          health.setLiveMode(mode === 'live');
          log.info('mode_changed', { to: mode });
        }
        return json(res, 200, { mode });
      }

      // ---- camera management (Setup mode only) ----
      if (req.method === 'POST' && url.pathname === '/api/cameras') {
        if (mode !== 'setup') return json(res, 409, { error: LIVE_BLOCKED_MSG });
        const body = await readBody(req);
        if (!validIp(body.ip)) return json(res, 400, { error: 'A valid IP address is required (e.g. 192.168.1.100).' });
        if (!validPort(body.port)) return json(res, 400, { error: 'Port must be between 1 and 65535.' });
        if (body.rtsp && !String(body.rtsp).startsWith('rtsp://')) {
          return json(res, 400, { error: 'RTSP override must start with rtsp://' });
        }
        const existed = cameras.has(body.ip);
        const camera = addCamera({ ...body, source: 'manual' });
        return json(res, 200, { camera, existed });
      }
      if (req.method === 'DELETE' && parts[1] === 'cameras' && parts[2] && parts.length === 3) {
        if (mode !== 'setup') return json(res, 409, { error: LIVE_BLOCKED_MSG });
        removeCamera(parts[2]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && parts[1] === 'cameras' && parts[2]) {
        if (mode !== 'setup') return json(res, 409, { error: LIVE_BLOCKED_MSG });
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        const body = await readBody(req);
        if (body.name) camera.name = String(body.name).slice(0, 60);
        if (body.protocol) camera.protocol = body.protocol === 'raw' ? 'raw' : 'sony';
        if (body.rtsp !== undefined) {
          if (body.rtsp && !String(body.rtsp).startsWith('rtsp://')) {
            return json(res, 400, { error: 'RTSP override must start with rtsp://' });
          }
          camera.rtsp = body.rtsp || undefined;
        }
        if (body.freezeOnRecall !== undefined) camera.freezeOnRecall = !!body.freezeOnRecall;
        if (body.trackingMethod !== undefined) {
          if (!['visca', 'preset', 'custom'].includes(body.trackingMethod)) {
            return json(res, 400, { error: 'trackingMethod must be "visca", "preset", or "custom"' });
          }
          if (body.trackingMethod === 'custom' && !validTrackingCustom(body.trackingCustom || camera.trackingCustom)) {
            return json(res, 400, { error: 'custom tracking needs on/off command bytes as hex (e.g. "810a115402ff")' });
          }
          camera.trackingMethod = body.trackingMethod;
        }
        if (body.trackingCustom !== undefined) {
          if (body.trackingCustom !== null && !validTrackingCustom(body.trackingCustom)) {
            return json(res, 400, { error: 'trackingCustom must be { on, off } hex strings (2-32 bytes each)' });
          }
          camera.trackingCustom = body.trackingCustom || undefined;
        }
        saveConfig();
        return json(res, 200, { camera });
      }

      // ---- enable/disable a camera (Setup mode; a disabled camera gets no
      //      probes, no reconnects, and no commands until re-enabled) ----
      if (req.method === 'POST' && parts[1] === 'cameras' && parts[3] === 'disable') {
        if (mode !== 'setup') return json(res, 409, { error: LIVE_BLOCKED_MSG });
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        const body = await readBody(req).catch(() => ({}));
        setCameraDisabled(camera, body.disabled !== false);
        return json(res, 200, { camera });
      }

      // ---- operator-initiated "retry control connection" (any mode; it is
      //      one immediate control probe, nothing more) ----
      if (req.method === 'POST' && parts[1] === 'cameras' && parts[3] === 'retry') {
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        if (camera.disabled) return json(res, 409, { error: `${camera.name} is disabled. Enable it in Setup mode first.` });
        health.probeNow(camera.ip);
        log.info('manual_retry', { camera: camera.ip });
        return json(res, 200, { ok: true });
      }

      // ---- preset display order (Setup mode only) ----
      if (req.method === 'PUT' && parts[1] === 'cameras' && parts[3] === 'preset-order') {
        if (mode !== 'setup') return json(res, 409, { error: LIVE_BLOCKED_MSG });
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        const body = await readBody(req);
        if (!validPresetOrder(body.order)) {
          return json(res, 400, { error: 'order must contain each preset 1-9 exactly once' });
        }
        camera.presetOrder = body.order;
        saveConfig();
        return json(res, 200, { presetOrder: camera.presetOrder });
      }

      // ---- preset names (Setup mode only; the position itself is stored
      //      in the camera and only changed via an explicit preset-set) ----
      if (req.method === 'PUT' && parts[1] === 'cameras' && parts[3] === 'presets' && parts[4]) {
        if (mode !== 'setup') return json(res, 409, { error: LIVE_BLOCKED_MSG });
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        const slot = String(parseInt(parts[4], 10));
        const body = await readBody(req);
        if (body.name) camera.presets[slot] = { name: String(body.name).slice(0, 40) };
        else delete camera.presets[slot];
        saveConfig();
        return json(res, 200, { presets: camera.presets });
      }

      // ---- discovery (Setup mode only) ----
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        if (mode !== 'setup') return json(res, 409, { error: SCAN_BLOCKED_MSG });
        const body = await readBody(req).catch(() => ({}));
        const result = await runScan(body.subnets);
        return json(res, 200, { ...result, cameras: cameraList() });
      }

      // ---- live control ----
      if (req.method === 'POST' && parts[1] === 'camera' && parts[2] && parts[3] === 'ptz') {
        const camera = cameras.get(parts[2]);
        if (!camera) return json(res, 404, { error: 'unknown camera' });
        const body = await readBody(req);
        const err = dispatchPTZ(camera, body);
        if (err) return json(res, err === 'unknown action' ? 400 : 409, { error: err });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/all/ptz') {
        const body = await readBody(req);
        if (body.action === 'tracking') {
          return json(res, 409, { error: 'AI Tracking is controlled per camera, not broadcast to all.' });
        }
        let sent = 0;
        let firstErr = null;
        for (const camera of cameras.values()) {
          if (camera.disabled) continue;
          const err = dispatchPTZ(camera, body);
          if (err) firstErr = firstErr || err;
          else sent += 1;
        }
        if (firstErr && sent === 0) {
          return json(res, firstErr === 'unknown action' ? 400 : 409, { error: firstErr });
        }
        return json(res, 200, { ok: true, sentTo: sent });
      }
      // Emergency stop for everything (also used by the page-unload beacon).
      if (req.method === 'POST' && url.pathname === '/api/all/stop') {
        for (const camera of cameras.values()) {
          if (camera.disabled) continue;
          motionGuard.noteStop(camera.ip);
          sendFullStop(camera);
        }
        log.info('all_stop', { cameras: cameras.size });
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'not found' });
    }

    // --- Optional MJPEG preview relay (viewer-initiated; see lib/stream.js) ---
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
    log.error('request_failed', { path: url.pathname, detail: err.message });
    json(res, 500, { error: err.message });
  }
});

// ---- Lifecycle ---------------------------------------------------------------

/**
 * Start the server. Used by the CLI below and by the Electron app.
 * Falls back to an OS-assigned port if the requested one is taken.
 * @returns {Promise<{server: http.Server, port: number}>}
 */
function startServer({ port = PORT, configFile } = {}) {
  if (configFile) CONFIG_FILE = configFile;
  loadConfig();
  health.setLiveMode(mode === 'live');
  return new Promise((resolve, reject) => {
    const tryListen = (p, allowFallback) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (allowFallback && err.code === 'EADDRINUSE') tryListen(0, false);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const actual = server.address().port;
        log.info('server_started', { port: actual, version: VERSION, mode });
        console.log(`\nPTZ Control running at  http://localhost:${actual}\n`);
        if (!streams.available) {
          console.log('NOTE: ffmpeg not found - camera control works fully, but the');
          console.log('      optional previews are disabled.\n');
        }
        resolve({ server, port: actual });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p);
    };
    tryListen(port, true);
  });
}

/** macOS sleep: halt any motion and pause health probes. */
function onSuspend() {
  log.info('system_suspend');
  motionGuard.stopAll();
  health.suspend();
}

/** macOS wake: revalidate control connections gently (staggered probes). */
function onResume() {
  log.info('system_resume');
  health.resume();
}

function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); writeConfigNow(); }
  motionGuard.stopAll();
  queues.closeAll();
  health.stopAll();
  streams.stopAll();
  visca.close();
}

module.exports = { startServer, shutdown, onSuspend, onResume };

if (require.main === module) {
  startServer().catch((err) => {
    console.error(`Failed to start: ${err.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
}
