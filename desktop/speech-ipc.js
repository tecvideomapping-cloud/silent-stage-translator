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
  ipcMain.handle('vmt:speech:start',(event,config)=>{trusted(event);owner=event.sender;return engine.start(config||{});});
  ipcMain.handle('vmt:speech:stop',event=>{trusted(event);return engine.stop();});
  ipcMain.on('vmt:speech:audio',(event,frame)=>{try{trusted(event);if(owner===event.sender)engine.feed(frame);}catch{engine.stop('Bloco de áudio local inválido.');}});
  return engine;
}
module.exports={registerSpeechIpc};
