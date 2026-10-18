'use strict';
const os=require('os');
function normalize(config={}){
 const int=(value,min,max,fallback)=>Number.isInteger(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):fallback;
 const device=config.device==='cuda'?'cuda':'cpu';
 const allowed=device==='cuda'?['int8_float16','float16','float32','int8']:['int8','float32'];
 return {model:['tiny','base','small'].includes(config.model)?config.model:'base',language:/^[a-z]{2}$/.test(config.language)?config.language:'pt',diarization:config.diarization===true,device,gpuIndex:int(config.gpuIndex,0,15,0),computeType:allowed.includes(config.computeType)?config.computeType:device==='cuda'?'int8_float16':'int8',cpuThreads:int(config.cpuThreads,1,Math.min(32,os.cpus().length),Math.min(8,os.cpus().length)),diarizationDevice:config.diarizationDevice==='cuda'?'cuda':'cpu',diarizationGpuIndex:int(config.diarizationGpuIndex,0,15,0)};
}
module.exports={normalize};
