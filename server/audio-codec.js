const steps=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const indexes=[-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
function decodeForStt(input,state={predictor:0,index:0},outputRate=16000){
 if(!Number.isFinite(outputRate)||outputRate<8000||outputRate>48000)throw Error('Taxa de áudio inválida.');
 const data=Buffer.from(input);if(data.length>65536||!data.length)throw Error('Pacote de áudio inválido.');
 let rate=16000,codec=0,offset=0;if(data[0]===0xaa){if(data.length<5)throw Error('Cabeçalho inválido.');rate=data.readUInt16LE(2);codec=data[1];offset=4;if(rate<8000||rate>48000||codec>2)throw Error('Formato de áudio inválido.');}
 const samples=[];
 if(codec===0){if((data.length-offset)%2)throw Error('PCM incompleto.');for(let i=offset;i<data.length;i+=2)samples.push(data.readInt16LE(i));}
 else if(codec===1){for(let i=offset;i<data.length;i++){const x=(~data[i])&255;let value=(((x&15)<<3)+132)<<((x>>4)&7);value-=132;samples.push(x&128?-value:value);}}
 else{state.predictor??=0;state.index??=0;for(let i=offset;i<data.length;i++)for(const n of [data[i]&15,data[i]>>4]){const step=steps[state.index];let delta=step>>3;if(n&4)delta+=step;if(n&2)delta+=step>>1;if(n&1)delta+=step>>2;state.predictor=Math.max(-32768,Math.min(32767,state.predictor+(n&8?-delta:delta)));state.index=Math.max(0,Math.min(88,state.index+indexes[n]));samples.push(state.predictor);}}
 const count=Math.floor(samples.length*outputRate/rate),out=Buffer.alloc(count*2);for(let i=0;i<count;i++){const start=i*rate/outputRate,end=(i+1)*rate/outputRate;let total=0,weight=0;for(let j=Math.floor(start);j<Math.ceil(end);j++){const w=Math.max(0,Math.min(j+1,end)-Math.max(j,start));total+=(samples[Math.min(j,samples.length-1)]||0)*w;weight+=w;}out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(total/(weight||1)))),i*2);}return out;
}
module.exports={decodeForStt};
