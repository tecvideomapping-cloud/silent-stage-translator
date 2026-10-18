(()=>{
  const modules=new WeakMap();
  window.createStageAudioCapture=async context=>{
    if(!context.audioWorklet||typeof AudioWorkletNode==='undefined')throw Error('A captura contínua precisa de AudioWorklet. Atualize o aplicativo ou use Chrome/Edge em HTTPS.');
    if(!modules.has(context))modules.set(context,context.audioWorklet.addModule('/capture-worklet.js'));
    await modules.get(context);
    const node=new AudioWorkletNode(context,'silent-stage-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:2,channelCountMode:'explicit'});
    node.port.onmessage=({data})=>{if(typeof node.onaudioprocess==='function')node.onaudioprocess({inputBuffer:{numberOfChannels:2,getChannelData:index=>index===0?data.left:data.right},sampleRate:data.rate});};
    const disconnect=node.disconnect.bind(node);node.disconnect=(...args)=>{node.onaudioprocess=null;node.port.onmessage=null;node.port.close();return disconnect(...args);};
    return node;
  };
})();
