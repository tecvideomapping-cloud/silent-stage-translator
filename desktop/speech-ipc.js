const {LocalSpeech}=require('./local-speech');

function registerSpeechIpc({ipcMain,cloudBase,getWindow,getLocalOrigin,engine=new LocalSpeech()}){
  let owner=null;
  function trusted(event){
    const window=getWindow();
    if(!window||event.sender!==window.webContents||event.senderFrame!==event.sender.mainFrame)throw Error('Janela não autorizada.');
    let url;try{url=new URL(event.senderFrame.url);}catch{throw Error('Origem não autorizada.');}
    if(![new URL(cloudBase).origin,getLocalOrigin()].includes(url.origin))throw Error('Origem não autorizada.');
    if(!['/host.html','/desktop.html'].includes(url.pathname))throw Error('Disponível apenas na mesa de operação.');
  }
  for(const kind of ['status','transcript','metrics'])engine.on(kind,data=>{if(owner&&!owner.isDestroyed())owner.send('vmt:speech:event',{kind,data});});
  ipcMain.handle('vmt:speech:status',event=>{trusted(event);return engine.status();});
  ipcMain.handle('vmt:speech:capabilities',(event,refresh)=>{trusted(event);return engine.capabilities(refresh===true);});
  ipcMain.handle('vmt:speech:hardware',async event=>{trusted(event);const report=await require('./desktop-api').probe('static');return {...report,fingerprint:undefined,system:{...report.system,machineName:undefined}};});
  ipcMain.handle('vmt:speech:hardware-metrics',async event=>{trusted(event);const metrics=await require('./desktop-api').probe('metrics');return {...metrics,processes:undefined,workerGpuMemory:(metrics.processes||[]).filter(p=>Number.isInteger(engine.child?.pid)&&p.pid===engine.child.pid)};});
  ipcMain.handle('vmt:speech:start',(event,config)=>{trusted(event);owner=event.sender;return engine.start(config||{});});
  ipcMain.handle('vmt:speech:stop',event=>{trusted(event);return engine.stop();});
  ipcMain.on('vmt:speech:audio',(event,frame)=>{try{trusted(event);if(owner===event.sender)engine.feed(frame);}catch{engine.stop('Bloco de áudio local inválido.');}});
  return engine;
}
module.exports={registerSpeechIpc};
