'use strict';
const $=id=>document.getElementById(id);
let running=false,report=null,failed=false,installed=new Set();
const keys={python:'pythonInstalled',core:'coreReady',cuda:'cudaReady',diarization:'diarizationReady'};
function pending(){return !report?.coreReady||['cuda','diarization'].some(k=>$(k).checked&&!report[keys[k]]);}
function render(){
 document.body.setAttribute('aria-busy',String(running));
 for(const [k,field] of Object.entries(keys)){
  const ready=!!report?.[field];
  $(k+'-state').textContent=!report?'Verificando…':ready?(installed.has(k)?'Instalado agora':'Já instalado'):(k==='python'||k==='core'?'Necessário':'Opcional');
  if(k==='cuda'||k==='diarization'){if(ready)$(k).checked=true;$(k).disabled=running||ready||!report;}
 }
 $('python-version').textContent=report?.pythonVersion||'Ambiente isolado';
 $('verify').disabled=running;$('finish').disabled=running;$('install').disabled=running;
 $('install').hidden=!running&&!!report&&!pending()&&!failed;
 $('install').textContent=running?'Aguarde…':failed?'Tentar novamente':'Instalar componentes necessários';
 $('finish').textContent=failed?'Fechar':report?.coreReady?'Concluir e fechar':'Fazer depois';
 $('finish').className=report?.coreReady&&!pending()&&!failed?'':'secondary';
}
function idleMessage(){
 if(pending()){$('heading').textContent=report.coreReady?'Componentes opcionais selecionados':'Prepare a transcrição local';$('status').textContent=report.coreReady?'Clique em Instalar para adicionar os componentes selecionados.':'Clique em Instalar para preparar os componentes necessários. Você também pode fazer isso depois.';}
 else{$('heading').textContent=installed.size?'Instalação concluída':'Tudo pronto para o motor local';$('status').textContent=installed.size?'Os componentes foram instalados e verificados. Pode clicar em Concluir e fechar.':'Nenhuma instalação foi necessária: os componentes já estavam instalados. Pode clicar em Concluir e fechar.';}
}
async function run(check){
 if(running)return;running=true;failed=false;
 const before=report;
 $('heading').textContent=check?'Verificando este computador…':'Instalando componentes…';
 $('status').textContent=check?'Aguarde a verificação. Nenhuma instalação foi iniciada.':'Aguarde a conclusão. Esta etapa usa internet e pode levar alguns minutos.';render();
 try{
  const result=await engineSetup.run({check,cuda:$('cuda').checked,diarization:$('diarization').checked});
  if(result.type==='error'||!result.report)throw Error(result.message||'Não foi possível verificar os componentes.');
  report=result.report;
  if(!check&&before)for(const [k,field] of Object.entries(keys))if(!before[field]&&report[field])installed.add(k);
  idleMessage();
 }catch(error){failed=true;$('heading').textContent='Não foi possível concluir';$('status').textContent=error.message+' Você pode tentar novamente ou fechar e preparar depois.';}
 finally{running=false;render();}
}
engineSetup.onProgress(item=>{if(running&&item.type==='progress')$('status').textContent=item.message+' Aguarde; não feche esta janela.';});
$('verify').onclick=()=>run(true);$('install').onclick=()=>run(false);$('finish').onclick=()=>window.close();
for(const k of ['cuda','diarization'])$(k).onchange=()=>{failed=false;idleMessage();render();};
run(true);
