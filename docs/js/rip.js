'use strict';
/* ============================================================
   Rip: reads links through the RipStitch Engine (yt-dlp on your
   own computer) and runs the download queue. Born as HAUL.
   ============================================================ */
const Rip=(()=>{
const DEFAULT_BASE='http://127.0.0.1:8731';
const HOSTED_ENGINE='https://mattymattmattmatt.github.io/RipStitch/engine/ripstitch_engine.py';
const ENGINE_LATEST='1.3.0';   // keep in step with VERSION in docs/engine/ripstitch_engine.py
const WIN_SETUP='https://github.com/mattymattmattmatt/RipStitch/releases/download/engine-latest/RipStitch-Setup.exe';
const WIN_SIZE='95 MB';
const DESKTOP_EXE='https://github.com/mattymattmattmatt/RipStitch/releases/download/desktop-latest/RipStitch.exe';
const LOOP=['127.0.0.1','localhost','[::1]'];
const ACTIVE=['queued','running','merging'];
const E={base:LS.get('engine.base',null)||DEFAULT_BASE,state:'idle',health:null,token:null,cfg:null,tries:0,timer:0,userAsked:false,wasOnline:false};
const R={cur:null,url:'',pl:false,auto:LS.get('rip.auto',false),sel:null,filter:'all',sort:null,section:{on:false,start:0,end:0,precise:false},
  jobs:[],prev:new Map(),openLogs:new Set(),logN:new Map(),els:new Map(),sent:new Set(LS.get('rip.sent',[])),autoIds:new Set(LS.get('rip.autoIds',[])),
  reading:null,pending:null,pollT:0,lastHealth:0,plSel:new Set(),plLast:null,plFolder:LS.get('rip.plFolder',true),plNumber:LS.get('rip.plNumber',true)};

/* ---------- small helpers ---------- */
const clock=s=>{if(s==null||!isFinite(s))return'—';s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?`${h}:${pad2(m)}:${pad2(x)}`:`${m}:${pad2(x)}`};
const compact=n=>{try{return new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(n)}catch{return String(n)}};
const trunc=(s,n=60)=>{s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s};
const host=u=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch{return''}};
function vcName(c){if(!c)return null;c=c.toLowerCase();if(/^(avc|h264)/.test(c))return'H.264';if(/^(hev|hvc|h265|dvh)/.test(c))return'HEVC';if(/^vp0?9/.test(c))return'VP9';if(/^vp0?8/.test(c))return'VP8';if(/^av01/.test(c))return'AV1';if(c.startsWith('mp4v'))return'MPEG-4';return c.split('.')[0].toUpperCase()}
function acName(c){if(!c)return null;c=c.toLowerCase();if(c.startsWith('mp4a')||c==='aac')return'AAC';if(c.startsWith('opus'))return'Opus';if(c.startsWith('vorbis'))return'Vorbis';if(c.startsWith('mp3')||c==='mp4a.40.34')return'MP3';if(c==='ac-3')return'AC-3';if(c==='ec-3')return'E-AC-3';if(c.startsWith('flac'))return'FLAC';return c.split('.')[0].toUpperCase()}
const SITE={Youtube:'YouTube',YoutubeTab:'YouTube',YoutubeShortsAudioPivot:'YouTube',Vimeo:'Vimeo',Twitter:'X / Twitter',TikTok:'TikTok',Generic:'Web page',Reddit:'Reddit',Instagram:'Instagram',Facebook:'Facebook',Dailymotion:'Dailymotion',BiliBili:'Bilibili',Soundcloud:'SoundCloud',SoundcloudSet:'SoundCloud',Bandcamp:'Bandcamp',Twitch:'Twitch'};
const siteName=x=>{if(!x)return'';if(SITE[x])return SITE[x];const b=x.replace(/(Tab|Playlist|Set|Track|Clips?|Vod|VOD|Video|User|Channel|Stream|Live)$/,'');return SITE[b]||b};
const isPlaylistUrl=u=>{try{const x=new URL(u);return!!x.searchParams.get('list')||/\/(playlist|sets|album)s?\b/.test(x.pathname)}catch{return false}};
const pureList=u=>{try{const x=new URL(u);return(/\/playlist\/?$/.test(x.pathname)&&!!x.searchParams.get('list'))||/\/(sets|album)\//.test(x.pathname)||/\/@[^/]+\/?(videos|shorts|streams)?\/?$/.test(x.pathname)}catch{return false}};

/* ============================================================
   ENGINE CONNECTION
   ============================================================ */
async function api(path,body,o={}){
  const ctl=new AbortController(),to=setTimeout(()=>ctl.abort(),o.timeout||15000);
  if(o.signal)o.signal.addEventListener('abort',()=>ctl.abort(),{once:true});
  let r;
  try{r=await fetch((o.base||E.base)+path,body===undefined?{signal:ctl.signal,cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctl.signal,cache:'no-store'})}
  catch(e){clearTimeout(to);const err=new Error(o.signal?.aborted?'Cancelled':e.name==='AbortError'?'The engine took too long to answer':'Can’t reach the RipStitch Engine');err.offline=e.name!=='AbortError';err.aborted=!!o.signal?.aborted;throw err}
  clearTimeout(to);
  let d;try{d=await r.json()}catch{throw new Error(`Engine answered ${r.status} without data`)}
  if(!r.ok||d.ok===false){const err=new Error(d.error||`Request failed (${r.status})`);err.status=r.status;throw err}
  return d;
}
async function lnaState(){
  if(!navigator.permissions?.query)return null;
  for(const name of['loopback-network','local-network-access','local-network']){
    try{return(await navigator.permissions.query({name})).state}catch{}
  }
  return null;
}
async function connect(user){
  if(user)E.userAsked=true;
  clearTimeout(E.timer);
  const local=LOOP.includes(location.hostname);
  if(!user&&!E.userAsked&&!LS.get('engine.ok')&&!local){
    const st=await lnaState();
    if(st==='prompt'){setState('idle');return}   // wait for a click, so the browser's permission prompt has context
    if(st==='denied'){setState('denied');return}
  }
  if(E.state!=='online')setState('checking');
  try{
    const h=await api('/api/health',undefined,{timeout:6000});
    onHealth(h);E.tries=0;
    if(E.state!=='online'){
      const back=E.wasOnline;setState('online');E.wasOnline=true;LS.set('engine.ok',1);
      if(user||back)toast(back?'Engine reconnected':'Engine connected',{kind:'ok',sub:h.ytdlp?`yt-dlp ${h.ytdlp} · saving to ${h.out_dir}`:'yt-dlp still needs installing: open Settings → Engine.'});
      if(R.pending){const u=R.pending;R.pending=null;read(u)}
    }
    pollJobs(true);
  }catch(e){
    let alive=false;
    try{await fetch(E.base+'/api/ping',{mode:'no-cors',cache:'no-store'});alive=true}catch{}
    const st=alive?'untrusted':((await lnaState())==='denied'?'denied':'offline');
    if(E.state==='online')toast('Lost the engine',{kind:'warn',sub:'Is its window still open? Reconnecting…'});
    setState(st);E.tries++;
    if(st!=='denied')E.timer=setTimeout(()=>connect(false),document.hidden?15000:E.tries<30?3000:12000);
  }
}
function onHealth(h){E.health=h;E.token=h.token;E.cfg=h.config;R.lastHealth=Date.now();renderTop();renderEngine();Settings.refresh('downloads');Settings.refresh('engine')}
function setState(s){if(E.state===s)return;E.state=s;renderTop();renderEngine();renderJobs();Settings.refresh('downloads');Settings.refresh('engine');if(s!=='online'){clearTimeout(R.pollT)}}
async function refreshHealth(){try{onHealth(await api('/api/health'))}catch(e){if(e.offline)connect(false)}}

/* ---------- top bar ---------- */
function renderTop(){
  const dot=$('#engDot'),txt=$('#engTxt'),h=E.health,on=E.state==='online';
  dot.className='dot '+({online:'on',checking:'wait',offline:'wait',idle:'',denied:'bad',untrusted:'bad'}[E.state]||'');
  txt.textContent=on?(h.ytdlp?`yt-dlp ${h.ytdlp}`:'yt-dlp missing'):{checking:'Connecting…',offline:'Engine offline',idle:'Connect engine',denied:'Engine blocked',untrusted:'Engine untrusted'}[E.state];
  $('#engPill').dataset.tip=on?`RipStitch Engine ${h.version} · click for details`:'Rip needs the RipStitch Engine · click to set up';
  const ff=$('#tcFF'),fr=$('#tcFree');ff.hidden=fr.hidden=!on;
  if(on){ff.className='tchip hide-md '+(h.ffmpeg?'good':'bad');ff.innerHTML=`ffmpeg <b>${h.ffmpeg?'ready':'missing'}</b>`;fr.innerHTML=`<b>${h.free_bytes!=null?fmtBytes(h.free_bytes):'—'}</b> free`;$('#rFolderTxt').textContent='\u200E'+h.out_dir+'\u200E'}
}

/* ---------- engine onboarding card ---------- */
function osGuess(){const p=(navigator.userAgentData?.platform||navigator.platform||navigator.userAgent).toLowerCase();return p.includes('win')?'win':(p.includes('mac')||/iphone|ipad/.test(p))?'mac':'linux'}
let OS=LS.get('rip.os',null)||osGuess();
function engineUrl(){return location.protocol==='https:'?new URL('engine/ripstitch_engine.py',location.href).href:HOSTED_ENGINE}
function installUrl(){return engineUrl().replace(/ripstitch_engine\.py$/,'install.sh')}
const code=(c,label)=>`<div class="code"><code>${esc(c)}</code><button class="btn sm" data-copy="${esc(c)}" data-tip="Copy">${ic('copy')}${label||'Copy'}</button></div>`;
const vcmp=(a,b)=>{const x=String(a||'0').split('.').map(Number),y=String(b||'0').split('.').map(Number);for(let i=0;i<3;i++){const d=(x[i]||0)-(y[i]||0);if(d)return d}return 0};
function renderEngine(){
  const box=$('#rEngine'),h=E.health;
  if(E.state==='online'){
    const notes=[];
    if(vcmp(h.version,ENGINE_LATEST)<0&&h.install!=='desktop')notes.push(`<div class="callout info">${ic('spark')}<div><b>Engine update available</b> (${esc(h.version)} → ${ENGINE_LATEST}). It takes a few seconds and keeps your settings and downloads.<br><button class="btn sm rip" data-act="selfupdate">${ic('reset')}Update the engine</button></div></div>`);
    if(!h.ytdlp)notes.push(`<div class="callout bad">${ic('warn')}<div><b>yt-dlp isn’t installed in the engine yet.</b> It does the actual downloading.<br><button class="btn sm rip" data-act="install">${ic('dl')}Install yt-dlp now</button></div></div>`);
    if(!h.ffmpeg)notes.push(`<div class="callout">${ic('warn')}<div><b>FFmpeg is missing.</b> Without it, sites that split video and audio (YouTube above 720p) only offer lower qualities, and audio conversion, section clips and embedding are off. ${h.platform==='windows'?'Reinstalling with the <a href="'+WIN_SETUP+'">Windows installer</a> includes it.':'Run the install command from the Rip tab again, or install FFmpeg and restart the engine.'}</div></div>`);
    box.innerHTML=notes.join('');box.style.marginTop=notes.length?'18px':'';
    return;
  }
  box.style.marginTop='';
  const where=esc(E.base.replace(/^https?:\/\//,''));
  const st={
    idle:['','Not connected yet. Installed already? Press Connect.',`<button class="btn sm rip" data-act="connect">${ic('plug')}Connect</button>`],
    checking:['wait',`Looking for the engine on ${where}…`,''],
    offline:['wait',`Waiting for the engine on ${where}. This page connects by itself as soon as it’s running.`,`<button class="btn sm" data-act="connect">${ic('reset')}Retry now</button>`],
    denied:['bad','Your browser is blocking this page from reaching apps on your computer.',`<button class="btn sm" data-act="connect">${ic('reset')}Try again</button>`],
    untrusted:['bad','The engine is running, but it doesn’t trust this site yet.',`<button class="btn sm" data-act="connect">${ic('reset')}Retry</button>`],
  }[E.state];
  const extra=E.state==='denied'?`<div class="callout bad" style="margin:14px 20px 0">${ic('shield')}<div>Click the site-settings icon at the left of the address bar, set <b>Local network access</b> (or “Apps on this device”) to <b>Allow</b>, then press Try again.</div></div>`
    :E.state==='untrusted'?`<div class="callout bad" style="margin:14px 20px 0">${ic('shield')}<div>Restart the engine with this site added:${code((OS==='win'?'py':'python3')+' ripstitch_engine.py --allow-origin '+location.origin)}</div></div>`
    :E.state==='idle'&&LS.get('engine.downloaded',0)?`<div class="callout info" style="margin:14px 20px 0">${ic('info')}<div>Installed it? Press <b>Connect</b>. Your browser may ask to let this site talk to apps on your device. Choose <b>Allow</b>.</div></div>`:'';
  const py=OS==='win'?'py':'python3',url=engineUrl();
  const sh=`curl -fsSL ${installUrl()} | bash`;
  const main=OS==='win'?`
      <div class="rp-get">
        <a class="btn rip lg rp-dl" href="${WIN_SETUP}" data-act="dlwin">${ic('dl')}<span>Download RipStitch for Windows</span></a>
        <span class="note">Free · about ${WIN_SIZE} · Windows 10 and 11 · no admin rights needed</span>
      </div>
      <p class="note" style="padding:2px 20px 0">Rather have a standalone program? <a href="${DESKTOP_EXE}">Get RipStitch Desktop</a>: Rip and Stitch in their own window, nothing to install, no browser needed.</p>
      <div class="rp-steps rp-steps-sm">
        <div class="rp-step"><div><b>Run RipStitch-Setup.exe and click Install</b><p>Python, yt-dlp, FFmpeg and Deno are all included. If Windows says <i>“Windows protected your PC”</i>, click <b>More info</b> → <b>Run anyway</b>; the installer just isn’t code-signed.</p></div></div>
        <div class="rp-step"><div><b>That’s it</b><p>The engine starts with Windows from now on, runs quietly in the background and keeps yt-dlp up to date. This page connects by itself.</p></div></div>
      </div>`:`
      <div class="rp-steps rp-steps-sm">
        <div class="rp-step"><div><b>Paste this into Terminal</b><p>It installs anything missing (Python, FFmpeg, Deno), sets up the engine for your user only, and starts it at login.</p>${code(sh)}</div></div>
        <div class="rp-step"><div><b>That’s it</b><p>The engine runs quietly in the background and keeps yt-dlp up to date. This page connects by itself. To remove it later, run the same line with <span class="mono">-s -- --uninstall</span> after <span class="mono">bash</span>.</p></div></div>
      </div>`;
  const deps={win:['winget install -e --id Python.Python.3.12','winget install -e --id Gyan.FFmpeg'],mac:['brew install python ffmpeg'],linux:['sudo apt install python3 python3-venv ffmpeg']}[OS];
  const get=OS==='win'?`irm ${url} -OutFile ripstitch_engine.py; ${py} ripstitch_engine.py`:`curl -fsSLO ${url} && ${py} ripstitch_engine.py`;
  box.innerHTML=`<div class="rp-card" id="rCard">
    <div class="rp-card-h"><div class="badge-ic">${ic('plug')}</div><div><h3>Set up Rip once, then it just works</h3>
      <p>Browsers can’t download from YouTube and friends on their own, so Rip uses the RipStitch Engine: a small helper that runs yt-dlp on your computer. Videos go straight into your Downloads folder and never pass through anyone’s server.</p></div></div>
    <div class="rp-status"><span class="dot ${st[0]}"></span><span>${st[1]}</span>${st[2]}</div>
    ${extra}
    <div class="rp-os"><span class="label">Your system</span><div class="seg" id="rOs"><button data-os="win" class="${OS==='win'?'on':''}">Windows</button><button data-os="mac" class="${OS==='mac'?'on':''}">macOS</button><button data-os="linux" class="${OS==='linux'?'on':''}">Linux</button></div></div>
    ${main}
    <details class="rp-more"><summary>Other ways: run the Python script yourself</summary>
      <div class="rp-steps">
        <div class="rp-step"><div><b>Install Python 3.10+ and FFmpeg</b>${deps.map(c=>code(c)).join('')}</div></div>
        <div class="rp-step"><div><b>Download the engine and start it</b>${code(get)}<p style="margin-top:8px">Or <a href="${esc(url)}" download="ripstitch_engine.py">download ripstitch_engine.py</a> and run <span class="mono">${py} ripstitch_engine.py</span>. Keep its window open while you rip.</p></div></div>
      </div>
    </details>
    <div class="rp-card-f">${ic('shield')}<span>The engine listens only on 127.0.0.1, answers only this site, and is open source.</span><div class="grow"></div><button class="btn sm flat" data-act="address">${ic('sliders')}Engine address</button></div>
  </div>`;
}
$('#rEngine').addEventListener('click',e=>{
  const c=e.target.closest('[data-copy]');if(c){copyText(c.dataset.copy);toast('Copied',{kind:'ok',sub:c.dataset.copy.length>70?trunc(c.dataset.copy,70):c.dataset.copy,ms:1800});return}
  const o=e.target.closest('[data-os]');if(o){OS=o.dataset.os;LS.set('rip.os',OS);renderEngine();return}
  const a=e.target.closest('[data-act]');if(!a)return;
  if(a.dataset.act==='connect')connect(true);
  else if(a.dataset.act==='install')updateYtdlp();
  else if(a.dataset.act==='selfupdate')selfUpdate(a);
  else if(a.dataset.act==='dlwin'){LS.set('engine.downloaded',Date.now());setTimeout(()=>connect(true),1500);toast('Downloading RipStitch-Setup.exe',{kind:'ok',sub:'Run it when it finishes. This page connects by itself once the engine starts.',ms:9000})}
  else if(a.dataset.act==='address'){
    const v=prompt('Engine address (default '+DEFAULT_BASE+'):',E.base);if(v==null)return;
    const b=(v.trim()||DEFAULT_BASE).replace(/\/+$/,'');
    if(!/^https?:\/\/[^/]+$/.test(b))return toast('That address should look like http://127.0.0.1:8731',{kind:'warn'});
    E.base=b;b===DEFAULT_BASE?LS.del('engine.base'):LS.set('engine.base',b);connect(true);
  }
});

/* ============================================================
   READING A LINK
   ============================================================ */
const urlIn=$('#rUrl');
function fault(msg){const f=$('#rFault');if(!msg){f.hidden=true;return}f.hidden=false;f.innerHTML=`${ic('warn')}<div style="white-space:pre-wrap">${esc(msg)}</div>`}
function setPl(on){R.pl=!!on;$('#rPl').checked=R.pl;suggest()}
function suggest(){
  const box=$('#rSuggest'),u=findUrl(urlIn.value);
  if(u&&!R.pl&&isPlaylistUrl(u)&&!pureList(u)){
    box.hidden=false;box.innerHTML=`${ic('list')}<span>This link is part of a playlist.</span><button class="btn sm" id="rSugGo">${ic('list')}Read the whole playlist</button>`;
    $('#rSugGo').onclick=()=>{setPl(true);read(u)};
  }else box.hidden=true;
}
async function read(raw){
  const url=findUrl(raw);
  fault(null);
  if(!url){fault(raw&&String(raw).trim()?'That doesn’t look like a web link. It should start with https://':'Paste a link first.');urlIn.focus();return}
  urlIn.value=url;
  if(pureList(url)&&!R.pl)setPl(true);
  suggest();
  if(E.state!=='online'){
    await connect(true);
    if(E.state!=='online'){R.pending=url;fault('The engine isn’t connected yet. Follow the steps below; this link is read automatically once it connects.');$('#rCard')?.scrollIntoView({behavior:'smooth',block:'start'});return}
  }
  if(!E.health?.ytdlp){fault('yt-dlp isn’t installed in the engine yet. Press “Install yt-dlp now” below.');return}
  R.reading?.abort();
  const ctl=new AbortController();R.reading=ctl;
  const bar=$('#rForm');bar.classList.add('reading');$('#rRead').disabled=true;
  const t0=Date.now(),site=host(url);
  const tick=()=>{$('#rReadingTxt').textContent=`Reading ${site}${R.pl?' playlist':''}… ${Math.round((Date.now()-t0)/1000)}s`};
  $('#rReading').hidden=false;tick();const iv=setInterval(tick,1000);
  try{
    const d=await api('/api/probe',{url,playlist:R.pl},{timeout:200000,signal:ctl.signal});
    if(R.reading!==ctl)return;
    show(d.result,url);
    remember(url,d.result);
  }catch(e){if(!e.aborted&&R.reading===ctl){fault(e.message);if(e.offline)connect(false)}}
  finally{if(R.reading===ctl){R.reading=null;clearInterval(iv);bar.classList.remove('reading');$('#rRead').disabled=false;$('#rReading').hidden=true}else clearInterval(iv)}
}
$('#rReadCancel').onclick=()=>{R.reading?.abort();R.reading=null;$('#rForm').classList.remove('reading');$('#rRead').disabled=false;$('#rReading').hidden=true};
$('#rForm').onsubmit=e=>{e.preventDefault();read(urlIn.value)};
urlIn.addEventListener('paste',()=>{const was=urlIn.value.trim();setTimeout(()=>{if(!was&&findUrl(urlIn.value))read(urlIn.value)},0)});
urlIn.addEventListener('input',()=>{fault(null);suggest()});
urlIn.addEventListener('keydown',e=>{if(e.key==='Escape'){urlIn.blur()}});
$('#rPl').onchange=e=>{R.pl=e.target.checked;suggest()};
$('#rAuto').checked=R.auto;
$('#rAuto').onchange=e=>setAuto(e.target.checked);
if(navigator.clipboard?.readText){$('#rPaste').hidden=false;$('#rPaste').onclick=pasteAndRead}
async function pasteAndRead(){
  try{const t=await navigator.clipboard.readText();const u=findUrl(t);if(!u)return toast('No link on the clipboard',{kind:'warn'});App.go('rip');read(u)}
  catch{toast('The browser blocked clipboard access',{kind:'warn',sub:'Click the link box and press '+MOD+'+V instead.'});urlIn.focus()}
}

/* ---------- recent links ---------- */
function remember(url,r){
  const list=LS.get('rip.recent',[]).filter(x=>x.url!==url);
  list.unshift({url,title:r.title,kind:r.kind,site:siteName(r.extractor)});
  LS.set('rip.recent',list.slice(0,8));
}
function renderRecent(){
  const box=$('#rRecent'),list=LS.get('rip.recent',[]);
  box.hidden=!!R.cur||!list.length;if(box.hidden)return;
  box.innerHTML=`<span class="label">Recent</span>`+list.map((x,i)=>`<button class="rp-rc" data-i="${i}" title="${esc(x.url)}">${ic(x.kind==='playlist'?'list':'reset')}<span>${esc(trunc(x.title,46))}</span><i data-x="${i}" title="Forget">${ic('x')}</i></button>`).join('');
}
$('#rRecent').onclick=e=>{
  const list=LS.get('rip.recent',[]);
  const x=e.target.closest('[data-x]');if(x){e.stopPropagation();list.splice(+x.dataset.x,1);LS.set('rip.recent',list);renderRecent();return}
  const b=e.target.closest('[data-i]');if(b){const it=list[+b.dataset.i];if(it){setPl(it.kind==='playlist');read(it.url)}}
};

/* ============================================================
   RESULT: video
   ============================================================ */
function show(r,url){
  R.cur=r;R.url=url;R.sel=null;R.filter='all';R.sort=null;
  R.section={on:false,start:0,end:r.duration||0,precise:false};
  $('#rHero').hidden=true;$('#rRecent').hidden=true;
  const box=$('#rSpec');box.hidden=false;
  if(r.kind==='playlist')renderPlaylist(r);else renderVideo(r);
  requestAnimationFrame(()=>box.scrollIntoView({behavior:'smooth',block:'start'}));
}
function closeSpec(){R.cur=null;$('#rSpec').hidden=true;$('#rSpec').innerHTML='';$('#rHero').hidden=false;renderRecent();urlIn.focus()}
function mediaHead(r,kindIcon){
  const bits=[];
  if(r.uploader)bits.push(esc(r.uploader));
  if(r.kind==='playlist'){bits.push(plural(r.count,'item'));const tot=(r.entries||[]).reduce((a,e)=>a+(e.duration||0),0);if(tot)bits.push(clock(tot)+' total')}
  else{
    if(r.view_count)bits.push(compact(r.view_count)+' views');
    if(r.upload_date)bits.push(new Date(r.upload_date.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3T12:00')).toLocaleDateString(undefined,{dateStyle:'medium'}));
  }
  const thumb=r.thumb||(r.entries&&r.entries.find(e=>e.thumb)?.thumb);
  return`<div class="rp-media">
    <div class="rp-thumb"><div class="ph-ic">${ic(kindIcon)}</div>${thumb?`<img src="${esc(thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:''}
      ${r.duration?`<span class="d">${clock(r.duration)}</span>`:''}${r.is_live?'<span class="live">LIVE</span>':''}</div>
    <div style="min-width:0"><div class="rp-src">${ic(r.kind==='playlist'?'list':'globe')}${esc(siteName(r.extractor)||host(R.url))}${r.kind==='playlist'?' · playlist':''}</div>
      <h2 class="rp-title selectable">${esc(r.title)}</h2><div class="rp-meta">${bits.map(b=>`<span>${b}</span>`).join('')}</div><div class="rp-tags" id="rTags"></div></div>
    <div class="rp-acts"><a class="btn flat io" href="${esc(r.webpage_url||R.url)}" target="_blank" rel="noopener noreferrer" data-tip="Open the original page">${ic('ext')}</a>
      <button class="btn flat io" data-act="copy" data-tip="Copy link">${ic('copy')}</button><button class="btn flat io" data-act="close" data-tip="Close" data-key="Esc">${ic('x')}</button></div>
  </div>`;
}
/** Emulates the engine's format choice to preview what a quick pick will grab. */
function choose(r,h,audioOnly){
  const fm=r.formats||[],ff=!!E.health?.ffmpeg,dur=r.duration||0;
  const sz=f=>f?(f.filesize||(f.tbr&&dur?f.tbr*125*dur:0)):0;
  const bestA=fm.find(f=>f.video_absent&&!f.audio_absent);
  if(audioOnly){const a=bestA||fm.find(f=>!f.audio_absent);return{a,size:sz(a),approx:!a?.exact_size}}
  const fit=f=>h==null||!f.height||f.height<=h;
  let v=ff?fm.find(f=>!f.video_absent&&fit(f)):fm.find(f=>!f.video_absent&&!f.needs_audio&&fit(f));
  if(!v)v=ff?fm.find(f=>!f.video_absent):fm.find(f=>!f.video_absent&&!f.needs_audio);
  if(!v)return{size:0};
  const a=v.needs_audio&&ff?bestA:null;
  return{v,a,size:sz(v)+sz(a),approx:!(v.exact_size&&(!a||a.exact_size))};
}
const LADDER=[4320,2160,1440,1080,720,480,360,240,144];
function heights(r){
  const out=new Map();
  for(const f of r.formats||[]){
    if(f.video_absent||!f.height)continue;
    const s=f.width?Math.min(f.width,f.height):f.height;
    const lab=LADDER.find(x=>Math.abs(x-s)/x<0.12)||s;
    out.set(lab,Math.max(out.get(lab)||0,f.height));
  }
  return[...out.entries()].sort((a,b)=>b[0]-a[0]);
}
function sectFactor(r){return R.section.on&&r.duration?Math.max(0,R.section.end-R.section.start)/r.duration:1}
function renderVideo(r){
  const h=E.health||{},ff=!!h.ffmpeg,hs=heights(r);
  const notes=[];
  if(r.is_live)notes.push(`<div class="callout bad">${ic('pulse')}<div><b>Live right now.</b> Downloading records until the stream ends or you press Stop.</div></div>`);
  if(!ff&&(r.formats||[]).some(f=>f.needs_audio))notes.push(`<div class="callout">${ic('warn')}<div>FFmpeg isn’t installed, so only streams with built-in sound are offered. That’s usually 720p or lower on YouTube.</div></div>`);
  if(/^Youtube/.test(r.extractor||'')&&!h.js_runtime&&(r.formats||[]).filter(f=>!f.video_absent).length<4)notes.push(`<div class="callout info">${ic('info')}<div>YouTube offered only a few streams. Installing <b>Deno</b> on this computer unlocks the full list (see Settings → Engine).</div></div>`);
  const fm=r.formats||[];
  const picks=[];
  const best=choose(r,null);
  picks.push(pickHtml('best',best.v?(hs[0]?hs[0][0]+'p':'Best'):'Best',[vcName(best.v?.vcodec),best.v?.fps>30?Math.round(best.v.fps)+'fps':null,best.v?.hdr&&best.v.hdr!=='SDR'?best.v.hdr:null].filter(Boolean).join(' · ')||'top quality',best,'best','Best quality'));
  hs.slice(1,5).forEach(([lab,H])=>{const c=choose(r,H);picks.push(pickHtml(String(H),lab+'p',[vcName(c.v?.vcodec),c.v?.fps>30?Math.round(c.v.fps)+'fps':null].filter(Boolean).join(' · ')||'video',c,'',lab+'p'))});
  const au=choose(r,null,true);
  if(fm.some(f=>!f.audio_absent)||!fm.length)picks.push(pickHtml('audio',`${ic('music')}Audio`,ff?`${(E.cfg?.audio_codec||'mp3').toUpperCase()} · best quality`:`${acName(au.a?.acodec)||'original'} · as is`,au,'aud','Audio only'));
  const chap=r.chapters||[];
  $('#rSpec').innerHTML=`${mediaHead(r,'film')}
    <div class="rp-notes">${notes.join('')}</div>
    <div class="rp-h"><h3>Quick grab</h3><div class="r"><span class="note">One click queues it. Downloads appear on the right.</span></div></div>
    <div class="rp-picks" id="rPicks">${picks.join('')}</div>
    ${!r.is_live?`<div class="rp-sect" id="rSect">
      <div class="rp-sect-h"><label class="swrow inline"><input type="checkbox" class="sw" id="rSectOn" ${ff?'':'disabled'}><span>Only grab part of it</span></label>
        <span class="note">${ff?'Saves time and space: set a start and end, or pick a chapter.':'Needs FFmpeg on your computer.'}</span></div>
      <div class="rp-sect-b" id="rSectB" hidden>
        ${r.duration?`<div class="rp-range" id="rRange"><div class="rail"></div>${chap.slice(1).map(c=>`<div class="chap" style="left:${c.start/r.duration*100}%" title="${esc(c.title)}"></div>`).join('')}<div class="sel" id="rRSel"></div><div class="hd" id="rH0" tabindex="0" role="slider" aria-label="Start"></div><div class="hd" id="rH1" tabindex="0" role="slider" aria-label="End"></div></div>`:'<p class="note" style="margin:0 0 4px">This site didn’t report the length, so type the start and end.</p>'}
        <div class="rp-sect-f">
          <div class="fld"><label for="rS0">Start</label><input class="inp" id="rS0" spellcheck="false"></div>
          <div class="fld"><label for="rS1">End</label><input class="inp" id="rS1" spellcheck="false"></div>
          ${chap.length?`<div class="fld"><label for="rChap">Chapter</label><select class="inp" id="rChap"><option value="">Pick a chapter…</option>${chap.map((c,i)=>`<option value="${i}">${esc(trunc(c.title||'Chapter '+(i+1),50))} · ${clock(c.start)}</option>`).join('')}</select></div>`:`<div class="len" id="rSLen"></div>`}
        </div>
        <div class="rp-sect-x">${chap.length?'<span class="len" id="rSLen" style="font:12px var(--mono);color:var(--dim)"></span>':''}<label class="swrow inline" data-tip="Re-encodes the edges so the clip starts exactly on time (slower)"><input type="checkbox" class="sw" id="rPrecise"><span>Frame-accurate cut</span></label></div>
      </div></div>`:''}
    <div class="rp-h"><h3>All streams</h3><div class="r"><div class="seg" id="rFilt"><button data-f="all" class="on">All</button><button data-f="av">Video + audio</button><button data-f="v">Video</button><button data-f="a">Audio</button></div></div></div>
    <div class="rp-tablewrap"><table class="rp-t"><thead><tr>
      <th data-s="id">ID</th><th data-s="res">Quality</th><th data-s="fps" class="n">FPS</th><th data-s="vc">Video</th><th data-s="ac">Audio</th><th data-s="size" class="n">Size</th><th data-s="tbr" class="n hide-sm">Bitrate</th><th data-s="ext" class="hide-sm">Type</th><th class="hide-md">Note</th>
    </tr></thead><tbody id="rFmt"></tbody></table></div>
    <div class="rp-selbar"><button class="btn rip" id="rQueueSel" disabled>${ic('dl')}Download selected</button><code id="rEcho">Pick a row to choose an exact stream. Double-click queues it.</code></div>`;
  const tags=[];
  if(r.subtitles?.length)tags.push(`<span class="chip" title="${esc(r.subtitles.join(', '))}">Subtitles · ${r.subtitles.length}</span>`);
  if(r.chapters?.length)tags.push(`<span class="chip">${plural(r.chapters.length,'chapter')}</span>`);
  if(fm.some(f=>f.hdr&&f.hdr!=='SDR'))tags.push(`<span class="chip">HDR</span>`);
  if(hs[0])tags.push(`<span class="chip">Up to ${hs[0][0]}p</span>`);
  $('#rTags').innerHTML=tags.join('');
  drawFormats();wireSection(r);
}
function pickHtml(q,title,sub,c,cls,label){
  const f=sectFactor(R.cur);
  const size=c.size?`${c.approx?'≈ ':''}${fmtBytes(c.size*f)}`:'size unknown';
  return`<button class="rp-pick ${cls}" data-q="${q}" data-label="${esc(label)}" data-tip="Download ${esc(label)}">${ic('dl')}<b>${title}</b><span>${esc(sub)}</span><em>${size}</em></button>`;
}
function refreshPickSizes(){
  const r=R.cur;if(!r||r.kind!=='video')return;
  $$('#rPicks .rp-pick').forEach(b=>{const q=b.dataset.q,c=q==='audio'?choose(r,null,true):choose(r,q==='best'?null:+q);const em=b.querySelector('em');em.textContent=c.size?`${c.approx?'≈ ':''}${fmtBytes(c.size*sectFactor(r))}`:'size unknown'});
}

/* --- section (clip) picker --- */
function wireSection(r){
  const on=$('#rSectOn');if(!on)return;
  const dur=r.duration||0,S=R.section,max=dur||1e7;
  const sync=()=>{
    if(dur){
      $('#rRSel').style.left=S.start/dur*100+'%';$('#rRSel').style.width=(S.end-S.start)/dur*100+'%';
      $('#rH0').style.left=S.start/dur*100+'%';$('#rH1').style.left=S.end/dur*100+'%';
    }
    for(const[id,v]of[['#rS0',S.start],['#rS1',S.end]]){const el=$(id);if(document.activeElement!==el){el.value=v||id==='#rS0'?tc(v,v%1?2:0):'';el.classList.remove('bad')}}
    const l=$('#rSLen');if(l)l.innerHTML=S.end>S.start?`Length <b>${tc(S.end-S.start,1)}</b>${dur?` of ${clock(dur)}`:''}`:'';
    refreshPickSizes();
  };
  on.onchange=()=>{S.on=on.checked;$('#rSectB').hidden=!S.on;$('#rSect').classList.toggle('on',S.on);sync();if(S.on&&!dur)$('#rS1').focus()};
  const rng=$('#rRange');
  if(rng){
    rng.onpointerdown=e=>{
      e.preventDefault();const rect=rng.getBoundingClientRect();
      const tAt=ev=>clamp((ev.clientX-rect.left)/rect.width,0,1)*dur;
      const which=e.target.id==='rH0'?0:e.target.id==='rH1'?1:(Math.abs(tAt(e)-S.start)<Math.abs(tAt(e)-S.end)?0:1);
      const mv=ev=>{const t=Math.round(tAt(ev)*10)/10;if(which===0)S.start=clamp(t,0,S.end-0.5);else S.end=clamp(t,S.start+0.5,dur);sync()};
      mv(e);const up=()=>{removeEventListener('pointermove',mv);removeEventListener('pointerup',up)};addEventListener('pointermove',mv);addEventListener('pointerup',up);
    };
    for(const[id,k]of[['#rH0','start'],['#rH1','end']])$(id).onkeydown=e=>{
      const d=e.key==='ArrowLeft'?-1:e.key==='ArrowRight'?1:0;if(!d)return;e.preventDefault();
      const st=e.shiftKey?10:1;if(k==='start')S.start=clamp(S.start+d*st,0,S.end-0.5);else S.end=clamp(S.end+d*st,S.start+0.5,dur);sync();
    };
  }
  for(const[id,k]of[['#rS0','start'],['#rS1','end']]){
    const el=$(id);
    el.onchange=()=>{const v=parseTC(el.value);if(isNaN(v)){el.classList.add('bad');return}
      if(k==='start'){if(S.end&&v>=S.end-0.1){el.classList.add('bad');return toast('Start must be before the end',{kind:'warn'})}S.start=clamp(v,0,max)}
      else{if(v<=S.start+0.1){el.classList.add('bad');return toast('End must be after the start',{kind:'warn'})}S.end=clamp(v,0,max)}
      el.blur();sync()};
    el.onkeydown=e=>{if(e.key==='Enter')el.dispatchEvent(new Event('change'))};
  }
  const ch=$('#rChap');if(ch)ch.onchange=()=>{const c=r.chapters[+ch.value];if(!c)return;S.start=c.start;S.end=c.end??dur;sync()};
  $('#rPrecise').onchange=e=>{S.precise=e.target.checked};
  sync();
}
/* --- streams table --- */
const SORTS={
  id:f=>f.format_id,res:f=>(f.height||0)*1e4+(f.fps||0),fps:f=>f.fps||0,vc:f=>vcName(f.vcodec)||'',ac:f=>(f.abr||0)+(acName(f.acodec)?1:0),
  size:f=>f.filesize||0,tbr:f=>f.tbr||0,ext:f=>f.ext||'',
};
function drawFormats(){
  const r=R.cur,tb=$('#rFmt');if(!tb)return;
  let fm=(r.formats||[]).filter(f=>R.filter==='all'||(R.filter==='av'?!f.video_absent&&!f.needs_audio:R.filter==='v'?!f.video_absent:f.video_absent));
  if(R.sort){const g=SORTS[R.sort.k];fm=[...fm].sort((a,b)=>{const x=g(a),y=g(b);return(typeof x==='string'?collator.compare(x,y):x-y)*(R.sort.asc?1:-1)})}
  $$('.rp-t thead th').forEach(th=>{th.classList.toggle('s',!!R.sort&&R.sort.k===th.dataset.s);th.classList.toggle('asc',!!R.sort?.asc)});
  if(!fm.length){tb.innerHTML=`<tr><td colspan="9" class="m" style="padding:18px 12px">${(r.formats||[]).length?'Nothing matches this filter.':'This site didn’t list separate streams. Use a quick grab above.'}</td></tr>`;return}
  const bestId=choose(r,null).v?.format_id;
  tb.innerHTML=fm.map(f=>{
    const res=f.video_absent?'<span class="m">audio only</span>':f.height?`${f.width?f.width+'×':''}${f.height}`:'<span class="m">unknown</span>';
    const hdr=f.hdr&&f.hdr!=='SDR'&&!f.video_absent?`<span class="tg">${esc(f.hdr)}</span>`:'';
    const best=f.format_id===bestId?'<span class="tg o">BEST</span>':'';
    const vc=f.video_absent?'<span class="m">—</span>':f.vcodec?`<span title="${esc(f.vcodec)}">${esc(vcName(f.vcodec))}</span>`:'<span class="m">?</span>';
    const ac=f.acodec?`<span title="${esc(f.acodec)}">${esc(acName(f.acodec))}</span>${f.abr?` <span class="m">${Math.round(f.abr)}k</span>`:''}`:f.needs_audio?'<span class="tg o">+ best audio</span>':f.audio_absent?'<span class="m">—</span>':'<span class="m">?</span>';
    const size=f.filesize?`${f.exact_size?'':'≈'}${fmtBytes(f.filesize)}`:'<span class="m">—</span>';
    return`<tr data-id="${esc(f.format_id)}" class="${R.sel?.format_id===f.format_id?'sel':''}" tabindex="0"><td>${esc(f.format_id)}</td><td class="q">${res}${hdr}${best}</td><td class="n">${f.fps?Math.round(f.fps):'<span class="m">—</span>'}</td><td>${vc}</td><td>${ac}</td><td class="n">${size}</td><td class="n hide-sm">${f.tbr?Math.round(f.tbr)+'k':'<span class="m">—</span>'}</td><td class="hide-sm m">${esc(f.ext||'')} <span class="m">${esc((f.protocol||'').replace(/_.*$/,'').replace('https','http'))}</span></td><td class="hide-md m">${esc([f.note,f.lang].filter(Boolean).join(' · '))}</td></tr>`;
  }).join('');
}
function selectFormat(id){
  const f=(R.cur.formats||[]).find(x=>x.format_id===id);if(!f)return;
  R.sel=f;$$('#rFmt tr').forEach(tr=>tr.classList.toggle('sel',tr.dataset.id===id));
  $('#rQueueSel').disabled=false;
  const ff=!!E.health?.ffmpeg;
  $('#rEcho').textContent='-f '+(f.needs_audio&&ff?`${f.format_id}+bestaudio`:f.format_id)+(f.needs_audio&&!ff?'   (no FFmpeg: video without sound)':'');
}
function queueSelected(){
  const f=R.sel;if(!f)return;
  const label=f.video_absent?`Audio ${acName(f.acodec)||''} ${f.abr?Math.round(f.abr)+'k':''}`.trim():`${f.height?f.height+'p':'Stream'} · ${vcName(f.vcodec)||f.ext}`;
  enqueue({mode:'format',format_id:f.format_id,needs_audio:!!f.needs_audio,audio_only_format:!!f.video_absent,label});
}

/* ============================================================
   RESULT: playlist
   ============================================================ */
function renderPlaylist(r){
  const entries=(r.entries||[]).filter(e=>e.url);
  R.plSel=new Set(entries.map((_,i)=>i));R.plLast=null;
  $('#rSpec').innerHTML=`${mediaHead(r,'list')}
    <div class="rp-h"><h3>Download the selection</h3><div class="r"><span class="note" id="rPlN"></span></div></div>
    <div class="rp-picks" id="rPlPicks">
      <button class="rp-pick best" data-q="best" data-label="Best quality">${ic('dl')}<b>Best</b><span>top quality each</span><em data-n></em></button>
      <button class="rp-pick" data-q="1080" data-label="1080p">${ic('dl')}<b>1080p</b><span>or the closest below</span><em data-n></em></button>
      <button class="rp-pick" data-q="720" data-label="720p">${ic('dl')}<b>720p</b><span>smaller files</span><em data-n></em></button>
      <button class="rp-pick aud" data-q="audio" data-label="Audio only">${ic('dl')}<b>${ic('music')}Audio</b><span>${(E.cfg?.audio_codec||'mp3').toUpperCase()} each</span><em data-n></em></button>
    </div>
    <div class="rp-plopts">
      <label class="swrow inline"><input type="checkbox" class="sw" id="rPlFolder" ${R.plFolder?'checked':''}><span>Save in a folder named after the playlist</span></label>
      <label class="swrow inline"><input type="checkbox" class="sw" id="rPlNum" ${R.plNumber?'checked':''}><span>Number files in playlist order</span></label>
    </div>
    <div class="rp-h"><h3>Videos</h3></div>
    <div class="rp-pltools"><input class="inp" id="rPlQ" placeholder="Filter by title…" spellcheck="false"><button class="btn sm" id="rPlAll">All</button><button class="btn sm" id="rPlNone">None</button><button class="btn sm" id="rPlInv">Invert</button><span class="cnt" id="rPlCnt"></span></div>
    <div class="rp-pl" id="rPlList">${entries.slice(0,2000).map((e,i)=>`<label class="rp-pli" data-i="${i}"><input type="checkbox" class="chk-box" checked data-i="${i}"><u>${String(i+1).padStart(3,'0')}</u>${e.thumb?`<img src="${esc(e.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`:'<span class="noimg"></span>'}<span class="t"><b>${esc(e.title)}</b>${e.uploader?`<small>${esc(e.uploader)}</small>`:''}</span><u class="dur">${e.duration?clock(e.duration):''}</u></label>`).join('')}</div>
    ${entries.length>2000?`<p class="note" style="margin-top:8px">Showing the first 2,000 of ${entries.length}.</p>`:''}`;
  R.plEntries=entries;
  const list=$('#rPlList');
  const count=()=>{
    const n=R.plSel.size;$('#rPlCnt').textContent=`${n} of ${entries.length} selected`;
    $$('#rPlPicks [data-n]').forEach(e=>e.textContent=n?`${plural(n,'video')}`:'nothing selected');
    $$('#rPlPicks .rp-pick').forEach(b=>b.disabled=!n);
    $('#rPlN').textContent='Shift-click to select a range';
  };
  const setRow=(i,on)=>{on?R.plSel.add(i):R.plSel.delete(i);const row=list.querySelector(`.rp-pli[data-i="${i}"]`);if(row){row.querySelector('input').checked=on;row.classList.toggle('off',!on)}};
  list.addEventListener('click',e=>{
    const inp=e.target.closest('input');if(!inp)return;
    const i=+inp.dataset.i;
    if(e.shiftKey&&R.plLast!=null){const[a,b]=[Math.min(R.plLast,i),Math.max(R.plLast,i)];for(let k=a;k<=b;k++)if(!list.querySelector(`.rp-pli[data-i="${k}"]`)?.hidden)setRow(k,inp.checked)}
    else setRow(i,inp.checked);
    R.plLast=i;count();
  });
  const vis=()=>$$('.rp-pli',list).filter(x=>!x.hidden).map(x=>+x.dataset.i);
  $('#rPlAll').onclick=()=>{vis().forEach(i=>setRow(i,true));count()};
  $('#rPlNone').onclick=()=>{vis().forEach(i=>setRow(i,false));count()};
  $('#rPlInv').onclick=()=>{vis().forEach(i=>setRow(i,!R.plSel.has(i)));count()};
  $('#rPlQ').oninput=e=>{const q=e.target.value.trim().toLowerCase();$$('.rp-pli',list).forEach(x=>x.hidden=!!q&&!entries[+x.dataset.i].title.toLowerCase().includes(q))};
  $('#rPlFolder').onchange=e=>{R.plFolder=e.target.checked;LS.set('rip.plFolder',R.plFolder)};
  $('#rPlNum').onchange=e=>{R.plNumber=e.target.checked;LS.set('rip.plNumber',R.plNumber)};
  $('#rPlPicks').onclick=e=>{
    const b=e.target.closest('.rp-pick');if(!b)return;
    const idx=[...R.plSel].sort((a,b)=>a-b);if(!idx.length)return toast('Nothing selected',{kind:'warn'});
    const items=idx.map(i=>({url:entries[i].url,title:entries[i].title,thumb:entries[i].thumb,index:R.plNumber?i+1:null}));
    enqueue({mode:'quick',quality:b.dataset.q,label:b.dataset.label,items,folder:R.plFolder?r.title:null});
  };
  count();
}

$('#rSpec').addEventListener('click',e=>{
  const a=e.target.closest('[data-act]');
  if(a){if(a.dataset.act==='close')closeSpec();else if(a.dataset.act==='copy'){copyText(R.cur.webpage_url||R.url);toast('Link copied',{kind:'ok',ms:1600})}return}
  if(R.cur?.kind!=='video')return;
  const p=e.target.closest('#rPicks .rp-pick');if(p){enqueue({mode:'quick',quality:p.dataset.q,label:p.dataset.label});return}
  const fb=e.target.closest('#rFilt button');if(fb){R.filter=fb.dataset.f;$$('#rFilt button').forEach(x=>x.classList.toggle('on',x===fb));drawFormats();return}
  const th=e.target.closest('.rp-t th[data-s]');if(th){const k=th.dataset.s;R.sort=R.sort?.k===k?(R.sort.asc?null:{k,asc:true}):{k,asc:false};drawFormats();return}
  const tr=e.target.closest('#rFmt tr[data-id]');if(tr){selectFormat(tr.dataset.id);return}
  if(e.target.closest('#rQueueSel'))queueSelected();
});
$('#rSpec').addEventListener('dblclick',e=>{const tr=e.target.closest('#rFmt tr[data-id]');if(tr){selectFormat(tr.dataset.id);queueSelected()}});
$('#rSpec').addEventListener('keydown',e=>{const tr=e.target.closest('#rFmt tr[data-id]');if(tr&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectFormat(tr.dataset.id);if(e.key==='Enter')queueSelected()}});

/* ============================================================
   QUEUE
   ============================================================ */
async function enqueue(spec){
  const r=R.cur;if(!r)return;
  const items=spec.items||[{url:r.webpage_url||R.url,title:r.title,thumb:r.thumb}];
  const body={...spec,items};
  if(r.kind==='video'&&R.section.on){if(!(R.section.end>R.section.start))return toast('Set an end time for the section first',{kind:'warn'});body.section={start:R.section.start,end:R.section.end,precise:R.section.precise};body.label=(body.label||'')+` · ${clock(R.section.start)}–${clock(R.section.end)}`}
  try{
    const d=await api('/api/enqueue',body);
    if(R.auto&&spec.quality!=='audio'&&!spec.audio_only_format){d.ids.forEach(id=>R.autoIds.add(id));LS.set('rip.autoIds',[...R.autoIds])}
    toast(items.length>1?`Queued ${plural(items.length,'download')}`:`Queued “${trunc(items[0].title,48)}”`,{kind:'ok',sub:`${body.label||''}${R.auto&&spec.quality!=='audio'?' · goes to Stitch when done':''}`});
    pollJobs(true);
    const side=$('.rp-side');side.animate?.([{boxShadow:'inset 3px 0 0 var(--rip)'},{boxShadow:'inset 0 0 0 transparent'}],{duration:900});
  }catch(e){toast('Couldn’t queue that',{kind:'err',sub:e.message});if(e.offline)connect(false)}
}
async function pollJobs(now){
  clearTimeout(R.pollT);
  if(E.state!=='online')return;
  try{R.jobs=(await api('/api/jobs')).jobs}
  catch(e){if(e.offline){connect(false);return}}
  renderJobs();afterPoll();
  const busy=R.jobs.some(j=>ACTIVE.includes(j.status));
  if((busy||now)&&Date.now()-R.lastHealth>10000)refreshHealth();
  R.pollT=setTimeout(pollJobs,busy?700:document.hidden?10000:3000);
}
const ORDER={running:0,merging:0,queued:1};
function sorted(){
  return[...R.jobs].sort((a,b)=>{
    const oa=ORDER[a.status]??2,ob=ORDER[b.status]??2;if(oa!==ob)return oa-ob;
    if(oa===2)return(b.finished||b.created)-(a.finished||a.created);
    return a.created-b.created;
  });
}
const STATUS={queued:'Queued',running:'Downloading',merging:'Processing',done:'Done',error:'Failed',cancelled:'Stopped'};
function jobHtml(j){
  const pct=j.status==='done'?100:j.pct||0;
  const indet=j.status==='running'&&!j.total&&j.downloaded>0;
  const nums=[];
  if(j.status==='running'){
    if(j.total)nums.push(`<b>${pct.toFixed(1)}%</b>`,`<span>${fmtBytes(j.downloaded)} of ${j.estimated?'≈':''}${fmtBytes(j.total)}</span>`);else if(j.downloaded)nums.push(`<b>${fmtBytes(j.downloaded)}</b>`);
    if(j.speed)nums.push(`<b>${fmtBytes(j.speed)}/s</b>`);
    if(j.eta!=null&&j.total)nums.push(`<span>${clock(j.eta)} left</span>`);
    if(j.streams>1)nums.push(`<span>stream ${j.stream}/${j.streams}</span>`);
    if(j.frag)nums.push(`<span>frag ${esc(j.frag)}</span>`);
    if(!j.downloaded&&!j.total)nums.push(`<span>${esc(j.stage||'Starting')}</span>`);
  }else if(j.status==='merging')nums.push(`<b>${esc(j.stage||'Processing')}…</b>`);
  else if(j.status==='queued')nums.push('<span>Waiting for a free slot</span>');
  else if(j.status==='done'){
    if(j.size)nums.push(`<b>${fmtBytes(j.size)}</b>`);
    if(j.started&&j.finished)nums.push(`<span>took ${clock(j.finished-j.started)}</span>`);
    if(j.filename)nums.push(`<span title="${esc(j.dest||'')}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%">${esc(j.filename)}</span>`);
  }
  const sub=[j.label,j.folder?`📁 ${trunc(j.folder,28)}`:null].filter(Boolean).map(x=>`<span>${esc(x)}</span>`).join('');
  const acts=[];
  const B=(a,icon,label,cls='',tip='')=>`<button class="btn ${cls}" data-a="${a}" data-id="${j.id}"${tip?` data-tip="${esc(tip)}"`:''}>${ic(icon)}${label}</button>`;
  if(ACTIVE.includes(j.status))acts.push(B('cancel','stop','Stop','danger'));
  if(j.status==='done'&&j.file_ok&&j.kind!=='audio')acts.push(B('stitch','cut',R.sent.has(j.id)?'Again to Stitch':'Edit in Stitch','go','Load this file onto the Stitch timeline'));
  if(j.status==='done'&&j.file_ok)acts.push(B('reveal','open','Show','','Show in your file manager'));
  if(j.status==='error'||j.status==='cancelled')acts.push(B('retry','reset','Retry','',j.status==='cancelled'?'Resumes where it stopped':''));
  if(j.log_lines)acts.push(B('log','log',R.openLogs.has(j.id)?'Hide log':'Log','flat'));
  if(!ACTIVE.includes(j.status))acts.push(B('remove','x','','flat io','Remove from the list'));
  const thumb=j.thumb?`<img class="job-th" src="${esc(j.thumb)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'job-th'}))">`:'<div class="job-th"></div>';
  return`<div class="job-top">${thumb}<div style="min-width:0"><div class="job-title selectable" title="${esc(j.url)}">${esc(j.title)}</div><div class="job-sub"><span class="pill ${j.status}">${STATUS[j.status]||j.status}</span>${sub}</div></div></div>
    ${j.status==='done'&&!j.file_ok&&!j.note?'':`<div class="bar"><div class="fill${indet?' indet':''}" style="width:${pct}%"></div></div>`}
    ${nums.length?`<div class="job-nums">${nums.join('')}</div>`:''}
    ${j.note?`<div class="note2">${esc(j.note)}</div>`:''}
    ${j.status==='done'&&!j.file_ok&&!j.note?`<div class="note2">File was moved or deleted.</div>`:''}
    ${j.error?`<div class="err">${esc(j.error)}</div>`:''}
    <div class="job-acts">${acts.join('')}</div>`;
}
function renderJobs(){
  const box=$('#rJobs'),on=E.state==='online';
  if(!on||!R.jobs.length){
    R.els.clear();
    box.innerHTML=on?`<div class="rp-qempty">${ic('dl')}<b>Nothing downloading</b><span>Read a link, then pick a quality.<br>Your downloads show up here.</span></div>`
      :`<div class="rp-qempty">${ic('plug')}<b>Engine not connected</b><span>Downloads appear here once the RipStitch Engine is running.</span></div>`;
    $('#rCount').textContent='';updateBadges();return;
  }
  if(box.querySelector('.rp-qempty'))box.innerHTML='';
  const list=sorted(),seen=new Set();let prev=null;
  for(const j of list){
    seen.add(j.id);
    let el=R.els.get(j.id);
    if(!el){el=document.createElement('div');el.dataset.id=j.id;el.innerHTML='<div class="jm"></div><div class="log" hidden></div>';el._h='';R.els.set(j.id,el)}
    const cls='job '+j.status;if(el.className!==cls)el.className=cls;
    const h=jobHtml(j);if(el._h!==h){el._h=h;el.firstChild.innerHTML=h}
    const log=el.lastChild,open=R.openLogs.has(j.id);log.hidden=!open;
    if(open&&R.logN.get(j.id)!==j.log_lines){R.logN.set(j.id,j.log_lines);loadLog(j.id,log)}
    const want=prev?prev.nextSibling:box.firstChild;if(want!==el)box.insertBefore(el,want);prev=el;
  }
  for(const[id,el]of R.els)if(!seen.has(id)){el.remove();R.els.delete(id)}
  const act=R.jobs.filter(j=>ACTIVE.includes(j.status)).length,done=R.jobs.filter(j=>j.status==='done').length;
  $('#rCount').textContent=[act?`${act} active`:null,done?`${done} done`:null].filter(Boolean).join(' · ');
  updateBadges();
}
async function loadLog(id,el){
  try{
    const d=await api('/api/log/'+id);
    const stick=el.scrollTop+el.clientHeight>=el.scrollHeight-8;
    el.innerHTML=d.log.map(l=>`<div class="${l.level}">${esc(l.msg)}</div>`).join('')||'(empty)';
    if(stick)el.scrollTop=el.scrollHeight;
  }catch(e){el.textContent=e.message}
}
function sendable(){return R.jobs.filter(j=>j.status==='done'&&j.file_ok&&j.kind!=='audio'&&!R.sent.has(j.id))}
function updateBadges(){
  const act=R.jobs.filter(j=>ACTIVE.includes(j.status));
  const c=$('#ripCnt');c.hidden=!act.length;c.textContent=act.length;c.classList.toggle('live',act.length>0);
  const run=act.filter(j=>j.status!=='queued');
  document.title=run.length?`↓ ${Math.round(run.reduce((a,j)=>a+(j.pct||0),0)/run.length)}% · RipStitch`:'RipStitch · rip videos, stitch them together';
  const s=sendable(),b=$('#rToStitch');b.disabled=!s.length;b.hidden=!s.length;$('#rClear').hidden=!R.jobs.some(j=>!ACTIVE.includes(j.status));$('#rToStitchTxt').textContent=s.length?`Send ${plural(s.length,'finished clip')} to Stitch`:'Send finished to Stitch';
}
function afterPoll(){
  // notifications + auto-send for jobs that just finished
  const fresh=[];
  for(const j of R.jobs){
    const was=R.prev.get(j.id);
    if(was&&was!==j.status&&(j.status==='done'||j.status==='error'))fresh.push(j);
    R.prev.set(j.id,j.status);
  }
  for(const j of fresh){
    if(LS.get('notify',false)&&document.hidden&&'Notification'in window&&Notification.permission==='granted'){
      try{new Notification(j.status==='done'?'Download finished':'Download failed',{body:j.title,icon:'img/icon-192.png',tag:'rs-'+j.id})}catch{}
    }
    if(j.status==='error'&&!document.hidden&&App.mod!=='rip')toast('A download failed',{kind:'err',sub:j.title,action:{label:'Show',fn:()=>App.go('rip')}});
  }
  const auto=R.jobs.filter(j=>R.autoIds.has(j.id)&&!ACTIVE.includes(j.status));
  if(auto.length){
    auto.forEach(j=>R.autoIds.delete(j.id));LS.set('rip.autoIds',[...R.autoIds]);
    const ok=auto.filter(j=>j.status==='done'&&j.file_ok&&!R.sent.has(j.id));
    if(ok.length)toStitch(ok,{auto:true});
  }
}
$('#rJobs').addEventListener('click',async e=>{
  const b=e.target.closest('[data-a]');if(!b)return;
  const id=b.dataset.id,j=R.jobs.find(x=>x.id===id);if(!j)return;
  try{
    switch(b.dataset.a){
      case'cancel':await api('/api/cancel',{id});break;
      case'retry':await api('/api/retry',{id});break;
      case'remove':await api('/api/remove',{id});R.openLogs.delete(id);break;
      case'reveal':await api('/api/reveal',{id});break;
      case'stitch':await toStitch([j]);return;
      case'log':R.openLogs.has(id)?R.openLogs.delete(id):R.openLogs.add(id);R.logN.delete(id);renderJobs();return;
    }
    pollJobs(true);
  }catch(err){toast(err.message,{kind:'err'})}
});
$('#rClear').onclick=async()=>{if(E.state!=='online')return;try{await api('/api/clear',{});pollJobs(true)}catch(e){toast(e.message,{kind:'err'})}};
$('#rFolder').onclick=()=>{if(E.state!=='online')return toast('Connect the engine first',{kind:'warn'});api('/api/reveal',{}).catch(e=>toast(e.message,{kind:'err'}))};
$('#rToStitch').onclick=()=>{const s=sendable();if(s.length)toStitch(s)};
$('#rBell').onclick=async()=>{
  if(!('Notification'in window))return toast('This browser can’t show notifications',{kind:'warn'});
  if(LS.get('notify',false)){LS.set('notify',false);syncBell();return toast('Notifications off')}
  const p=Notification.permission==='granted'?'granted':await Notification.requestPermission();
  if(p==='granted'){LS.set('notify',true);toast('You’ll get a notification when a download finishes while this tab is in the background',{kind:'ok'})}
  else toast('Notifications are blocked for this site',{kind:'warn'});
  syncBell();
};
function syncBell(){const on=LS.get('notify',false)&&'Notification'in window&&Notification.permission==='granted';$('#rBell').classList.toggle('on',on);$('#rBell').dataset.tip=on?'Notifications on · click to turn off':'Notify me when downloads finish'}

/* ============================================================
   HAND-OFF TO STITCH
   ============================================================ */
async function fetchFile(url,fallback,onProg){
  const r=await fetch(E.base+url,{cache:'no-store'});
  if(!r.ok){let m=`HTTP ${r.status}`;try{m=(await r.json()).error||m}catch{}throw new Error(m)}
  const total=+r.headers.get('Content-Length')||0;
  let name=fallback;try{const x=r.headers.get('X-File-Name');if(x)name=decodeURIComponent(x)}catch{}
  const type=r.headers.get('Content-Type')||'';
  const lm=Date.parse(r.headers.get('Last-Modified')||'')||Date.now();
  let blob;
  if(r.body&&total){
    const rd=r.body.getReader(),parts=[];let got=0;
    for(;;){const{done,value}=await rd.read();if(done)break;parts.push(value);got+=value.length;onProg?.(got/total)}
    blob=new Blob(parts,{type});
  }else blob=await r.blob();
  return new File([blob],name,{type,lastModified:lm});
}
async function transfer(list,label,o={}){
  if(Stitch.busy())return toast('Stitch is exporting',{kind:'warn',sub:'Try again when the export finishes.'});
  if(E.state!=='online')return toast('Connect the engine first',{kind:'warn'});
  const n=list.length,files=[];
  const t=toast(`Loading ${n>1?plural(n,'clip'):'clip'} into Stitch…`,{ms:0,sub:label(list[0])});
  try{
    for(let i=0;i<n;i++){
      const it=list[i];
      const f=await fetchFile(it.path,it.name,p=>t.update(null,`${n>1?`${i+1}/${n} · `:''}${trunc(it.name,60)} · ${Math.round(p*100)}%`,(i+p)/n*100));
      files.push(f);it.onDone?.();
    }
    t();
  }catch(e){t.done('Couldn’t load into Stitch',{kind:'err',sub:e.message,ms:9000});if(!files.length)return}
  if(!o.stay)App.go('stitch');
  Stitch.addFiles(files,{src:'rip'});
  if(o.stay)toast(`${plural(files.length,'finished clip')} added to Stitch`,{kind:'ok',action:{label:'Open Stitch',fn:()=>App.go('stitch')}});
}
function toStitch(jobs,o={}){
  return transfer(jobs.map(j=>({path:`/api/file?t=${encodeURIComponent(E.token)}&job=${encodeURIComponent(j.id)}`,name:j.filename||'clip.mp4',onDone:()=>{R.sent.add(j.id);LS.set('rip.sent',[...R.sent].slice(-300));updateBadges();renderJobs()}})),
    x=>trunc(x.name,60),{stay:o.auto&&App.mod!=='stitch'});
}

/* --- "Add from Rip downloads" picker for Stitch --- */
async function openImport(){
  if(E.state!=='online'){
    await connect(true);
    if(E.state!=='online')return toast('Connect the RipStitch Engine first',{kind:'warn',sub:'It lists and serves your downloads.',action:{label:'Set up',fn:()=>App.go('rip')}});
  }
  let files;
  try{files=(await api('/api/files?t='+encodeURIComponent(E.token))).files}catch(e){return toast('Couldn’t list downloads',{kind:'err',sub:e.message})}
  const dlg=$('#dlgImp'),list=$('#impList'),sel=new Set();
  $('#impSub').textContent=`${plural(files.length,'file')} in ${E.health.out_dir}`;
  const draw=()=>{
    const q=$('#impQ').value.trim().toLowerCase();
    const vis=files.map((f,i)=>({f,i})).filter(x=>!q||x.f.path.toLowerCase().includes(q));
    list.innerHTML=vis.length?vis.map(({f,i})=>{const off=f.kind!=='video',inS=Stitch.hasFile(f.name,f.size);
      return`<label class="imp-row${off?' off':''}" data-i="${i}" ${off?'title="Audio files can’t go on the video timeline"':''}><input type="checkbox" class="chk-box" data-i="${i}" ${sel.has(i)?'checked':''} ${off?'disabled':''}>${ic(off?'music':'film')}<span class="nm">${esc(f.name)}${f.path.includes('/')?`<small>${esc(f.path.slice(0,f.path.lastIndexOf('/')))}</small>`:''}${inS?'<small style="color:var(--hv)">already on the timeline</small>':''}</span><span class="sz">${fmtBytes(f.size)}</span><span class="dt">${new Date(f.mtime*1000).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</span></label>`}).join('')
      :`<div class="imp-empty">${files.length?'Nothing matches.':'No videos in your download folder yet. Rip something first.'}</div>`;
    $('#impCnt').textContent=sel.size?`${sel.size} selected · ${fmtBytes([...sel].reduce((a,i)=>a+files[i].size,0))}`:'';
    $('#impGo').disabled=!sel.size;$('#impGo').innerHTML=`${ic('cut')}Add ${sel.size||''} to Stitch`;
  };
  list.onchange=e=>{const i=+e.target.dataset.i;e.target.checked?sel.add(i):sel.delete(i);draw()};
  $('#impQ').value='';$('#impQ').oninput=draw;
  $('#impAll').onclick=()=>{files.forEach((f,i)=>{if(f.kind==='video'&&!Stitch.hasFile(f.name,f.size))sel.add(i)});draw()};
  $('#impNone').onclick=()=>{sel.clear();draw()};
  $('#impGo').onclick=()=>{
    const pick=[...sel].sort((a,b)=>files[b].mtime-files[a].mtime).map(i=>files[i]);dlg.close();
    transfer(pick.map(f=>({path:`/api/file?t=${encodeURIComponent(E.token)}&p=${encodeURIComponent(f.path)}`,name:f.name})),x=>trunc(x.name,60));
  };
  draw();dlg.showModal();
}

async function selfUpdate(btn){
  if(btn)btn.disabled=true;
  const t=toast('Updating the engine…',{ms:0,sub:'Your settings and downloads are kept.'});
  try{
    const d=await api('/api/engine-update',{},{timeout:90000});
    if(!d.updated){t.done(d.note||'The engine is already up to date');return}
    t.done(`Engine updated to ${d.version}`,{sub:'It’s restarting. This page reconnects by itself.'});
    E.wasOnline=true;setState('checking');setTimeout(()=>connect(false),1500);
  }catch(e){
    if(e.status===404)t.done('This engine is too old to update itself',{kind:'warn',sub:'Install the latest version from the Rip tab once, and it updates itself from then on.',ms:12000});
    else t.done('Engine update failed',{kind:'err',sub:e.message,ms:12000});
  }finally{if(btn)btn.disabled=false}
}

/* ============================================================
   SETTINGS — the Downloads and Engine sections of the Settings window
   ============================================================ */
function setAuto(on,quiet){
  R.auto=!!on;LS.set('rip.auto',R.auto);$('#rAuto').checked=R.auto;
  if(!quiet)toast(R.auto?'Finished downloads will drop onto the Stitch timeline':'Auto-send to Stitch is off',{kind:R.auto?'ok':'info'});
}
function offlineCallout(){
  return `<div class="callout info">${ic('plug')}<div><b>${DESKTOP?'The engine isn’t running right now':'Rip’s engine isn’t connected'}</b><br>
    ${DESKTOP?'It normally starts with the app. Try reconnecting.':'Download settings live in the RipStitch Engine on your computer, so they apply to every download.'}<br>
    <button class="btn sm rip" data-sa="connect">${ic('plug')}${DESKTOP?'Reconnect':'Connect or set up the engine'}</button></div></div>`;
}
function renderDownloads(el){
  const c=E.cfg,h=E.health;
  const auto=`<label class="set-row"><div><b>Send finished downloads to Stitch</b><span>Each finished video drops straight onto the Stitch timeline.</span></div><input type="checkbox" class="sw" data-p="auto"${R.auto?' checked':''}></label>`;
  el.onclick=onSetClick;
  if(E.state!=='online'||!c||!h){el.innerHTML=offlineCallout()+'<div class="sub">This device</div>'+auto;return}
  const opt=(arr,v,names={})=>arr.map(x=>`<option value="${esc(x)}" ${x===v?'selected':''}>${esc(names[x]||x||'none')}</option>`).join('');
  const sw=(k,label,tip)=>`<label class="swrow"${tip?` data-tip="${esc(tip)}"`:''}><span>${label}</span><input type="checkbox" class="sw" data-k="${k}" ${c[k]?'checked':''}></label>`;
  el.innerHTML=`
    <div class="fld"><label for="sOut">Save downloads to</label>
      <div class="folder"><input class="inp" id="sOut" data-k="out_dir" value="${esc(c.out_dir)}" spellcheck="false" aria-label="Download folder"><button class="btn" data-sa="browse">${ic('open')}Browse…</button><button class="btn flat io" data-sa="reveal" data-tip="Open the current folder">${ic('ext')}</button></div>
      <span class="hint">New downloads land here. It’s created if it doesn’t exist${h.free_bytes!=null?` · ${fmtBytes(h.free_bytes)} free`:''}.</span></div>
    <div class="sub">Files</div>
    <div class="set-grid">
      <div class="fld" style="grid-column:1/-1"><label for="sTpl">File names</label><input class="inp" id="sTpl" data-k="template" value="${esc(c.template)}" spellcheck="false"><span class="hint">yt-dlp template. Default: <span class="mono">%(title).150B [%(id)s].%(ext)s</span>. Use <span class="mono">%(uploader)s/…</span> for a folder per channel.</span></div>
      <div class="fld"><label for="sMerge">Video container</label><select class="inp" id="sMerge" data-k="merge_format">${opt(h.choices.merge_format,c.merge_format)}</select><span class="hint">MP4 plays everywhere. MKV holds anything.</span></div>
      <div class="fld"><label for="sAudio">Audio-only format</label><select class="inp" id="sAudio" data-k="audio_codec">${opt(h.choices.audio_codec,c.audio_codec)}</select></div>
    </div>
    <div class="sub">Extras</div>
    <div class="set-checks">
      ${sw('compat','Prefer H.264 + AAC','Plays on every device and stitches losslessly. Caps YouTube at 1080p.')}
      ${sw('embed_meta','Embed title, chapters and info')}
      ${sw('embed_thumb','Embed the thumbnail as cover art')}
      ${sw('subs','Download subtitles')}
      ${sw('embed_subs','Put subtitles inside the video')}
      ${sw('sponsorblock','Cut sponsor segments (SponsorBlock)','Removes community-marked sponsor reads from YouTube videos')}
      ${sw('archive','Skip anything already downloaded','Remembers every video ID it has saved')}
      ${sw('auto_update','Keep yt-dlp up to date automatically','Checks once a day while nothing is downloading. Sites change often, and new yt-dlp releases keep them working.')}
    </div>
    <div class="sub">Speed and sign-in</div>
    <div class="set-grid">
      <div class="fld"><label for="sWorkers">Downloads at once</label><input class="inp" type="number" min="1" max="8" id="sWorkers" data-k="workers" value="${c.workers}"></div>
      <div class="fld"><label for="sFrag">Connections per download</label><input class="inp" type="number" min="1" max="16" id="sFrag" data-k="frag_workers" value="${c.frag_workers}"><span class="hint">Speeds up streaming sites (HLS/DASH).</span></div>
      <div class="fld"><label for="sRate">Speed cap</label><input class="inp" id="sRate" data-k="rate_limit" value="${esc(c.rate_limit)}" placeholder="e.g. 5M (blank = no cap)" spellcheck="false"></div>
      <div class="fld"><label for="sCookies">Sign in using browser cookies</label><select class="inp" id="sCookies" data-k="cookies_from">${opt(h.choices.cookies_from,c.cookies_from)}</select><span class="hint">For videos your own account can already see.</span></div>
      <div class="fld" style="grid-column:1/-1"><label for="sSubs">Subtitle languages</label><input class="inp" id="sSubs" data-k="sub_langs" value="${esc(c.sub_langs)}" spellcheck="false"><span class="hint">Comma separated, wildcards allowed: <span class="mono">en.*,es,ja</span></span></div>
    </div>
    <div class="sub">This device</div>${auto}`;
}
async function saveDownloads(el){
  const a=el.querySelector('[data-p=auto]');if(a&&a.checked!==R.auto)setAuto(a.checked,true);
  const fields=el.querySelectorAll('[data-k]');if(!fields.length||E.state!=='online')return null;
  const cfg={};
  fields.forEach(f=>{const k=f.dataset.k;cfg[k]=f.type==='checkbox'?f.checked:f.type==='number'?+f.value:f.value.trim()});
  const changed=Object.keys(cfg).filter(k=>String(cfg[k])!==String(E.cfg?.[k]));
  if(!changed.length)return null;
  let d;
  try{d=await api('/api/settings',{config:cfg})}catch(e){e.section='downloads';throw e}
  E.cfg=d.config;refreshHealth();if(R.cur?.kind==='video')renderVideo(R.cur);
  return changed.includes('out_dir')?`Downloads now save to ${d.config.out_dir}`:'Download settings saved. They apply to new downloads.';
}
function renderEngineSec(el){
  const h=E.health;el.onclick=onSetClick;
  const app=DESKTOP?`<dt>App</dt><dd>RipStitch Desktop ${esc((navigator.userAgent.match(/RipStitchDesktop\/([\d.]+)/)||[])[1]||'')}</dd><dd></dd>`:'';
  if(E.state!=='online'||!h){el.innerHTML=offlineCallout()+(app?`<dl class="set-info" style="margin-top:12px">${app}</dl>`:'');return}
  el.innerHTML=`
    <dl class="set-info">
      ${app}
      <dt>Engine</dt><dd>RipStitch Engine ${esc(h.version)} · ${esc({'windows-app':'Windows app','script':'installed by script',desktop:'built into RipStitch Desktop',manual:'Python script'}[h.install]||'Python script')} · Python ${esc(h.python)}</dd><dd>${h.install==='desktop'?'':vcmp(h.version,ENGINE_LATEST)<0?`<button class="btn sm rip" data-sa="selfupdate">${ic('reset')}Update to ${ENGINE_LATEST}</button>`:`<button class="btn sm danger" data-sa="stop" data-tip="Stops it until you next sign in, or until you start it again">${ic('stop')}Stop</button>`}</dd>
      <dt>yt-dlp</dt><dd>${h.ytdlp?esc(h.ytdlp)+(h.runtime==='private'?' · private runtime':''):'<span style="color:var(--cut)">not installed</span>'}</dd><dd><button class="btn sm${h.ytdlp?'':' rip'}" data-sa="update">${ic(h.ytdlp?'reset':'dl')}${h.ytdlp?'Update':'Install'}</button></dd>
      <dt>FFmpeg</dt><dd>${h.ffmpeg?esc(h.ffmpeg_version):'<span style="color:var(--cut)">missing</span>: needed for HD merges, audio conversion and section clips'}</dd><dd></dd>
      <dt>JS runtime</dt><dd>${h.js_runtime?esc(h.js_runtime):'<span style="color:var(--warn)">none</span>: install Deno for full YouTube support'}</dd><dd></dd>
      <dt>Address</dt><dd>${esc(E.base)}</dd><dd></dd>
      ${h.log_file?`<dt>Log</dt><dd>${esc(h.log_file)}</dd><dd></dd>`:''}
    </dl>
    <p class="note" style="margin-top:12px">${h.config?.auto_update!==false?'yt-dlp updates itself once a day while nothing is downloading.':'Automatic yt-dlp updates are off (Downloads → Extras).'}</p>
    <div id="setOut"></div>`;
}
/** Ask for a folder: the desktop app shows the Windows picker; in a browser the engine shows one on this computer. */
async function pickFolder(start,title){
  if(Host){const r=await Host.call('pickFolder',{start:start||'',title});if(r.error)throw new Error(r.error);return r.path||null}
  if(E.state!=='online')throw new Error('Connect the engine first');
  try{return(await api('/api/pick-folder',{start:start||'',title},{timeout:15*60000})).path||null}
  catch(e){
    if(e.status===404)throw new Error('Your engine is too old to show a folder picker. Update it in Settings → Engine, or type the folder path.');
    throw e;
  }
}
async function browseFolder(btn){
  const inp=$('#sOut');if(!inp)return;
  btn.disabled=true;$('#setMsg').textContent='Choose a folder in the window that opened…';
  try{
    const p=await pickFolder(inp.value.trim(),'Choose where RipStitch saves downloads');
    inp.dataset.picked=p||'(cancelled)';
    if(p&&p!==inp.value){inp.value=p;inp.classList.add('picked');Settings.dirty(inp);$('#setMsg').textContent='Click Save to use this folder.'}
    else $('#setMsg').textContent='';
  }catch(e){$('#setMsg').textContent='';toast('Couldn’t open the folder picker',{kind:'err',sub:e.message,ms:9000})}
  finally{btn.disabled=false}
}
async function onSetClick(e){
  const b=e.target.closest('[data-sa]');if(!b)return;
  const a=b.dataset.sa;
  if(a==='browse')return browseFolder(b);
  if(a==='connect'){$('#dlgSet').close();App.go('rip');connect(true);setTimeout(()=>$('#rCard')?.scrollIntoView({behavior:'smooth',block:'start'}),60);return}
  if(a==='reveal')return api('/api/reveal',{}).catch(err=>toast(err.message,{kind:'err'}));
  if(a==='selfupdate'){$('#dlgSet').close();return selfUpdate()}
  if(a==='stop'){
    if(R.jobs.some(j=>ACTIVE.includes(j.status))&&!confirm('Downloads are still running. Stop the engine anyway?'))return;
    try{await api('/api/shutdown',{})}catch{}
    $('#dlgSet').close();E.wasOnline=true;setState('offline');setTimeout(()=>connect(false),3000);
    const how={'windows-app':'It starts again the next time you sign in, or from “Start the engine” in your Start menu.',script:'It starts again the next time you log in.'}[E.health?.install]||'Run ripstitch_engine.py again to restart it.';
    return toast('Engine stopped',{sub:how});
  }
  if(a==='update')updateYtdlp(b);
}
Settings.add({id:'downloads',order:10,title:'Downloads',icon:'dl',sub:'Where Rip saves files and how it downloads them. Stored by the engine, so they apply to every download.',render:renderDownloads,save:saveDownloads});
Settings.add({id:'engine',order:40,title:'Engine',icon:'plug',sub:'The helper that runs yt-dlp and FFmpeg on this computer.',render:renderEngineSec});
function openSettings(id){Settings.open(id||'downloads')}
async function updateYtdlp(btn){
  if(E.state!=='online')return;
  const t=toast(E.health?.ytdlp?'Updating yt-dlp…':'Installing yt-dlp…',{ms:0,sub:'This can take a minute.'});
  if(btn)btn.disabled=true;
  try{const d=await api('/api/update',{},{timeout:900000});t.done(d.note||'Done',{kind:'ok'});await refreshHealth();Settings.refresh('engine')}
  catch(e){t.done('yt-dlp install failed',{kind:'err',sub:trunc(e.message,400),ms:15000});const o=$('#setOut');if(o)o.innerHTML=`<pre class="set-out">${esc(e.message)}</pre>`}
  finally{if(btn)btn.disabled=false}
}
$('#rFolderSet').onclick=()=>openSettings('downloads');
if(!DESKTOP&&/Windows/.test(navigator.userAgent))$('#bGetApp').hidden=false;
$('#bGetApp').onclick=()=>toast('Downloading RipStitch.exe (about 150 MB)',{kind:'ok',sub:'If your browser says it “isn’t commonly downloaded”, choose Keep. If Windows says “Windows protected your PC”, click More info → Run anyway.',ms:12000});
$('#engPill').onclick=()=>E.state==='online'?openSettings('engine'):(App.go('rip'),connect(true),setTimeout(()=>$('#rCard')?.scrollIntoView({behavior:'smooth',block:'start'}),60));

/* ============================================================
   KEYS + COMMANDS
   ============================================================ */
function onKey(e,typing){
  if(typing)return;
  if(e.key==='/'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();urlIn.focus();urlIn.select();return}
  if(e.key==='Escape'&&R.cur){e.preventDefault();closeSpec()}
}
App.keys.unshift(['Rip',[['Focus the link box','/'],['Read the link','Enter'],['Close the result','Esc']]]);
App.keys.unshift(['Everywhere',[['Search every command','Ctrl+K'],['Switch to Rip / Stitch','Alt+1','Alt+2'],['Paste a link anywhere to rip it','Ctrl+V'],['Drop video files anywhere to stitch','drag'],['Keyboard shortcuts','?']]]);
const inRip=fn=>()=>{App.go('rip');setTimeout(fn,30)};
[
  {id:'go.rip',group:'Go',title:'Go to Rip',icon:'dl',keys:['Alt+1'],run:()=>App.go('rip')},
  {id:'go.stitch',group:'Go',title:'Go to Stitch',icon:'cut',keys:['Alt+2'],run:()=>App.go('stitch')},
  {id:'rp.paste',title:'Paste a link and read it',icon:'paste',words:'clipboard url',run:inRip(pasteAndRead)},
  {id:'rp.focus',title:'Type a link',icon:'link',keys:['/'],run:inRip(()=>{urlIn.focus();urlIn.select()})},
  {id:'rp.pl',title:'Toggle whole-playlist mode',icon:'list',run:inRip(()=>{setPl(!R.pl);toast(R.pl?'Playlist mode on: links read every video':'Playlist mode off')})},
  {id:'rp.auto',title:'Toggle “Send to Stitch when done”',icon:'send',run:()=>{$('#rAuto').checked=!R.auto;$('#rAuto').dispatchEvent(new Event('change'))}},
  {id:'rp.setup',title:'Download settings…',icon:'gear',words:'settings preferences setup quality container cookies',run:()=>openSettings('downloads')},
  {id:'rp.where',title:'Change the download folder…',icon:'open',words:'save location directory browse',run:()=>{openSettings('downloads');setTimeout(()=>$('#sOut')?.focus(),80)}},
  {id:'rp.engine',title:'Engine status and updates…',icon:'plug',words:'yt-dlp ffmpeg version',run:()=>openSettings('engine')},
  {id:'rp.connect',title:'Connect to the engine',icon:'plug',when:()=>E.state!=='online',run:inRip(()=>connect(true))},
  {id:'rp.folder',title:'Open the download folder',icon:'open',when:()=>E.state==='online',run:()=>api('/api/reveal',{}).catch(e=>toast(e.message,{kind:'err'}))},
  {id:'rp.send',title:'Send finished downloads to Stitch',icon:'cut',when:()=>sendable().length>0,run:()=>toStitch(sendable())},
  {id:'rp.clear',title:'Clear finished downloads',icon:'trash',when:()=>R.jobs.some(j=>!ACTIVE.includes(j.status)),run:()=>$('#rClear').click()},
  {id:'rp.update',title:'Update yt-dlp',icon:'reset',when:()=>E.state==='online',run:()=>updateYtdlp()},
].forEach(c=>App.cmd({group:'Rip',...c}));
App.cmd({id:'hp.keys',group:'Help',title:'Keyboard shortcuts',icon:'keys',keys:['?'],run:openKeys});
App.cmd({id:'hp.about',group:'Help',title:'About RipStitch',icon:'info',run:openAbout});
App.cmd({id:'hp.install',group:'Help',title:'Install RipStitch as an app',icon:'install',when:()=>!!installEvt&&!DESKTOP,run:()=>$('#bInstall').click()});
App.cmd({id:'hp.engine',group:'Help',title:'Download the engine (ripstitch_engine.py)',icon:'dl',when:()=>!DESKTOP,run:()=>{const a=document.createElement('a');a.href=engineUrl();a.download='ripstitch_engine.py';a.click()}});

/* ============================================================
   LIFECYCLE
   ============================================================ */
async function init(){
  syncBell();renderTop();renderEngine();renderJobs();renderRecent();
  // When this page is served by the engine itself, talk to it on the same origin.
  if(LOOP.includes(location.hostname)&&location.protocol==='http:'&&!LS.get('engine.base',null)){
    try{await api('/api/ping',undefined,{base:location.origin,timeout:1500});E.base=location.origin}catch{}
  }
  connect(false);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(E.state==='online')pollJobs(true);else if(E.state==='offline')connect(false)}});
}
return{
  init,read,openImport,connect,
  onShow(){if(!R.cur&&matchMedia('(pointer:fine)').matches&&!$('dialog[open]'))setTimeout(()=>{if(App.mod==='rip'&&document.activeElement===document.body)urlIn.focus()},50)},
  onHide(){},onKey,
  get engine(){return E},
  _debug:{show,R,E,renderJobs},
};
})();
App.register('rip',Rip);
