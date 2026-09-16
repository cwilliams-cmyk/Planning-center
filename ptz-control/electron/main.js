'use strict';

/**
 * Electron shell for Astra PTZ Control.
 * Runs the camera server in-process and shows the dashboard in its own
 * window - no browser or terminal involved.
 */

const path = require('path');
const { app, BrowserWindow, shell, dialog } = require('electron');
const { startServer, shutdown } = require('../server');

let win = null;
let dashboardUrl = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Astra PTZ Control',
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
    // Keep the camera list in the OS-standard app-data folder so it
    // survives app updates.
    const { port } = await startServer({
      port: 8300,
      autoscan: true,
      configFile: path.join(app.getPath('userData'), 'cameras.json'),
    });
    dashboardUrl = `http://localhost:${port}`;
    createWindow();
  } catch (err) {
    dialog.showErrorBox('Astra PTZ Control', `Could not start: ${err.message}`);
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
