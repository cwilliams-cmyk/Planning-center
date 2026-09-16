'use strict';

/**
 * Electron shell for OrZ Control.
 * Runs the camera-control server in-process and shows the dashboard in its
 * own window - no browser or terminal involved.
 *
 * Non-disruption note: closing or crashing this app only ends the control
 * session. Camera video (NDI to the YoloBox Extreme or elsewhere) is never
 * owned by this process and continues independently.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, dialog, powerMonitor } = require('electron');
const { startServer, shutdown, onSuspend, onResume } = require('../server');

let win = null;
let dashboardUrl = null;

/**
 * The app was previously named "Astra PTZ Control"; its saved camera list
 * lives under that userData folder. Migrate it once so existing users keep
 * their cameras and preset names after the rename.
 */
function migrateLegacyConfig() {
  try {
    const newFile = path.join(app.getPath('userData'), 'cameras.json');
    if (fs.existsSync(newFile)) return;
    const legacyFile = path.join(app.getPath('appData'), 'Astra PTZ Control', 'cameras.json');
    if (fs.existsSync(legacyFile)) {
      fs.mkdirSync(path.dirname(newFile), { recursive: true });
      fs.copyFileSync(legacyFile, newFile);
    }
  } catch {
    /* migration is best-effort; a fresh start is the worst case */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'OrZ Control',
    backgroundColor: '#101318',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(dashboardUrl);
  // Any external link opens in the default browser, not in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  try {
    migrateLegacyConfig();
    const { port } = await startServer({
      port: 8300,
      configFile: path.join(app.getPath('userData'), 'cameras.json'),
    });
    dashboardUrl = `http://localhost:${port}`;
    createWindow();

    // macOS sleep/wake: stop any camera motion before sleeping, and
    // revalidate control connections gently (staggered) after waking.
    powerMonitor.on('suspend', () => onSuspend());
    powerMonitor.on('resume', () => onResume());
    powerMonitor.on('lock-screen', () => onSuspend());
    powerMonitor.on('unlock-screen', () => onResume());
  } catch (err) {
    dialog.showErrorBox('OrZ Control', `Could not start: ${err.message}`);
    app.quit();
  }
});

app.on('activate', () => {
  // macOS: clicking the Dock icon re-opens the window.
  if (!win && dashboardUrl) createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('quit', () => {
  shutdown();
});
