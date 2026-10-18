const {EventEmitter}=require('events');
const {spawn}=require('child_process');
const path=require('path');
const readline=require('readline');
const crypto=require('crypto');
const fs=require('fs');

// Only the Electron main process launches the worker. No renderer-supplied paths,
// commands or tokens cross the bridge. Audio and transcripts remain in memory.
class LocalSpeech extends EventEmitter {
  constructor(options={}) {
    super();this.spawn=options.spawn||spawn;
    const installed=path.join(require('os').homedir(),'.silentstageai','speech-env',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
    this.python=options.python||process.env.VMT_SPEECH_PYTHON||(fs.existsSync(installed)?installed:'python');
    this.state='stopped';this.child=null;this.generation=0;this.metrics={};this.runtime=null;
  }
  status(){return {state:this.state,diarization:!!this.diarization,model:this.model||'base',config:this.config||require('./speech-config').normalize(),runtime:this.runtime,metrics:this.metrics,message:this.message||''};}
  workerPath(){return path.join(__dirname.replace(/app\.asar(?=[\\/])/,'app.asar.unpacked'),'speech','worker.py');}
  capabilities(refresh=false){
    if(!refresh&&this.capabilityCache&&this.capabilityCache.until>Date.now())return Promise.resolve(this.capabilityCache.value);
    if(this.capabilityProbe)return this.capabilityProbe;
    this.capabilityProbe=new Promise((resolve,reject)=>{
      const child=this.spawn(this.python,['-u',this.workerPath(),'--probe'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});let output='',done=false;
      const finish=(value)=>{if(done)return;done=true;clearTimeout(timer);child.kill();if(value){this.capabilityCache={value,until:Date.now()+300000};resolve(value);}else reject(Error('Não foi possível consultar o ambiente Python local. Confira a instalação do motor.'));};
      const timer=setTimeout(()=>finish(null),30000);child.stderr.on('data',()=>{});child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>262144){finish(null);return;}for(const line of output.split('\n')){try{const result=JSON.parse(line);if(result.type==='capabilities')finish(result);}catch{}}});child.once('error',()=>finish(null));child.once('exit',()=>finish(null));
    }).finally(()=>{this.capabilityProbe=null;});return this.capabilityProbe;
  }
  report(state,message=''){this.state=state;this.message=message;this.emit('status',this.status());}
  start(config={}) {
    if(this.child)throw Error('Interrompa o motor antes de alterar a configuração.');
    this.config=require('./speech-config').normalize(config);Object.assign(this,this.config);this.runtime=null;this.metrics={};
    this.session=crypto.randomUUID();this.generation++;this.parts=[];this.samples=0;this.silence=0;this.speaking=false;this.preroll=[];this.prerollSamples=0;this.pending=0;this.sequence=0;this.inputSeconds=0;
    const generation=this.generation;
    this.report('loading','Carregando os modelos locais…');
    const token=this.diarization?require('./speech-credentials').loadToken():'';
    // Python cannot read Electron's virtual ASAR filesystem.
    const workerPath=this.workerPath();
    const child=this.child=this.spawn(this.python,['-u',workerPath,'--model',this.model,'--language',this.language,'--device',this.device,'--gpu-index',String(this.gpuIndex),'--compute-type',this.computeType,'--cpu-threads',String(this.cpuThreads),'--diarization-device',this.diarizationDevice,'--diarization-gpu-index',String(this.diarizationGpuIndex),...(this.diarization?['--diarization']:[])],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...(token?{HF_TOKEN:token}:{}),PYTHONUTF8:'1',HF_HUB_DISABLE_TELEMETRY:'1',PYANNOTE_METRICS_ENABLED:'0'}});
    const fail=message=>{if(this.generation===generation&&this.child===child)this.stop(message);};
    // Dependency diagnostics may contain paths/tokens. Never forward stderr.
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>fail('O processo de reconhecimento foi interrompido.'));
    child.once('error',()=>fail('Python local indisponível. Instale o motor seguindo o guia do desktop.'));
    child.once('exit',()=>fail('O motor local encerrou. Reinicie-o ou escolha o modo atual.'));
    this.timer=setTimeout(()=>fail('O carregamento excedeu 10 minutos. Confira os modelos e a conexão.'),600000);this.timer.unref?.();
    readline.createInterface({input:child.stdout}).on('line',line=>{
      if(this.child!==child||this.generation!==generation||line.length>262144)return;
      let event;try{event=JSON.parse(line);}catch{return;}
      if(event.type==='ready'){clearTimeout(this.timer);this.runtime=event.runtime||null;this.report('ready','Motor local pronto.');}
      else if(event.type==='telemetry'){this.metrics={...this.metrics,cpuPercent:Number.isFinite(event.cpuPercent)?event.cpuPercent:null,memoryMb:Number.isFinite(event.memoryMb)?event.memoryMb:null,memoryKind:event.memoryKind,pending:this.pending};this.emit('metrics',this.metrics);}
      else if(event.type==='result'){
        this.pending=Math.max(0,this.pending-1);clearTimeout(this.jobTimer);this.jobTimer=null;
        if(this.pending)this.jobTimer=setTimeout(()=>fail('O processamento local excedeu 45 segundos. Selecione um modelo menor.'),45000);
        const segments=Array.isArray(event.segments)?event.segments:[];
        for(const [index,segment] of segments.slice(0,100).entries()){
          if(typeof segment.text!=='string'||!segment.text.trim())continue;
          this.emit('transcript',{text:segment.text.trim().slice(0,4000),isFinal:true,sourceLang:this.language,source:'desktop-local',speakerId:Number.isInteger(segment.speakerId)&&segment.speakerId>=0?segment.speakerId:null,turnId:this.session+':'+event.id+':'+index,segmentId:crypto.randomUUID(),processingMs:Number(event.processingMs)||0});
        }
        this.metrics={...this.metrics,processingMs:Number(event.processingMs)||0,audioSeconds:Number(event.audioSeconds)||0,rtf:Number.isFinite(event.rtf)?event.rtf:null,queueWaitMs:Number(event.queueWaitMs)||0,pending:this.pending};this.emit('metrics',this.metrics);
      }else if(event.type==='error'){const errors={CUDA_RUNTIME_UNAVAILABLE:'As bibliotecas CUDA/cuDNN necessárias não estão disponíveis. Instale o runtime compatível ou selecione CPU.',DEVICE_CONFIGURATION_UNAVAILABLE:'A GPU ou a precisão selecionada não está disponível no motor local.',DIARIZATION_CUDA_UNAVAILABLE:'O PyTorch instalado não oferece a GPU selecionada para o Pyannote. Selecione CPU para os locutores.'};fail(errors[event.code]||(this.diarization?'Não foi possível carregar ou executar os modelos. Confira a instalação, o token e o aceite do Pyannote.':'Não foi possível carregar ou executar o Faster-Whisper. Confira a instalação do motor local.'));}
    });
    return this.status();
  }
  feed(frame) {
    if(this.state!=='ready')return false;
    if(!(frame instanceof ArrayBuffer)&&!ArrayBuffer.isView(frame))throw Error('Áudio inválido.');
    const pcm=Buffer.from(frame instanceof ArrayBuffer?frame:frame.buffer,frame instanceof ArrayBuffer?0:frame.byteOffset,frame.byteLength);
    if(!pcm.length||pcm.length%2||pcm.length>32000)throw Error('Bloco de áudio inválido.');
    let energy=0;for(let i=0;i<pcm.length;i+=2)energy+=(pcm.readInt16LE(i)/32768)**2;
    const count=pcm.length/2,voiced=Math.sqrt(energy/count)>.009;
    this.inputSeconds+=count/16000;
    if(!this.speaking){
      if(!voiced){this.preroll.push(Buffer.from(pcm));this.prerollSamples+=count;while(this.prerollSamples>4800&&this.preroll.length>1)this.prerollSamples-=this.preroll.shift().length/2;return true;}
      this.parts=this.preroll;this.samples=this.prerollSamples;this.preroll=[];this.prerollSamples=0;this.speaking=true;
    }
    this.parts.push(Buffer.from(pcm));this.samples+=count;this.silence=voiced?0:this.silence+count;
    if((this.silence>=8000&&this.samples>=9600)||this.samples>=96000)this.flush();
    return true;
  }
  flush(){
    if(!this.samples||!this.child||this.state!=='ready')return;
    if(this.pending>=2){this.stop('O computador não acompanha o áudio ao vivo. Use um modelo menor ou desative a identificação de locutores.');return;}
    const audio=Buffer.concat(this.parts);const start=this.inputSeconds-this.samples/16000;
    this.parts=[];this.samples=0;this.speaking=false;this.silence=0;
    this.pending++;
    if(!this.jobTimer)this.jobTimer=setTimeout(()=>this.stop('O processamento local excedeu 45 segundos. Use um modelo menor.'),45000);
    this.child.stdin.write(JSON.stringify({id:++this.sequence,start,queuedAt:Date.now(),pcm:audio.toString('base64')})+'\n');
  }
  reset(){
    // Resetting also terminates pending inference: no result from the old event
    // may leak into a new broadcast.
    this.stop();
  }
  stop(message=''){
    this.generation++;clearTimeout(this.timer);clearTimeout(this.jobTimer);this.jobTimer=null;
    const child=this.child;this.child=null;child?.kill();this.runtime=null;this.metrics={};this.parts=[];this.preroll=[];this.samples=0;this.pending=0;
    this.report(message?'error':'stopped',message);return this.status();
  }
}
module.exports={LocalSpeech};
