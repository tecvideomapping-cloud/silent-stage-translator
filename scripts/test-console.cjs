// Node 22 test-runner IPC can misframe non-ASCII console output (#65934).
// Preserve every message and assertion; only escape console text in test children.
if(process.env.NODE_TEST_CONTEXT){
 const {format}=require('node:util');
 for(const method of ['log','info','warn','error','debug']){
  const original=console[method].bind(console);
  console[method]=(...args)=>original(format(...args).replace(/[^\x00-\x7f]/gu,char=>'\\u{'+char.codePointAt(0).toString(16)+'}'));
 }
}
