/**
 * Preload script for Desktop Workstation Electron Host
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopHost', {
  platform: process.platform,
  isElectron: true,
  ping: () => 'pong',
  getHardware:()=>ipcRenderer.invoke('vmt:hardware'),
  speech: {
    capabilities:refresh=>ipcRenderer.invoke('vmt:speech:capabilities',refresh===true),
    hardware:()=>ipcRenderer.invoke('vmt:speech:hardware'),
    hardwareMetrics:()=>ipcRenderer.invoke('vmt:speech:hardware-metrics'),
    status:()=>ipcRenderer.invoke('vmt:speech:status'),
    start:config=>ipcRenderer.invoke('vmt:speech:start',config),
    stop:()=>ipcRenderer.invoke('vmt:speech:stop'),
    audio:frame=>ipcRenderer.send('vmt:speech:audio',frame),
    onEvent:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('vmt:speech:event',listener);return ()=>ipcRenderer.removeListener('vmt:speech:event',listener);}
  }
});
