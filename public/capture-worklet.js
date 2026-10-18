// Runs on the audio rendering thread. UI pauses cannot erase captured samples.
class SilentStageCapture extends AudioWorkletProcessor {
  constructor(){super();this.offset=0;this.left=new Float32Array(2048);this.right=new Float32Array(2048);}
  process(inputs){
    const input=inputs[0];if(!input?.length)return true;
    const left=input[0],right=input[1]||left;
    for(let i=0;i<left.length;i++){
      this.left[this.offset]=left[i];this.right[this.offset]=right[i];
      if(++this.offset===2048){this.port.postMessage({left:this.left,right:this.right,rate:sampleRate},[this.left.buffer,this.right.buffer]);this.left=new Float32Array(2048);this.right=new Float32Array(2048);this.offset=0;}
    }
    return true;
  }
}
registerProcessor('silent-stage-capture',SilentStageCapture);
