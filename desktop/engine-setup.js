'use strict';
const path=require('path'),{pathToFileURL}=require('url'),{spawn}=require('child_process'),readline=require('readline');
function setupArguments(options={}){return ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname.replace(/app\.asar(?=[\\/])/,'app.asar.unpacked'),'speech','ensure-engine.ps1'),...(options.check===true?['-CheckOnly']:[]),...(options.cuda===true?['-Cuda']:[]),...(options.diarization===true?['-Diarization']:[])];}
function createSetupWindow({BrowserWindow,ipcMain,app}){
 const url=pathToFileURL(path.join(__dirname,'setup.html')).href;
 const window=new BrowserWindow({width:780,height:740,minWidth:600,minHeight:600,show:process.env.VMT_SMOKE_TEST!=='1',title:'Preparar motor local · Silent Stage',webPreferences:{nodeIntegration:false,contextIsolation:true,preload:path.join(__dirname,'setup-preload.js')},backgroundColor:'#10111c'});
 let child=null;
 function trusted(event){if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==url)throw Error('Janela não autorizada.');}
 ipcMain.handle('vmt:setup:run',(event,options)=>{trusted(event);if(child)throw Error('A verificação ou instalação já está em andamento.');return new Promise(resolve=>{
  let last=null,settled=false;const finish=ok=>{if(settled)return;settled=true;child=null;resolve(last?.type==='error'||ok&&['check','complete'].includes(last?.type)?last:{type:'error',message:'Não foi possível concluir a verificação ou instalação. Tente novamente.'});};
  child=spawn('powershell.exe',setupArguments(options),{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',()=>{});readline.createInterface({input:child.stdout}).on('line',line=>{if(line.length>262144)return;try{const item=JSON.parse(line);if(['progress','check','complete','error'].includes(item.type)){last=item;if(!window.isDestroyed())window.webContents.send('vmt:setup:progress',item);}}catch{}});child.once('error',()=>finish(false));child.once('exit',code=>finish(code===0));
 });});
 window.on('close',event=>{if(child){event.preventDefault();window.webContents.send('vmt:setup:progress',{type:'progress',message:'Aguarde a conclusão da instalação antes de fechar esta janela.'});}});
 window.on('closed',()=>app.quit());window.loadURL(url);return window;
}
module.exports={createSetupWindow,setupArguments};
