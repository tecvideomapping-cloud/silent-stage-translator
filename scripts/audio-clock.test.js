const test=require('node:test'),assert=require('node:assert/strict');const {PcmResampler,RawPlayout}=require('../public/audio-clock');
test('resampling preserves sample count across frame boundaries rather than accumulating clock drift',()=>{
 for(const sourceRate of [48000,44100]){const resampler=new PcmResampler();let samples=0;const block=new Float32Array(2048).fill(.25);for(let i=0;i<4000;i++)samples+=resampler.process(block,sourceRate,16000).length;assert.ok(Math.abs(samples-Math.floor(4000*2048*16000/sourceRate))<=1);}
});
test('stateful anti-alias integration gives the same signal for different capture block sizes',()=>{
 const input=Float32Array.from({length:12000},(_,i)=>Math.sin(i*.1));const whole=new PcmResampler().process(input,48000,16000);const streaming=new PcmResampler();const chunks=[];for(let i=0;i<input.length;i+=2048)chunks.push(...streaming.process(input.subarray(i,i+2048),48000,16000));assert.deepEqual(new Float32Array(chunks),whole);
});
test('raw scheduling remains continuous under ordinary packet jitter',()=>{
 const scheduler=new RawPlayout();let previousEnd=null;for(let i=0;i<100;i++){const arrival=i*.04+(i%2?.012:0),slot=scheduler.schedule(arrival,arrival*1000,.04);if(previousEnd!==null)assert.ok(Math.abs(slot.startAt-previousEnd)<1e-8);previousEnd=slot.startAt+.04;}assert.equal(scheduler.underruns,0);
});
test('network underruns expand the actual buffer and excessive backlog explicitly resets before rescheduling',()=>{
 const scheduler=new RawPlayout();scheduler.schedule(1,1000,.04);const late=scheduler.schedule(1.3,1300,.04);assert.equal(late.underrun,true);assert.ok(late.startAt>=1.3+.065);scheduler.next=10;const reset=scheduler.schedule(2,2000,.04);assert.equal(reset.reset,true);assert.ok(reset.startAt>2&&reset.startAt<=2.5);assert.equal(scheduler.resyncs,1);
});
test('high quality playout accommodates 128ms desktop packets without a buffer smaller than a packet',()=>{
 const scheduler=new RawPlayout();let previousEnd=null;for(let i=0;i<100;i++){const arrival=i*.128+(i%2?.08:0),slot=scheduler.schedule(arrival,arrival*1000,.128,'high');assert.ok(slot.target>=.168);if(previousEnd!==null)assert.ok(Math.abs(slot.startAt-previousEnd)<1e-8);previousEnd=slot.startAt+.128;}assert.equal(scheduler.underruns,0);
});
