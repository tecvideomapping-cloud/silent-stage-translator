(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.VmtTtsCadence=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  class Controller {
    constructor(){this.enabled=true;this.rate=1;}
    reset(){this.rate=1;}
    setEnabled(enabled){this.enabled=Boolean(enabled);if(!this.enabled)this.reset();}
    update(waitMs,count){
      if(!this.enabled){this.reset();return 1;}
      const target=count>0?1+Math.min(0.15,Math.max(0,(waitMs-750)/20000)):1;
      this.rate=Math.max(1,Math.min(1.15,this.rate+Math.max(-0.02,Math.min(0.02,target-this.rate))));
      return this.rate;
    }
  }
  return {Controller};
});
