/* RipStitch service worker: network-first for the app shell so updates land
   immediately, with a cached copy for offline use. Never touches the engine. */
const CACHE='ripstitch-v3';
const SHELL=['./','index.html','css/app.css','css/rip.css','css/stitch.css','js/core.js','js/stitch.js','js/rip.js','js/boot.js',
  'img/logo.svg','img/favicon.svg','img/strip.svg','img/icon-192.png','manifest.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.includes('/api/'))return;
  e.respondWith(fetch(e.request).then(r=>{
    if(r.ok&&r.type==='basic'){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy))}
    return r;
  }).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))));
});
