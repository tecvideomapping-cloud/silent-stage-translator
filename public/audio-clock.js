(function(root){
 class PcmResampler {
  constructor(){this.sourceRate=0;this.targetRate=0;this.sum=0;this.weight=0;}
  process(input,sourceRate,targetRate){
   if(!Number.isFinite(sourceRate)||!Number.isFinite(targetRate)||sourceRate<=0||targetRate<=0)throw Error('Invalid sample rate');
   if(sourceRate!==this.sourceRate||targetRate!==this.targetRate){this.sourceRate=sourceRate;this.targetRate=targetRate;this.sum=0;this.weight=0;}
   if(sourceRate===targetRate)return input;
   const ratio=sourceRate/targetRate,output=new Float32Array(Math.ceil((input.length+this.weight)/ratio)+1);let count=0;
   for(const sample of input){let remaining=1;while(remaining>1e-9){const take=Math.min(remaining,ratio-this.weight);this.sum+=sample*take;this.weight+=take;remaining-=take;if(this.weight>=ratio-1e-9){output[count++]=this.sum/ratio;this.sum=0;this.weight=0;}}}
   return output.subarray(0,count);
  }
 }
 class RawPlayout {
  constructor(){this.reset();}
  reset(){this.next=0;this.lastArrival=null;this.lastDuration=0;this.jitterMs=0;this.target=0.065;this.packets=0;this.underruns=0;this.resyncs=0;}
  schedule(now,arrivalMs,duration,mode='auto'){
   if(this.lastArrival!==null){const variation=Math.abs(arrivalMs-this.lastArrival-this.lastDuration*1000);this.jitterMs=.9*this.jitterMs+.1*Math.min(1000,variation);}
   this.lastArrival=arrivalMs;this.lastDuration=duration;
   const minimum=mode==='saver'?.28:.065,maximum=mode==='high'?.12:.35;
   this.target=Math.max(minimum,Math.min(Math.max(minimum,maximum),.04+duration+this.jitterMs*.003));
   let reset=false,underrun=false;
   if(this.next>now+1.2){reset=true;this.resyncs++;this.next=now+this.target;}
   else if(!this.next||this.next<now+.003){underrun=!!this.next;if(underrun)this.underruns++;this.next=now+this.target;}
   const startAt=this.next;this.next+=duration;this.packets++;
   return {startAt,reset,underrun,target:this.target,jitterMs:this.jitterMs};
  }
  stats(now){return {packets:this.packets,underruns:this.underruns,resyncs:this.resyncs,jitterMs:Math.round(this.jitterMs),targetBufferMs:Math.round(this.target*1000),queuedMs:Math.max(0,Math.round((this.next-now)*1000))};}
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={PcmResampler,RawPlayout};else root.VmtAudioClock={PcmResampler,RawPlayout};
})(typeof window!=='undefined'?window:globalThis);
