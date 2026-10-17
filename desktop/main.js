/**
 * Silent Stage AI - Native Desktop Host Entrypoint
 * Videomappingtech Workstation Edition
 */
const path = require('path');
const { spawn, exec } = require('child_process');

let isElectron = false;
try {
  // Tenta carregar electron se presente no runtime
  isElectron = !!require('electron').app;
} catch {
  isElectron = false;
}

if (isElectron) {
  const { app, BrowserWindow, Menu, screen, ipcMain } = require('electron');

  let mainWindow = null;
  let screenWindow = null;

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1200,
      minHeight: 750,
      title: 'Silent Stage AI - Workstation Pro',
      icon: path.join(__dirname, '../public/favicon.ico'),
      backgroundColor: '#10111c',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    // Inicia o servidor local interno
    require('../server/index');

    // Carrega o console desktop local
    setTimeout(() => {
      mainWindow.loadURL('http://localhost:3000/desktop.html');
    }, 1200);

    mainWindow.on('closed', () => {
      mainWindow = null;
      if (screenWindow) screenWindow.close();
    });
  }

  function createProjectorWindow(displayIndex = 1) {
    const displays = screen.getAllDisplays();
    const targetDisplay = displays[displayIndex] || displays[0];

    screenWindow = new BrowserWindow({
      x: targetDisplay.bounds.x,
      y: targetDisplay.bounds.y,
      width: targetDisplay.bounds.width,
      height: targetDisplay.bounds.height,
      fullscreen: true,
      frame: false,
      title: 'Silent Stage AI - Telão de Projeção',
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    screenWindow.loadURL('http://localhost:3000/screen.html?room=palco1');
  }

  app.whenReady().then(() => {
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
} else {
  // Modo Standalone Local (Node.js Direct Launcher)
  console.log('[Silent Stage AI] Iniciando Servidor Local de Alta Performance...');
  require('../server/index');

  const url = 'http://localhost:3000/desktop.html';
  console.log(`[Silent Stage AI] Estação Desktop pronta em: ${url}`);

  // Abre automaticamente no navegador padrão do Windows em modo aplicativo
  if (process.platform === 'win32') {
    exec(`start msedge --app=${url} || start chrome --app=${url} || start ${url}`);
  } else {
    exec(`xdg-open ${url} || open ${url}`);
  }
}
