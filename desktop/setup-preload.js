const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('engineSetup',{run:options=>ipcRenderer.invoke('vmt:setup:run',options),onProgress:callback=>ipcRenderer.on('vmt:setup:progress',(_event,value)=>callback(value))});
