/**
 * Preload script for Desktop Workstation Electron Host
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopHost', {
  platform: process.platform,
  isElectron: true,
  ping: () => 'pong',
  getHardware:()=>ipcRenderer.invoke('vmt:hardware')
});
