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
    this.state='stopped';this.child=null;this.generation=0;
  }
  status(){return {state:this.state,diarization:!!this.diarization,model:this.model||'base',message:this.message||''};}
  report(state,message=''){this.state=state;this.message=message;this.emit('status',this.status());}
  start(config={}) {
    if(this.child)throw Error('Interrompa o motor antes de alterar a configuração.');
    this.model=['tiny','base','small'].includes(config.model)?config.model:'base';
    this.diarization=config.diarization===true;this.language=/^[a-z]{2}$/.test(config.language)?config.language:'pt';
    this.session=crypto.randomUUID();this.generation++;this.parts=[];this.samples=0;this.silence=0;this.speaking=false;this.preroll=[];this.prerollSamples=0;this.pending=0;this.sequence=0;this.inputSeconds=0;
    const generation=this.generation;
    this.report('loading','Carregando os modelos locais…');
    const token=this.diarization?require('./speech-credentials').loadToken():'';
    // Python cannot read Electron's virtual ASAR filesystem.
    const workerPath=path.join(__dirname.replace(/app\.asar(?=[\\/])/,'app.asar.unpacked'),'speech','worker.py');
    const child=this.child=this.spawn(this.python,['-u',workerPath,'--model',this.model,'--language',this.language,...(this.diarization?['--diarization']:[])],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...(token?{HF_TOKEN:token}:{}),PYTHONUTF8:'1',HF_HUB_DISABLE_TELEMETRY:'1',PYANNOTE_METRICS_ENABLED:'0'}});
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
      if(event.type==='ready'){clearTimeout(this.timer);this.report('ready','Motor local pronto.');}
      else if(event.type==='result'){
        this.pending=Math.max(0,this.pending-1);clearTimeout(this.jobTimer);this.jobTimer=null;
        if(this.pending)this.jobTimer=setTimeout(()=>fail('O processamento local excedeu 45 segundos. Selecione um modelo menor.'),45000);
        const segments=Array.isArray(event.segments)?event.segments:[];
        for(const [index,segment] of segments.slice(0,100).entries()){
          if(typeof segment.text!=='string'||!segment.text.trim())continue;
          this.emit('transcript',{text:segment.text.trim().slice(0,4000),isFinal:true,sourceLang:this.language,source:'desktop-local',speakerId:Number.isInteger(segment.speakerId)&&segment.speakerId>=0?segment.speakerId:null,turnId:this.session+':'+event.id+':'+index,segmentId:crypto.randomUUID(),processingMs:Number(event.processingMs)||0});
        }
        this.emit('metrics',{processingMs:Number(event.processingMs)||0,pending:this.pending});
      }else if(event.type==='error')fail(this.diarization?'Não foi possível carregar ou executar os modelos. Confira a instalação, o token e o aceite do Pyannote.':'Não foi possível carregar ou executar o Faster-Whisper. Confira a instalação do motor local.');
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
    this.child.stdin.write(JSON.stringify({id:++this.sequence,start,pcm:audio.toString('base64')})+'\n');
  }
  reset(){
    // Resetting also terminates pending inference: no result from the old event
    // may leak into a new broadcast.
    this.stop();
  }
  stop(message=''){
    this.generation++;clearTimeout(this.timer);clearTimeout(this.jobTimer);this.jobTimer=null;
    const child=this.child;this.child=null;child?.kill();this.parts=[];this.preroll=[];this.samples=0;this.pending=0;
    this.report(message?'error':'stopped',message);return this.status();
  }
}
module.exports={LocalSpeech};
