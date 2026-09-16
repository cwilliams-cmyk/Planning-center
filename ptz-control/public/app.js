'use strict';

/* Astra PTZ Control - dashboard client */

const $ = (sel) => document.querySelector(sel);

const state = {
  cameras: [],
  selected: null, // ip of the selected camera
  all: false, // broadcast mode
  ffmpeg: true,
  streamsStarted: new Set(), // ips whose <img> already points at /stream/
};

// ---- API helpers -----------------------------------------------------------

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json();
}

function sendPTZ(body) {
  const target = state.all ? '/api/all/ptz' : state.selected && `/api/camera/${state.selected}/ptz`;
  if (!target) return;
  fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speed: Number($('#speed').value), ...body }),
  }).catch(() => {});
}

// ---- Camera list / multiview ----------------------------------------------

async function refresh() {
  let data;
  try {
    data = await api('/api/cameras');
  } catch {
    return; // server briefly unreachable; keep last known state
  }
  state.cameras = data.cameras;
  state.ffmpeg = data.ffmpeg;
  $('#scan-status').textContent = data.scanning ? 'scanning…' : '';
  $('#ffmpeg-hint').hidden = data.ffmpeg;
  $('#empty-hint').hidden = data.cameras.length > 0;

  if (!state.selected && data.cameras.length) state.selected = data.cameras[0].ip;
  if (state.selected && !data.cameras.some((c) => c.ip === state.selected)) {
    state.selected = data.cameras.length ? data.cameras[0].ip : null;
  }
  renderGrid();
  renderTarget();
}

function renderGrid() {
  const grid = $('#grid');
  const seen = new Set();

  for (const cam of state.cameras) {
    seen.add(cam.ip);
    let tile = grid.querySelector(`[data-ip="${cam.ip}"]`);
    if (!tile) {
      tile = buildTile(cam);
      grid.appendChild(tile);
    }
    // update dynamic bits
    tile.classList.toggle('selected', cam.ip === state.selected);
    tile.querySelector('.dot').classList.toggle('online', cam.online);
    tile.querySelector('.name').textContent = cam.name;
    tile.querySelector('.offline-note').hidden = cam.online || !state.ffmpeg;

    const img = tile.querySelector('img');
    if (state.ffmpeg && cam.online && !state.streamsStarted.has(cam.ip)) {
      state.streamsStarted.add(cam.ip);
      img.src = `/stream/${cam.ip}`;
      img.hidden = false;
      tile.querySelector('.no-video').hidden = true;
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
      <span class="no-video">${state.ffmpeg ? 'connecting…' : 'no video (ffmpeg missing)'}</span>
      <img alt="" hidden>
      <span class="offline-note" hidden>offline</span>
    </div>
    <div class="bar">
      <span class="dot"></span>
      <span class="name"></span>
      <span class="ip">${cam.ip}</span>
      <button class="rename" title="Rename">✎</button>
      <button class="remove" title="Remove camera">✕</button>
    </div>`;

  tile.addEventListener('click', () => {
    state.selected = cam.ip;
    renderGrid();
    renderTarget();
  });
  tile.querySelector('img').addEventListener('error', () => {
    // relay dropped; allow a restart on next refresh
    state.streamsStarted.delete(cam.ip);
    const img = tile.querySelector('img');
    img.hidden = true;
    img.removeAttribute('src');
    tile.querySelector('.no-video').hidden = false;
  });
  tile.querySelector('.rename').addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = prompt('Camera name:', cam.name);
    if (name) { await api(`/api/cameras/${cam.ip}`, { method: 'PATCH', body: JSON.stringify({ name }) }); refresh(); }
  });
  tile.querySelector('.remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`Remove ${cam.name} (${cam.ip})?`)) {
      await api(`/api/cameras/${cam.ip}`, { method: 'DELETE' });
      refresh();
    }
  });
  return tile;
}

function renderTarget() {
  const cam = state.cameras.find((c) => c.ip === state.selected);
  $('#target-name').textContent = state.all
    ? `ALL (${state.cameras.length} cameras)`
    : cam ? `${cam.name} · ${cam.ip}` : '—';
}

// ---- Control bindings ------------------------------------------------------

/** Hold-to-move: press sends the command, release sends stop. */
function bindHold(el, start, stop) {
  const down = (e) => { e.preventDefault(); el.classList.add('pressed'); start(); };
  const up = () => { el.classList.remove('pressed'); stop(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

for (const btn of document.querySelectorAll('.dpad [data-dir]')) {
  bindHold(btn,
    () => sendPTZ({ action: 'move', dir: btn.dataset.dir }),
    () => sendPTZ({ action: 'stop' }));
}
$('#btn-home').addEventListener('click', () => sendPTZ({ action: 'home' }));

for (const btn of document.querySelectorAll('[data-zoom]')) {
  bindHold(btn,
    () => sendPTZ({ action: 'zoom', dir: btn.dataset.zoom }),
    () => sendPTZ({ action: 'zoom', dir: 'stop' }));
}
for (const btn of document.querySelectorAll('[data-focus]')) {
  bindHold(btn,
    () => sendPTZ({ action: 'focus', dir: btn.dataset.focus }),
    () => sendPTZ({ action: 'focus', dir: 'stop' }));
}
$('#btn-af').addEventListener('click', () => sendPTZ({ action: 'autofocus', on: true }));

$('#speed').addEventListener('input', () => { $('#speed-val').textContent = $('#speed').value; });

$('#all-toggle').addEventListener('change', (e) => {
  state.all = e.target.checked;
  renderTarget();
});

// Presets 1-9
const presetGrid = $('#preset-grid');
for (let slot = 1; slot <= 9; slot++) {
  const btn = document.createElement('button');
  btn.textContent = slot;
  btn.addEventListener('click', () => {
    const setMode = $('#preset-set-mode').checked;
    sendPTZ({ action: 'preset', mode: setMode ? 'set' : 'recall', slot });
    if (setMode) {
      $('#preset-set-mode').checked = false;
      presetGrid.classList.remove('set-mode');
    }
  });
  presetGrid.appendChild(btn);
}
$('#preset-set-mode').addEventListener('change', (e) => {
  presetGrid.classList.toggle('set-mode', e.target.checked);
});

// ---- Image / exposure controls ----------------------------------------------

$('#exposure-mode').addEventListener('change', (e) => {
  sendPTZ({ action: 'exposureMode', mode: e.target.value });
});
for (const group of document.querySelectorAll('.steppers')) {
  for (const btn of group.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      sendPTZ({ action: 'image', what: group.dataset.what, dir: btn.dataset.step });
    });
  }
}
$('#wb-mode').addEventListener('change', (e) => {
  sendPTZ({ action: 'wb', mode: e.target.value });
});
$('#backlight').addEventListener('change', (e) => {
  sendPTZ({ action: 'backlight', on: e.target.checked });
});

// ---- Keyboard control ------------------------------------------------------

const keyDirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const heldKeys = new Set();

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.repeat) return;
  if (keyDirs[e.key]) {
    e.preventDefault();
    heldKeys.add(e.key);
    const dirs = [...heldKeys].map((k) => keyDirs[k]);
    const vert = dirs.find((d) => d === 'up' || d === 'down') || '';
    const horiz = dirs.find((d) => d === 'left' || d === 'right') || '';
    sendPTZ({ action: 'move', dir: vert + horiz || dirs[0] });
  } else if (e.key === '+' || e.key === '=') {
    sendPTZ({ action: 'zoom', dir: 'tele' });
  } else if (e.key === '-' || e.key === '_') {
    sendPTZ({ action: 'zoom', dir: 'wide' });
  } else if (e.key.toLowerCase() === 'h') {
    sendPTZ({ action: 'home' });
  } else if (/^[1-9]$/.test(e.key)) {
    sendPTZ({ action: 'preset', mode: 'recall', slot: Number(e.key) });
  }
});
document.addEventListener('keyup', (e) => {
  if (keyDirs[e.key]) {
    heldKeys.delete(e.key);
    if (heldKeys.size === 0) sendPTZ({ action: 'stop' });
  } else if (['+', '=', '-', '_'].includes(e.key)) {
    sendPTZ({ action: 'zoom', dir: 'stop' });
  }
});

// ---- Header actions --------------------------------------------------------

$('#btn-scan').addEventListener('click', async () => {
  $('#scan-status').textContent = 'scanning…';
  await api('/api/scan', { method: 'POST', body: '{}' });
  refresh();
});

$('#btn-add').addEventListener('click', async () => {
  const ip = prompt('Camera IP address (Astra default is 192.168.1.100):');
  if (!ip) return;
  const result = await api('/api/cameras', { method: 'POST', body: JSON.stringify({ ip: ip.trim() }) });
  if (result.error) alert(result.error);
  refresh();
});

// ---- Boot ------------------------------------------------------------------

refresh();
setInterval(refresh, 4000);
