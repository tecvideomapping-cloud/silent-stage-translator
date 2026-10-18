const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('gate holds across quiet syllables, closes on a real pause and reopens on speech',()=>{
 const window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/stage-dsp.js'),'utf8'),{window});const ctx={currentTime:1},dsp=new window.StageAudioDSP(ctx),changes=[];dsp.mode='stage_mic';dsp.isInitialized=true;dsp.noiseGateGainNode={gain:{cancelScheduledValues(){},setTargetAtTime:v=>changes.push(v)}};
 dsp.processRms(.1);ctx.currentTime+=.10;dsp.processRms(.001);assert.equal(dsp.isGateOpen,true);assert.equal(changes.length,0);
 ctx.currentTime+=.10;dsp.processRms(.001);assert.equal(dsp.isGateOpen,false);assert.equal(changes.length,1);ctx.currentTime+=.02;dsp.processRms(.1);assert.equal(dsp.isGateOpen,true);assert.equal(changes.length,2);
});
