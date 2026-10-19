'use strict';
const MAX_SOURCES=Math.max(2,Math.min(16,Math.floor(Number(process.env.MAX_EVENT_SOURCES)||8)));
function wrapAudio(sourceId,data){const id=Buffer.from(sourceId);if(id.length>64)throw Error('Entrada inválida');return Buffer.concat([Buffer.from([0xab,id.length]),id,Buffer.from(data)]);}
function sourceView(client){return{id:client.clientId,name:client.sourceName||'Dispositivo',muted:!!client.sourceMuted,active:!!client.sourceActive};}
module.exports={MAX_SOURCES,wrapAudio,sourceView};
