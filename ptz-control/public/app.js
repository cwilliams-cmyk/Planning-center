'use strict';

/* OrZ Control - dashboard client.
 *
 * Everything here issues camera-CONTROL requests only. Video previews are
 * optional pull-only streams; NDI video output to recorders/switchers is
 * never touched by anything in this file.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const KEEPALIVE_MS = 400; // re-send held movement so the server watchdog knows we're alive

const STATE_LABEL = {
  connected: 'Connected',
  degraded: 'Intermittent connection — control may lag. Video output is not affected.',
  connecting: 'Connecting to camera controls…',
  offline: 'Camera control offline. Existing NDI video output should continue independently.',
};
const STATE_SHORT = { connected: 'Connected', degraded: 'Intermittent', connecting: 'Connecting…', offline: 'Control offline' };

const PRESET_EXAMPLES = 'Wide Stage, Pulpit, Worship Leader, Keys, Drums, Baptism, Congregation, Sermon Two-Shot';

const state = {
  cameras: [],
  selected: null,
  all: false,
  mode: 'live',
  locked: false,
  ffmpeg: true,
  speed: 12,
  focusModes: {}, // ip -> 'auto' | 'manual' (last mode we set; cameras default to auto)
  streamsStarted: new Set(),
};

function previewsEnabled() {
  const key = `previews-${state.mode}`;
  const saved = localStorage.getItem(key);
  if (saved !== null) return saved === '1';
  return state.mode === 'setup'; // default: on in Setup, off in Live
}
function setPreviewsEnabled(on) {
  localStorage.setItem(`previews-${state.mode}`, on ? '1' : '0');
}

// ---- Toast + API helpers -----------------------------------------------------

let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error) toast(data.error, 5000);
  return data;
}

function sendPTZ(body) {
  if (state.locked) return;
  const target = state.all ? '/api/all/ptz' : state.selected && `/api/camera/${state.selected}/ptz`;
  if (!target) return;
  fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speed: state.speed, ...body }),
  }).then(async (res) => {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.error) toast(data.error, 5000);
    }
  }).catch(() => {});
}

function selectedCamera() {
  return state.cameras.find((c) => c.ip === state.selected);
}

// ---- Refresh loop ------------------------------------------------------------

async function refresh() {
  let data;
  try {
    data = await api('/api/cameras');
  } catch {
    return; // server briefly unreachable; keep last known state
  }
  state.cameras = data.cameras;
  state.ffmpeg = data.ffmpeg;
  if (data.mode !== state.mode) applyMode(data.mode, false);
  $('#scan-status').textContent = data.scanning ? 'scanning…' : '';
  $('#ffmpeg-hint').hidden = data.ffmpeg;
  $('#empty-hint').hidden = data.cameras.length > 0;

  if (!state.selected && data.cameras.length) state.selected = data.cameras[0].ip;
  if (state.selected && !data.cameras.some((c) => c.ip === state.selected)) {
    state.selected = data.cameras.length ? data.cameras[0].ip : null;
  }
  renderGrid();
  renderTarget();
  renderPresets();
}

// ---- Multiview grid ----------------------------------------------------------

function renderGrid() {
  const grid = $('#grid');
  const seen = new Set();
  const showPreviews = state.ffmpeg && previewsEnabled();

  for (const cam of state.cameras) {
    seen.add(cam.ip);
    let tile = grid.querySelector(`[data-ip="${cam.ip}"]`);
    if (!tile) {
      tile = buildTile(cam);
      grid.appendChild(tile);
    }
    tile.classList.toggle('selected', cam.ip === state.selected);
    const dot = tile.querySelector('.dot');
    dot.className = `dot ${cam.state}`;
    dot.title = STATE_LABEL[cam.state] || cam.state;
    tile.querySelector('.name').textContent = cam.name;
    tile.querySelector('.status-text').textContent = STATE_SHORT[cam.state] || cam.state;
    tile.querySelector('.status-text').className = `status-text ${cam.state}`;

    const overlay = tile.querySelector('.offline-note');
    overlay.hidden = cam.state !== 'offline';

    const img = tile.querySelector('img');
    const noVideo = tile.querySelector('.no-video');
    if (showPreviews && cam.state !== 'offline') {
      if (!state.streamsStarted.has(cam.ip)) {
        state.streamsStarted.add(cam.ip);
        img.src = `/stream/${cam.ip}`;
        img.hidden = false;
        noVideo.hidden = true;
      }
    } else if (state.streamsStarted.has(cam.ip)) {
      state.streamsStarted.delete(cam.ip);
      img.hidden = true;
      img.removeAttribute('src');
      noVideo.hidden = false;
      noVideo.textContent = showPreviews ? 'connecting…' : 'Preview off';
    } else {
      noVideo.textContent = state.ffmpeg
        ? (showPreviews ? 'connecting…' : 'Preview off')
        : 'Preview unavailable (ffmpeg missing) — control unaffected';
    }
  }

  for (const tile of [...grid.children]) {
    if (!seen.has(tile.dataset.ip)) {
      state.streamsStarted.delete(tile.dataset.ip);
      tile.remove();
    }
  }
}

function buildTile(cam) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.ip = cam.ip;
  tile.innerHTML = `
    <div class="video">
      <span class="no-video">Preview off</span>
      <img alt="" hidden>
      <span class="offline-note" hidden>Camera control offline.<br>
        <small>Existing NDI video output should continue independently.</small></span>
    </div>
    <div class="bar">
      <span class="dot"></span>
      <div class="name-block">
        <span class="name"></span>
        <span class="status-text"></span>
      </div>
      <span class="ip">${cam.ip}</span>
      <button class="rename setup-only" title="Rename camera">✎</button>
      <button class="remove setup-only" title="Remove camera from this app (does not affect the camera itself)">✕</button>
    </div>`;

  tile.addEventListener('click', () => {
    state.selected = cam.ip;
    renderGrid();
    renderTarget();
    renderPresets();
  });
  tile.querySelector('img').addEventListener('error', () => {
    state.streamsStarted.delete(cam.ip);
    const img = tile.querySelector('img');
    img.hidden = true;
    img.removeAttribute('src');
    tile.querySelector('.no-video').hidden = false;
  });
  tile.querySelector('.rename').addEventListener('click', async (e) => {
    e.stopPropagation();
    const current = state.cameras.find((c) => c.ip === cam.ip);
    const name = prompt('Camera name:', current ? current.name : cam.ip);
    if (name) { await api(`/api/cameras/${cam.ip}`, { method: 'PATCH', body: JSON.stringify({ name }) }); refresh(); }
  });
  tile.querySelector('.remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    const current = state.cameras.find((c) => c.ip === cam.ip) || cam;
    if (confirm(`Remove "${current.name}" (${cam.ip}) from OrZ Control?\n\nThis only removes it from this app. The camera itself, its video output, and its stored presets are not affected.`)) {
      await api(`/api/cameras/${cam.ip}`, { method: 'DELETE' });
      refresh();
    }
  });
  return tile;
}

function renderTarget() {
  const cam = selectedCamera();
  $('#target-name').textContent = state.all
    ? `ALL (${state.cameras.length} cameras)`
    : cam ? cam.name : '—';
  const statusEl = $('#target-status');
  if (state.all || !cam) {
    statusEl.textContent = state.all ? 'Commands go to every camera.' : '';
    statusEl.className = 'target-status';
  } else {
    statusEl.textContent = `${cam.ip} · ${STATE_LABEL[cam.state] || cam.state}`;
    statusEl.className = `target-status ${cam.state}`;
  }
  // focus mode indicator for the selected camera
  const fm = (cam && state.focusModes[cam.ip]) || 'auto';
  $('#btn-af').setAttribute('aria-pressed', fm === 'auto');
  $('#btn-mf').setAttribute('aria-pressed', fm === 'manual');
  $('#mf-warning').hidden = fm !== 'manual';
}

// ---- Operating mode / lock ----------------------------------------------------

async function applyMode(next, tellServer = true) {
  if (tellServer) {
    const data = await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode: next }) });
    next = data.mode || next;
  }
  state.mode = next;
  document.body.classList.toggle('mode-setup', next === 'setup');
  $('#mode-live').setAttribute('aria-pressed', next === 'live');
  $('#mode-setup').setAttribute('aria-pressed', next === 'setup');
  $('#mode-note').textContent = next === 'live'
    ? 'Live Control mode sends camera-control commands only. It does not modify NDI video settings or recording connections.'
    : 'Setup mode — for pre-service configuration. Advanced settings can affect live video. Use only before service and after confirming recording is not active.';
  $('#mode-note').classList.toggle('setup', next === 'setup');
  if (next === 'live' && $('#preset-edit-mode').checked) {
    $('#preset-edit-mode').checked = false;
  }
  $('#preview-toggle').checked = previewsEnabled();
  renderGrid();
  renderPresets();
}

$('#mode-live').addEventListener('click', () => applyMode('live'));
$('#mode-setup').addEventListener('click', () => applyMode('setup'));

$('#btn-lock').addEventListener('click', () => {
  state.locked = !state.locked;
  document.body.classList.toggle('locked', state.locked);
  $('#btn-lock').textContent = state.locked ? '🔒 Unlock' : '🔓 Lock';
  $('#lock-banner').hidden = !state.locked;
  if (state.locked) sendBeaconStop(); // make sure nothing keeps moving
});

$('#preview-toggle').addEventListener('change', (e) => {
  setPreviewsEnabled(e.target.checked);
  renderGrid();
});

// ---- Hold-to-move controls -----------------------------------------------------

/**
 * Press = send movement (and keep re-sending as a keepalive while held);
 * release/cancel = send stop. The server coalesces the keepalives and has a
 * dead-man watchdog in case we vanish mid-hold.
 */
function bindHold(el, start, stop) {
  let timer = null;
  let active = false;
  const down = (e) => {
    if (state.locked) return;
    e.preventDefault();
    if (el.setPointerCapture && e.pointerId !== undefined) {
      try { el.setPointerCapture(e.pointerId); } catch {}
    }
    active = true;
    el.classList.add('pressed');
    start();
    timer = setInterval(start, KEEPALIVE_MS);
  };
  const up = () => {
    if (!active) return;
    active = false;
    el.classList.remove('pressed');
    clearInterval(timer);
    timer = null;
    stop();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

for (const btn of $$('.dpad [data-dir]')) {
  bindHold(btn,
    () => sendPTZ({ action: 'move', dir: btn.dataset.dir }),
    () => sendPTZ({ action: 'stop' }));
}
$('#btn-home').addEventListener('click', () => sendPTZ({ action: 'home' }));

for (const btn of $$('[data-zoom]')) {
  bindHold(btn,
    () => sendPTZ({ action: 'zoom', dir: btn.dataset.zoom }),
    () => sendPTZ({ action: 'zoom', dir: 'stop' }));
}
for (const btn of $$('[data-focus]')) {
  bindHold(btn,
    () => {
      const cam = selectedCamera();
      if (cam && (state.focusModes[cam.ip] || 'auto') === 'auto') {
        toast('Switch Focus mode to Manual to adjust focus by hand.');
        return;
      }
      sendPTZ({ action: 'focus', dir: btn.dataset.focus });
    },
    () => sendPTZ({ action: 'focus', dir: 'stop' }));
}

$('#btn-af').addEventListener('click', () => {
  const cam = selectedCamera();
  if (!cam) return;
  sendPTZ({ action: 'autofocus', on: true });
  state.focusModes[cam.ip] = 'auto';
  renderTarget();
});
$('#btn-mf').addEventListener('click', () => {
  const cam = selectedCamera();
  if (!cam) return;
  sendPTZ({ action: 'autofocus', on: false });
  state.focusModes[cam.ip] = 'manual';
  renderTarget();
});

// Speed: Slow / Normal / Fast
for (const btn of $$('.speed-btn')) {
  btn.addEventListener('click', () => {
    state.speed = Number(btn.dataset.speed);
    for (const b of $$('.speed-btn')) b.setAttribute('aria-pressed', b === btn);
  });
}

$('#all-toggle').addEventListener('change', (e) => {
  state.all = e.target.checked;
  renderTarget();
});

/** Image commands aimed at ALL cameras get an explicit confirmation. */
function confirmAllImage() {
  if (!state.all) return true;
  return confirm('Apply this image adjustment to ALL cameras at once?\n\nThis changes the picture on every live output simultaneously.');
}

// ---- Presets -------------------------------------------------------------------

const presetGrid = $('#preset-grid');

function presetName(cam, slot) {
  return cam && cam.presets && cam.presets[slot] && cam.presets[slot].name;
}

function renderPresets() {
  const cam = selectedCamera();
  const editMode = $('#preset-edit-mode').checked && state.mode === 'setup';
  presetGrid.classList.toggle('edit-mode', editMode);
  $('#preset-hint').textContent = editMode
    ? 'Edit mode: click a preset to save the camera’s current position into it; ✎ renames.'
    : 'Click a preset to recall it. Keyboard: 1–9.';
  presetGrid.innerHTML = '';
  for (let slot = 1; slot <= 9; slot++) {
    const name = presetName(cam, String(slot));
    const wrap = document.createElement('div');
    wrap.className = 'preset';
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.innerHTML = `<span class="num">${slot}</span><span class="pname">${name ? escapeHtml(name) : '—'}</span>`;
    btn.title = editMode
      ? `Save current position to preset ${slot}`
      : name ? `Recall "${name}"` : `Recall preset ${slot}`;
    btn.addEventListener('click', () => (editMode ? savePreset(slot) : recallPreset(slot)));
    wrap.appendChild(btn);
    if (editMode) {
      const rn = document.createElement('button');
      rn.className = 'preset-rename';
      rn.textContent = '✎';
      rn.title = `Rename preset ${slot}`;
      rn.addEventListener('click', () => renamePreset(slot));
      wrap.appendChild(rn);
    }
    presetGrid.appendChild(wrap);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function recallPreset(slot) {
  if (state.locked) return;
  const cam = selectedCamera();
  if (!state.all && cam && cam.state === 'offline') {
    toast('Camera control is offline — preset not sent. NDI video output is unaffected.', 4500);
    return;
  }
  sendPTZ({ action: 'preset', mode: 'recall', slot });
  const idx = slot - 1;
  const btn = presetGrid.children[idx] && presetGrid.children[idx].querySelector('.preset-btn');
  if (btn) {
    btn.classList.add('recalling');
    setTimeout(() => btn.classList.remove('recalling'), 900);
  }
}

async function savePreset(slot) {
  const cam = selectedCamera();
  if (!cam) return;
  const existing = presetName(cam, String(slot));
  const label = existing ? `"${existing}"` : `preset ${slot}`;
  if (!confirm(`Save ${cam.name}'s CURRENT position into ${label}?\n\nThis replaces the position stored in that preset.`)) return;
  sendPTZ({ action: 'preset', mode: 'set', slot });
  if (!existing) {
    const name = prompt(`Name this preset (optional).\nExamples: ${PRESET_EXAMPLES}`, '');
    if (name) await api(`/api/cameras/${cam.ip}/presets/${slot}`, { method: 'PUT', body: JSON.stringify({ name }) });
  }
  toast(`Preset ${slot} saved for ${cam.name}.`);
  refresh();
}

async function renamePreset(slot) {
  const cam = selectedCamera();
  if (!cam) return;
  const current = presetName(cam, String(slot)) || '';
  const name = prompt(`Preset ${slot} name (empty to clear the label).\nExamples: ${PRESET_EXAMPLES}`, current);
  if (name === null) return;
  await api(`/api/cameras/${cam.ip}/presets/${slot}`, { method: 'PUT', body: JSON.stringify({ name }) });
  refresh();
}

$('#preset-edit-mode').addEventListener('change', renderPresets);

// ---- Image / exposure controls -------------------------------------------------

$('#exposure-mode').addEventListener('change', (e) => {
  if (!confirmAllImage()) { refresh(); return; }
  sendPTZ({ action: 'exposureMode', mode: e.target.value });
});
for (const group of $$('.steppers')) {
  for (const btn of group.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      if (!confirmAllImage()) return;
      sendPTZ({ action: 'image', what: group.dataset.what, dir: btn.dataset.step });
    });
  }
}
$('#wb-mode').addEventListener('change', (e) => {
  if (!confirmAllImage()) { refresh(); return; }
  sendPTZ({ action: 'wb', mode: e.target.value });
});
$('#backlight').addEventListener('change', (e) => {
  if (!confirmAllImage()) { e.target.checked = !e.target.checked; return; }
  sendPTZ({ action: 'backlight', on: e.target.checked });
});

// ---- Keyboard control ----------------------------------------------------------

const keyDirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const heldKeys = new Set();
let keyMoveTimer = null;
let keyZoomTimer = null;

function currentKeyDir() {
  const dirs = [...heldKeys].map((k) => keyDirs[k]);
  const vert = dirs.find((d) => d === 'up' || d === 'down') || '';
  const horiz = dirs.find((d) => d === 'left' || d === 'right') || '';
  return vert + horiz || dirs[0];
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.repeat) return;
  if (keyDirs[e.key]) {
    e.preventDefault();
    heldKeys.add(e.key);
    const send = () => sendPTZ({ action: 'move', dir: currentKeyDir() });
    send();
    clearInterval(keyMoveTimer);
    keyMoveTimer = setInterval(send, KEEPALIVE_MS);
  } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
    const dir = e.key === '+' || e.key === '=' ? 'tele' : 'wide';
    const send = () => sendPTZ({ action: 'zoom', dir });
    send();
    clearInterval(keyZoomTimer);
    keyZoomTimer = setInterval(send, KEEPALIVE_MS);
  } else if (e.key.toLowerCase() === 'h') {
    sendPTZ({ action: 'home' });
  } else if (e.key === ' ') {
    e.preventDefault();
    sendBeaconStop();
    toast('Stop sent to all cameras.');
  } else if (/^[1-9]$/.test(e.key)) {
    recallPreset(Number(e.key));
  }
});
document.addEventListener('keyup', (e) => {
  if (keyDirs[e.key]) {
    heldKeys.delete(e.key);
    if (heldKeys.size === 0) {
      clearInterval(keyMoveTimer);
      keyMoveTimer = null;
      sendPTZ({ action: 'stop' });
    } else {
      sendPTZ({ action: 'move', dir: currentKeyDir() });
    }
  } else if (['+', '=', '-', '_'].includes(e.key)) {
    clearInterval(keyZoomTimer);
    keyZoomTimer = null;
    sendPTZ({ action: 'zoom', dir: 'stop' });
  }
});

// Window loses focus mid-hold (cmd-tab, notification click): stop everything.
window.addEventListener('blur', () => {
  heldKeys.clear();
  clearInterval(keyMoveTimer); keyMoveTimer = null;
  clearInterval(keyZoomTimer); keyZoomTimer = null;
  sendPTZ({ action: 'stop' });
  sendPTZ({ action: 'zoom', dir: 'stop' });
});

/** Last-resort stop for page unload; the server watchdog is the backstop. */
function sendBeaconStop() {
  try { navigator.sendBeacon('/api/all/stop', '{}'); } catch {}
}
window.addEventListener('pagehide', sendBeaconStop);

// ---- Header actions ------------------------------------------------------------

$('#btn-scan').addEventListener('click', async () => {
  $('#scan-status').textContent = 'scanning…';
  await api('/api/scan', { method: 'POST', body: '{}' });
  $('#scan-status').textContent = '';
  refresh();
});

$('#btn-add').addEventListener('click', async () => {
  const ip = prompt('Camera IP address (Astra factory default is 192.168.1.100):');
  if (!ip) return;
  const result = await api('/api/cameras', { method: 'POST', body: JSON.stringify({ ip: ip.trim() }) });
  if (result.camera) toast(`Added ${result.camera.name} (${result.camera.ip}). Connecting…`);
  refresh();
});

// ---- Diagnostics ---------------------------------------------------------------

let diagText = '';
$('#btn-diag').addEventListener('click', async () => {
  const data = await api('/api/diagnostics');
  diagText = data.text || '';
  $('#diag-summary').innerHTML = `
    <p>OrZ Control ${escapeHtml(String(data.version || ''))} ·
       Mode: <b>${data.mode === 'live' ? 'Live Control' : 'Setup'}</b></p>
    <ul>${(data.cameras || []).map((c) =>
      `<li><b>${escapeHtml(c.name)}</b> (${c.ip}) — ${escapeHtml(STATE_SHORT[c.state] || c.state)}</li>`).join('')}</ul>`;
  $('#diag-log').textContent = (data.log || [])
    .map((e) => {
      const { ts, level, event, ...rest } = e;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      return `${ts.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${event}${extra}`;
    })
    .join('\n') || 'No events yet.';
  $('#diag-overlay').hidden = false;
  $('#diag-log').scrollTop = $('#diag-log').scrollHeight;
});
$('#diag-close').addEventListener('click', () => { $('#diag-overlay').hidden = true; });
$('#diag-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'diag-overlay') $('#diag-overlay').hidden = true;
});
$('#diag-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagText);
    toast('Support info copied to the clipboard.');
  } catch {
    toast('Could not access the clipboard.');
  }
});

// ---- Boot ----------------------------------------------------------------------

applyMode('live', false);
refresh();
setInterval(refresh, 4000);
