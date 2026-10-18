/**
 * Silent Stage - Native Desktop Host Entrypoint
 * Silent Stage Workstation Edition
 */
const path = require('path');
process.env.VMT_DESKTOP_MODE='1';
const { exec } = require('child_process');

let isElectron = false;
try {
  isElectron = !!(require('electron') && require('electron').app);
} catch {
  isElectron = false;
}

if (isElectron) {
  const { app, BrowserWindow, Menu, screen, ipcMain } = require('electron');
  // Keep the existing profile, sessions and license when changing the display name.
  const legacyProfiles=['Silent Stage AI','videomappingtech-silent-translator'];
  const existingProfile=legacyProfiles.map(name=>path.join(app.getPath('appData'),name)).find(dir=>require('fs').existsSync(dir));
  app.setPath('userData',existingProfile||path.join(app.getPath('appData'),'videomappingtech-silent-translator'));
  app.setName('Silent Stage');
  if(process.platform==='win32')app.setAppUserModelId('com.videomappingtech.silentstage');


  const cloudBase=process.env.APP_BASE_URL||'https://silent-stage-translator-production.up.railway.app';
  ipcMain.handle('vmt:hardware',async event=>{if(new URL(event.senderFrame.url).origin!==new URL(cloudBase).origin&&new URL(event.senderFrame.url).hostname!=='localhost')throw Error('Origem não autorizada.');return require('./desktop-api').probe('static')});
  if(process.env.VMT_SMOKE_TEST==='1'&&process.env.VMT_TEST_PROFILE)app.setPath('userData',process.env.VMT_TEST_PROFILE);
  let mainWindow = null;
  let screenWindow = null;
  let localOrigin=null;
  const localSpeech=require('./speech-ipc').registerSpeechIpc({ipcMain,cloudBase,getWindow:()=>mainWindow,getLocalOrigin:()=>localOrigin});
  app.on('before-quit',()=>localSpeech.stop());

  async function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1200,
      minHeight: 750,
      title: 'Silent Stage - Workstation Pro',
      icon: path.join(__dirname, '../public/favicon.ico'),
      backgroundColor: '#10111c',
      show:process.env.VMT_SMOKE_TEST!=='1',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    require('./display-media').registerDisplayMedia({window:mainWindow,cloudBase,getLocalOrigin:()=>localOrigin,desktopCapturer:require('electron').desktopCapturer,dialog:require('electron').dialog,openExternal:url=>require('electron').shell.openExternal(url)});

    // Tela de inicialização instantânea no carregamento
    const splashHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body {
            background:#10111c; color:#f1f5f9;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
            display:flex; align-items:center; justify-content:center;
            height:100vh; overflow:hidden; user-select:none;
          }
          .splash { text-align:center; padding:30px; }
          .spinner {
            width:48px; height:48px; border:3px solid rgba(56,189,248,0.15);
            border-top-color:#38bdf8; border-radius:50%;
            animation:spin .8s linear infinite; margin:0 auto 24px;
          }
          .title { font-size:20px; font-weight:700; letter-spacing:-.02em; margin-bottom:8px; color:#f8fafc; }
          .subtitle { font-size:13px; color:#94a3b8; letter-spacing:.02em; text-transform:uppercase; font-weight:500; }
          @keyframes spin { to { transform:rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="splash">
          <img src="data:image/png;base64,${require('fs').readFileSync(path.join(__dirname, '../public/brand/silent-stage-icon-192.png')).toString('base64')}" alt="" width="80" height="80" style="border-radius:24px;margin-bottom:24px">
          <div class="spinner"></div>
          <div class="title">Silent Stage · Workstation Pro</div>
          <div class="subtitle">Inicializando motor de áudio e tradução neural...</div>
        </div>
      </body>
      </html>
    `;
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);

    try {
      // Inicia o servidor local interno e obtém a porta ativa
      process.env.VMT_LICENSE_PATH=path.join(app.getPath('userData'),'license.json');
      const { startServer } = require('../server/index');
      const port = await startServer(process.env.PORT || 3000);
      localOrigin=`http://localhost:${port}`;
      const appUrl=process.env.VMT_LOCAL_ONLY==='1'?`http://localhost:${port}/desktop.html`:cloudBase+'/customer.html';

      // Carrega a interface da Workstation Pro
      await mainWindow.loadURL(appUrl);
    } catch (err) {
      console.error('[Desktop Host] Falha ao iniciar servidor local:', err);
      const errorHtml = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"></head>
        <body style="background:#10111c;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;">
          <div style="max-width:520px;background:#181926;border:1px solid #334155;border-radius:12px;padding:32px;text-align:center;">
            <div style="font-size:36px;margin-bottom:12px;">⚠️</div>
            <h2 style="margin:0 0 10px;font-size:18px;">Falha ao iniciar o motor local</h2>
            <p style="color:#94a3b8;font-size:13px;margin:0 0 18px;">Não foi possível inicializar o servidor interno do Silent Stage:</p>
            <pre style="background:#0b0c14;color:#f87171;padding:12px;border-radius:6px;font-size:12px;text-align:left;overflow:auto;margin:0 0 20px;">${String(err.message||err).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</pre>
            <button onclick="location.reload()" style="background:#38bdf8;color:#0f172a;border:none;padding:10px 24px;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;">Tentar Novamente</button>
          </div>
        </body>
        </html>
      `;
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
    }

    // Gerencia novas janelas (ex: telão de projeção, visualização de participantes)
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try{const target=new URL(url),current=new URL(mainWindow.webContents.getURL());if(target.origin!==current.origin){if(target.protocol==='https:')require('electron').shell.openExternal(url);return {action:'deny'};}}catch{return {action:'deny'};}
      mainWindow.loadURL(url);return {action:'deny'};

    });

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      console.warn(`[Desktop] Falha ao carregar ${validatedURL}: ${errorDescription} (${errorCode})`);
      if (validatedURL && validatedURL.includes('desktop.html') && errorCode !== -3) {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(validatedURL).catch(() => {});
          }
        }, 1500);
      }
    });

    mainWindow.on('closed', () => {
      localSpeech.stop();
      mainWindow = null;
      if (screenWindow) screenWindow.close();
    });
    mainWindow.webContents.on('did-start-navigation',(_event,_url,inPlace,isMainFrame)=>{if(isMainFrame&&!inPlace)localSpeech.stop();});
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
      title: 'Silent Stage - Telão de Projeção',
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const port = mainWindow&&new URL(mainWindow.webContents.getURL()).port||process.env.PORT||3000;
    screenWindow.loadURL(`http://localhost:${port}/screen.html?room=palco1`);
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
  console.log('[Silent Stage] Iniciando Servidor Local de Alta Performance...');
  const { startServer } = require('../server/index');
  startServer(process.env.PORT || 3000).then((port) => {
    const url = `http://localhost:${port}/desktop.html`;
    console.log(`[Silent Stage] Estação Desktop pronta em: ${url}`);

    // Abre automaticamente no navegador padrão do Windows em modo aplicativo
    if (process.platform === 'win32') {
      exec(`start msedge --app=${url} || start chrome --app=${url} || start ${url}`);
    } else {
      exec(`xdg-open ${url} || open ${url}`);
    }
  }).catch(err => {
    console.error('[Silent Stage] Erro ao iniciar servidor:', err);
  });
}
