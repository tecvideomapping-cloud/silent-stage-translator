'use strict';
function registerDisplayMedia({window,cloudBase,getLocalOrigin,desktopCapturer,dialog,platform=process.platform}){
 let busy=false;
 const trusted=request=>{
  try{const frame=request.frame,url=new URL(frame.url);return !window.isDestroyed()&&frame===window.webContents.mainFrame&&request.userGesture&&['/host.html','/desktop.html'].includes(url.pathname)&&[new URL(cloudBase).origin,getLocalOrigin()].includes(url.origin)&&new URL(request.securityOrigin).origin===url.origin;}catch{return false;}
 };
 window.webContents.session.setDisplayMediaRequestHandler(async(request,callback)=>{
  if(platform!=='win32'||busy||!request.audioRequested||!request.videoRequested||!trusted(request)){callback(null);return;}
  busy=true;let streams=null;
  try{
   const choice=await dialog.showMessageBox(window,{type:'question',title:'Capturar áudio do computador',message:'Compartilhar o áudio do Windows com este evento?',detail:'Inclui o som do YouTube, players e outros aplicativos. A transmissão utiliza o áudio; a imagem da tela não é enviada aos participantes.',buttons:['Compartilhar áudio','Cancelar'],defaultId:1,cancelId:1,noLink:true});
   if(choice.response===0&&trusted(request)){
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});
    if(sources.length&&trusted(request))streams={video:sources[0],audio:'loopback'};
   }
  }catch(error){console.warn('[Desktop] Captura de sistema indisponível:',error.name||'Error');}
  finally{busy=false;try{callback(streams);}catch{}}
 });
}
module.exports={registerDisplayMedia};
