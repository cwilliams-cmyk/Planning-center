'use strict';

/* PTZ Control - dashboard client.
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
  disabled: 'Disabled by the operator. No control commands or reconnects until re-enabled in Setup mode.',
};
const STATE_SHORT = { connected: 'Connected', degraded: 'Intermittent', connecting: 'Connecting…', offline: 'Control offline', disabled: 'Disabled' };
const STATE_ICON = { connected: '●', degraded: '◐', connecting: '◌', offline: '○', disabled: '⏸' };

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
    tile.classList.toggle('disabled', cam.state === 'disabled');
    const dot = tile.querySelector('.dot');
    dot.className = `dot ${cam.state}`;
    dot.title = STATE_LABEL[cam.state] || cam.state;
    tile.querySelector('.name').textContent = cam.name;
    // Icon + text so state never depends on color alone.
    tile.querySelector('.status-text').textContent =
      `${STATE_ICON[cam.state] || ''} ${STATE_SHORT[cam.state] || cam.state}`;
    tile.querySelector('.status-text').className = `status-text ${cam.state}`;

    const overlay = tile.querySelector('.offline-note');
    overlay.hidden = cam.state !== 'offline';
    const disBtn = tile.querySelector('.disable');
    disBtn.textContent = cam.state === 'disabled' ? 'Enable' : 'Disable';
    disBtn.title = cam.state === 'disabled'
      ? 'Resume control connections to this camera'
      : 'Park this camera: no control commands or reconnect attempts until re-enabled. Video output is unaffected.';
    const freeze = tile.querySelector('.freeze-toggle input');
    if (freeze && document.activeElement !== freeze) freeze.checked = !!cam.freezeOnRecall;
    const method = tile.querySelector('.tracking-method select');
    if (method && document.activeElement !== method) method.value = cam.trackingMethod || 'visca';

    const img = tile.querySelector('img');
    const noVideo = tile.querySelector('.no-video');
    if (showPreviews && cam.state !== 'offline' && cam.state !== 'disabled') {
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
        <small>Existing NDI video output should continue independently.</small>
        <button class="retry">Retry control connection</button></span>
    </div>
    <div class="bar">
      <span class="dot"></span>
      <div class="name-block">
        <span class="name"></span>
        <span class="status-text"></span>
      </div>
      <span class="ip">${cam.ip}</span>
      <button class="rename setup-only" title="Rename camera">✎</button>
      <button class="disable setup-only">Disable</button>
      <button class="remove setup-only" title="Remove camera from this app (does not affect the camera itself)">✕</button>
    </div>
    <div class="tile-settings setup-only">
      <label class="freeze-toggle"
        title="During preset recall, hold the current frame on the camera's output so viewers don't see the physical move. The frame resumes automatically about 2.5 seconds after recall. Needs verification on your camera before relying on it in a service.">
        <input type="checkbox"> Image freeze during preset recall
      </label>
      <label class="tracking-method"
        title="Which command convention this camera uses for AI tracking on/off. If Start AI Tracking has no effect, switch to the other method and test again (Setup mode, before service).">
        Tracking command:
        <select>
          <option value="visca">Extended VISCA (default)</option>
          <option value="preset">Recall preset 80/81</option>
          <option value="custom">Custom bytes…</option>
        </select>
      </label>
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
    if (confirm(`Remove "${current.name}" (${cam.ip}) from PTZ Control?\n\nThis only removes it from this app. The camera itself, its video output, and its stored presets are not affected.`)) {
      await api(`/api/cameras/${cam.ip}`, { method: 'DELETE' });
      refresh();
    }
  });
  tile.querySelector('.retry').addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await api(`/api/cameras/${cam.ip}/retry`, { method: 'POST', body: '{}' });
    if (r.ok) toast('Retrying camera control only — video output and recording paths are not being changed.');
  });
  tile.querySelector('.disable').addEventListener('click', async (e) => {
    e.stopPropagation();
    const current = state.cameras.find((c) => c.ip === cam.ip) || cam;
    const disabling = current.state !== 'disabled';
    if (disabling && !confirm(`Disable "${current.name}" (${cam.ip})?\n\nPTZ Control will stop sending it commands and stop reconnecting until you enable it again. Its video output and saved presets are not affected.`)) return;
    await api(`/api/cameras/${cam.ip}/disable`, { method: 'POST', body: JSON.stringify({ disabled: disabling }) });
    refresh();
  });
  tile.querySelector('.freeze-toggle input').addEventListener('click', (e) => e.stopPropagation());
  tile.querySelector('.freeze-toggle input').addEventListener('change', async (e) => {
    await api(`/api/cameras/${cam.ip}`, { method: 'PATCH', body: JSON.stringify({ freezeOnRecall: e.target.checked }) });
    refresh();
  });
  tile.querySelector('.freeze-toggle').addEventListener('click', (e) => e.stopPropagation());
  const method = tile.querySelector('.tracking-method select');
  method.addEventListener('click', (e) => e.stopPropagation());
  method.addEventListener('change', async (e) => {
    const value = e.target.value;
    const patch = { trackingMethod: value };
    if (value === 'custom') {
      const current = (state.cameras.find((c) => c.ip === cam.ip) || {}).trackingCustom || {};
      const on = prompt('Tracking ON command bytes (hex, from Hollyland docs/support or a capture of the camera web UI):', current.on || '810a115402ff');
      if (!on) { refresh(); return; }
      const off = prompt('Tracking OFF command bytes (hex):', current.off || '810a115403ff');
      if (!off) { refresh(); return; }
      patch.trackingCustom = { on: on.replace(/\s/g, ''), off: off.replace(/\s/g, '') };
    }
    await api(`/api/cameras/${cam.ip}`, { method: 'PATCH', body: JSON.stringify(patch) });
    refresh();
  });
  tile.querySelector('.tracking-method').addEventListener('click', (e) => e.stopPropagation());
  return tile;
}

function renderTarget() {
  const cam = selectedCamera();
  $('#target-name').textContent = state.all
    ? `ALL (${state.cameras.length} cameras)`
    : cam ? cam.name : '—';
  const statusEl = $('#target-status');
  if (state.all || !cam) {
    statusEl.textContent = state.all ? 'Commands go to every enabled camera.' : '';
    statusEl.className = 'target-status';
  } else {
    let line = `${cam.ip} · ${STATE_LABEL[cam.state] || cam.state}`;
    if (cam.state === 'connected' && cam.lastSeen) {
      const age = Math.max(0, Math.round((Date.now() - cam.lastSeen) / 1000));
      line += ` · last control response ${age}s ago`;
    }
    statusEl.textContent = line;
    statusEl.className = `target-status ${cam.state}`;
  }
  // focus mode indicator for the selected camera
  const fm = (cam && state.focusModes[cam.ip]) || 'auto';
  $('#btn-af').setAttribute('aria-pressed', fm === 'auto');
  $('#btn-mf').setAttribute('aria-pressed', fm === 'manual');
  $('#mf-warning').hidden = fm !== 'manual';
  renderTracking(cam);
}

function trackingOn(cam) {
  return !!(cam && cam.tracking === true);
}

function renderTracking(cam) {
  const stateEl = $('#tracking-state');
  const btn = $('#btn-track-toggle');
  const banner = $('#tracking-banner');
  if (!cam || state.all) {
    stateEl.textContent = '—';
    btn.disabled = true;
    banner.hidden = true;
    document.body.classList.remove('tracking-active');
    return;
  }
  btn.disabled = false;
  if (cam.tracking === true) {
    stateEl.textContent = 'Tracking Active';
    btn.textContent = 'Stop Tracking & Take Manual Control';
    banner.hidden = false;
    document.body.classList.add('tracking-active');
  } else {
    // false = we turned it off; null = unknown (could have been toggled from
    // the camera's own remote/web UI - there is no way to read it back).
    stateEl.textContent = cam.tracking === false ? 'Off' : 'Off (as last known)';
    btn.textContent = 'Start AI Tracking';
    banner.hidden = true;
    document.body.classList.remove('tracking-active');
  }
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
    () => {
      if (trackingOn(selectedCamera()) && !state.all) {
        toast('Manual pan/tilt is unavailable while AI Tracking is active. Stop tracking to take manual control.');
        return;
      }
      sendPTZ({ action: 'move', dir: btn.dataset.dir });
    },
    () => sendPTZ({ action: 'stop' }));
}
$('#btn-home').addEventListener('click', () => {
  if (trackingOn(selectedCamera()) && !state.all) {
    toast('Manual pan/tilt is unavailable while AI Tracking is active. Stop tracking to take manual control.');
    return;
  }
  sendPTZ({ action: 'home' });
});

$('#btn-track-toggle').addEventListener('click', async () => {
  const cam = selectedCamera();
  if (!cam || state.all) return;
  const turnOn = !trackingOn(cam);
  sendPTZ({ action: 'tracking', on: turnOn });
  toast(turnOn
    ? `AI Tracking requested on ${cam.name}. If the camera doesn't start tracking, switch the tracking command method in Setup mode.`
    : `Tracking stop requested — ${cam.name} is back under manual control.`, 4000);
  // Optimistic update; the next refresh confirms from the server.
  cam.tracking = turnOn;
  renderTracking(cam);
});

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

// Speed: Slow / Normal / Fast, plus an advanced exact value (Setup mode)
for (const btn of $$('.speed-btn')) {
  btn.addEventListener('click', () => {
    state.speed = Number(btn.dataset.speed);
    for (const b of $$('.speed-btn')) b.setAttribute('aria-pressed', b === btn);
    $('#speed-custom').value = '';
  });
}
$('#speed-custom').addEventListener('change', (e) => {
  const v = Math.max(1, Math.min(24, Number(e.target.value) || 12));
  e.target.value = v;
  state.speed = v;
  for (const b of $$('.speed-btn')) b.setAttribute('aria-pressed', 'false');
});

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

function presetOrder(cam) {
  const order = cam && Array.isArray(cam.presetOrder) ? cam.presetOrder : null;
  return order && order.length === 9 ? order : [1, 2, 3, 4, 5, 6, 7, 8, 9];
}

function renderPresets() {
  const cam = selectedCamera();
  const editMode = $('#preset-edit-mode').checked && state.mode === 'setup';
  presetGrid.classList.toggle('edit-mode', editMode);
  $('#preset-hint').textContent = editMode
    ? 'Edit mode: click a preset to save the camera’s current position into it; ✎ renames, ◀ ▶ reorder.'
    : 'Click a preset to recall it. Keyboard: 1–9.';
  presetGrid.innerHTML = '';
  const order = presetOrder(cam);
  order.forEach((slot, pos) => {
    const name = presetName(cam, String(slot));
    const wrap = document.createElement('div');
    wrap.className = 'preset';
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.innerHTML = `<span class="num">${slot}</span><span class="pname">${name ? escapeHtml(name) : '—'}</span>`;
    btn.setAttribute('aria-label', name ? `Preset ${slot}: ${name}` : `Preset ${slot}`);
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
      const mkMove = (delta, glyph) => {
        const b = document.createElement('button');
        b.className = `preset-move ${delta < 0 ? 'left' : 'right'}`;
        b.textContent = glyph;
        b.title = 'Change this preset’s position in the grid (layout only)';
        b.addEventListener('click', () => movePreset(pos, delta));
        return b;
      };
      if (pos > 0) wrap.appendChild(mkMove(-1, '◀'));
      if (pos < order.length - 1) wrap.appendChild(mkMove(1, '▶'));
    }
    presetGrid.appendChild(wrap);
  });
}

async function movePreset(pos, delta) {
  const cam = selectedCamera();
  if (!cam) return;
  const order = [...presetOrder(cam)];
  const j = pos + delta;
  if (j < 0 || j >= order.length) return;
  [order[pos], order[j]] = [order[j], order[pos]];
  await api(`/api/cameras/${cam.ip}/preset-order`, { method: 'PUT', body: JSON.stringify({ order }) });
  refresh();
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
  if (!state.all && cam && cam.state === 'disabled') {
    toast(`${cam.name} is disabled. Enable it in Setup mode to control it.`, 4500);
    return;
  }
  if (!state.all && trackingOn(cam)) {
    const label = presetName(cam, String(slot)) || `preset ${slot}`;
    if (!confirm(`${cam.name} is AI Tracking. Stop tracking and recall ${label}?`)) return;
    sendPTZ({ action: 'tracking', on: false });
    cam.tracking = false;
    renderTracking(cam);
  }
  sendPTZ({ action: 'preset', mode: 'recall', slot });
  // Honest wording: over UDP we cannot positively verify completion, so
  // this reports the request, not a confirmed camera position.
  const name = presetName(cam, String(slot));
  toast(`Recall requested: ${name || `preset ${slot}`}`, 1800);
  const pos = presetOrder(cam).indexOf(slot);
  const btn = presetGrid.children[pos] && presetGrid.children[pos].querySelector('.preset-btn');
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
    if (trackingOn(selectedCamera()) && !state.all) {
      if (heldKeys.size === 0) {
        toast('Manual pan/tilt is unavailable while AI Tracking is active. Stop tracking to take manual control.');
      }
      return;
    }
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
    <p>PTZ Control ${escapeHtml(String(data.version || ''))} ·
       Mode: <b>${data.mode === 'live' ? 'Live Control' : 'Setup'}</b></p>
    <ul>${(data.cameras || []).map((c) =>
      `<li><b>${escapeHtml(c.name)}</b> (${c.ip}) — ${escapeHtml(STATE_SHORT[c.state] || c.state)}
        <br><small>${escapeHtml(c.nextStep || '')}</small></li>`).join('')}</ul>`;
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
