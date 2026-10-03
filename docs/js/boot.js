'use strict';
/* RipStitch boot: pick the starting tool, handle shared links, go offline-capable. */
(function boot(){
  const order=['Go','Rip','Stitch','Help'];
  App.cmds.sort((a,b)=>order.indexOf(a.group)-order.indexOf(b.group));

  // Links arrive via ?url= (bookmarklet / deep link) or the OS share sheet (?text= / ?title=).
  const qs=new URLSearchParams(location.search);
  const shared=findUrl(qs.get('url'))||findUrl(qs.get('text'))||findUrl(qs.get('title'));
  const h=location.hash.slice(1);
  const pref=LS.get('start','last');
  const start=shared?'rip':App.mods[h]?h:App.mods[pref]?pref:LS.get('mod','rip');
  if(qs.toString())history.replaceState(null,'',location.pathname+'#'+start);
  App.go(start,{force:true});
  Rip.init();
  if(shared)Rip.read(shared);

  if(!APP&&'serviceWorker'in navigator&&(location.protocol==='https:'||['127.0.0.1','localhost'].includes(location.hostname))){
    addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
  }
  console.log('%cRip%cStitch','font:800 22px system-ui;color:#ff7a22','font:800 22px system-ui;color:#ffd21e','\n· Matty P from I.T.');
})();
