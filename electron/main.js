'use strict';

const path = require('path');
const { app, BrowserWindow, Menu } = require('electron');

const APP_NAME = 'Castle Fling';
const ICON_PATH = path.join(__dirname, '..', 'assets', 'build-branding', 'icons', 'app_icon.ico');

function createWindow() {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#12100e',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.setName(APP_NAME);
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
