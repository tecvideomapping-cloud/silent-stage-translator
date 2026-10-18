'use strict';
function registerDisplayMedia({window,cloudBase,getLocalOrigin,desktopCapturer,dialog,openExternal,platform=process.platform}){
 let busy=false;
 const trusted=request=>{
  try{const frame=request.frame,url=new URL(frame.url);return !window.isDestroyed()&&frame===window.webContents.mainFrame&&request.userGesture&&['/host.html','/desktop.html'].includes(url.pathname)&&[new URL(cloudBase).origin,getLocalOrigin()].includes(url.origin)&&new URL(request.securityOrigin).origin===url.origin;}catch{return false;}
 };
 window.webContents.session.setDisplayMediaRequestHandler(async(request,callback)=>{
  if(platform!=='win32'||busy||!request.audioRequested||!request.videoRequested||!trusted(request)){callback(null);return;}
  busy=true;let streams=null;
  try{
   const choice=await dialog.showMessageBox(window,{type:'question',title:'Escolher fonte de áudio',message:'Qual áudio você deseja compartilhar?',detail:'Áudio do PC: captura o som geral do Windows, incluindo Spotify, Media Player e outros aplicativos. Não isola um programa.\n\nGuia específica (YouTube): abre esta mesa no navegador, onde você pode selecionar a guia e compartilhar seu áudio. Entre na mesma conta se necessário. Encerre a transmissão do aplicativo antes de operar pelo navegador.\n\nA imagem da tela não é enviada aos participantes.',buttons:['Áudio do PC (Spotify / players)','Selecionar guia no navegador','Cancelar'],defaultId:2,cancelId:2,noLink:true});
   if(choice.response===0&&trusted(request)){
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});
    if(sources.length&&trusted(request))streams={video:sources[0],audio:'loopback'};
   }
   else if(choice.response===1&&trusted(request)&&openExternal)await openExternal(request.frame.url);
  }catch(error){console.warn('[Desktop] Captura de sistema indisponível:',error.name||'Error');}
  finally{busy=false;try{callback(streams);}catch{}}
 });
}
module.exports={registerDisplayMedia};
