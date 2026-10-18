const test=require('node:test');
const assert=require('node:assert/strict');
const {Controller}=require('../public/tts-cadence');
test('catch-up is gradual, bounded and returns to normal when the queue drains',()=>{
 const c=new Controller();
 assert.equal(c.update(10000,3),1.02);
 for(let i=0;i<30;i++)c.update(10000,3);
 assert.equal(c.rate,1.15);
 for(let i=0;i<10;i++)c.update(0,0);
 assert.equal(c.rate,1);
});
test('disabling restores natural rate immediately and prevents catch-up',()=>{
 const c=new Controller();for(let i=0;i<10;i++)c.update(5000,2);
 c.setEnabled(false);assert.equal(c.rate,1);assert.equal(c.update(60000,10),1);
 c.setEnabled(true);assert.equal(c.update(60000,10),1.02);
 c.reset();assert.equal(c.rate,1);
});
