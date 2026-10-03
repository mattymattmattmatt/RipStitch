'use strict';
/* ============================================================
   RipStitch core: shared helpers, toasts, tooltips, routing,
   command palette, global keys / paste / drop.
   ============================================================ */

/* ---------- utilities ---------- */
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const ic=(n,cls='')=>`<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
const pad2=n=>String(n).padStart(2,'0');
const plural=(n,w,p)=>`${n} ${n===1?w:(p||w+'s')}`;
const IS_MAC=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);
const MOD=IS_MAC?'⌘':'Ctrl';
/** Running inside the RipStitch desktop app (its window adds this to the user agent). */
const DESKTOP=/RipStitchDesktop/.test(navigator.userAgent);
if(DESKTOP)document.documentElement.classList.add('desktop');
const LS={
  get(k,d){try{const v=localStorage.getItem('rs.'+k);return v==null?d:JSON.parse(v)}catch{return d}},
  set(k,v){try{localStorage.setItem('rs.'+k,JSON.stringify(v))}catch{}},
  del(k){try{localStorage.removeItem('rs.'+k)}catch{}}
};
/** Timecode: m:ss.ff  (h:mm:ss.ff once over an hour) */
function tc(s,frac=2,forceH=false){
  if(!isFinite(s))return'--:--';
  const k=10**frac,u=Math.round(Math.max(0,s)*k);
  const h=Math.floor(u/(3600*k)),m=Math.floor(u/(60*k))%60,sec=Math.floor(u/k)%60,f=u%k;
  const tail=':'+pad2(sec)+(frac?'.'+String(f).padStart(frac,'0'):'');
  return (h||forceH)?h+':'+pad2(m)+tail:m+tail;
}
/** Accepts 83.5 · 1:23.5 · 0:01:23.5 */
function parseTC(str){
  str=String(str).trim().replace(',','.');
  if(!str)return NaN;
  if(!/^[\d:.]+$/.test(str))return NaN;
  const parts=str.split(':');if(parts.length>3)return NaN;
  let t=0;for(const p of parts){if(p===''||isNaN(+p))return NaN;t=t*60+ +p}
  return t;
}
function fmtBytes(n){if(!isFinite(n)||n<=0)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.min(4,Math.floor(Math.log(n)/Math.log(1024)));return(n/1024**i).toFixed(i>=2?(n/1024**i<10?2:1):0)+' '+u[i]}
/** Pull the first web link out of arbitrary pasted text. */
function findUrl(text){
  text=String(text||'').trim();if(!text)return null;
  let m=text.match(/https?:\/\/[^\s<>"'`]+/i);
  if(!m&&/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(text)&&!/\s/.test(text))m=['https://'+text];
  if(!m)return null;
  let u=m[0].replace(/[)\].,;!?'"»”]+$/,'');
  try{u=new URL(u).href}catch{return null}
  return u;
}
function copyText(t){
  return navigator.clipboard?.writeText(t).catch(()=>fallback())??Promise.resolve(fallback());
  function fallback(){const ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch{}ta.remove()}
}

/* ---------- toasts ---------- */
function toast(msg,o={}){
  const kind=o.kind||'info',box=$('#toasts');
  const t=document.createElement('div');t.className='toast '+kind;t.setAttribute('role',kind==='err'?'alert':'status');
  const icon={ok:'check',warn:'warn',err:'warn',info:'info'}[kind];
  t.innerHTML=`${ic(icon)}<div class="tx"><span class="m"></span><small hidden></small></div>`;
  const setTxt=(m,sub)=>{
    if(m!=null){const el=t.querySelector('.m');if(o.html)el.innerHTML=m;else el.textContent=m}
    if(sub!==undefined){const s=t.querySelector('small');s.hidden=!sub;if(o.html)s.innerHTML=sub||'';else s.textContent=sub||''}
  };
  setTxt(msg,o.sub||null);
  if(o.action){const b=document.createElement('button');b.className='btn sm';b.textContent=o.action.label;b.onclick=()=>{o.action.fn();kill()};t.appendChild(b)}
  const x=document.createElement('button');x.className='tclose';x.innerHTML=ic('x');x.setAttribute('aria-label','Dismiss');x.onclick=()=>kill();t.appendChild(x);
  box.appendChild(t);while(box.children.length>4)box.firstChild.remove();
  const ms=o.ms??(kind==='err'?12000:o.action?6500:3200);
  let tm=ms>0?setTimeout(kill,ms):0;
  t.onmouseenter=()=>clearTimeout(tm);t.onmouseleave=()=>{if(ms>0)tm=setTimeout(kill,1800)};
  function kill(){clearTimeout(tm);t.remove()}
  kill.update=(m,sub,pct)=>{setTxt(m,sub);if(pct!=null){let b=t.querySelector('.tbar');if(!b){b=document.createElement('i');b.className='tbar';t.appendChild(b)}b.style.width=clamp(pct,0,100)+'%'}};
  kill.done=(m,opt={})=>{t.className='toast '+(opt.kind||'ok');t.querySelector('.ic use')?.setAttribute('href','#i-'+({ok:'check',warn:'warn',err:'warn'}[opt.kind||'ok']));setTxt(m,opt.sub??null);t.querySelector('.tbar')?.remove();clearTimeout(tm);tm=setTimeout(kill,opt.ms||4000)};
  return kill;
}

/* ---------- tooltips ---------- */
const tipEl=$('#tip'),dtip=$('#dtip');let tipT=0,tipFor=null,TIPS=LS.get('tips',true);
document.addEventListener('pointerover',e=>{
  const t=e.target.closest?.('[data-tip]');if(t===tipFor)return;hideTip();
  if(!t||!TIPS||e.pointerType==='touch'||document.body.classList.contains('trimming'))return;
  tipFor=t;tipT=setTimeout(()=>showTip(t),450);
});
document.addEventListener('pointerdown',hideTip,true);addEventListener('blur',hideTip);addEventListener('wheel',hideTip,{passive:true});
function showTip(t){
  if(!t.isConnected)return;
  const key=t.dataset.key?t.dataset.key.replace(/^Ctrl\+/,MOD+'+'):'';
  tipEl.innerHTML=esc(t.dataset.tip)+(key?`<kbd>${esc(key)}</kbd>`:'');tipEl.hidden=false;
  const r=t.getBoundingClientRect(),w=tipEl.offsetWidth,h=tipEl.offsetHeight;
  let x=clamp(r.left+r.width/2-w/2,6,innerWidth-w-6),y=r.bottom+7;if(y+h>innerHeight-6)y=r.top-h-7;
  tipEl.style.left=x+'px';tipEl.style.top=y+'px';
}
function hideTip(){clearTimeout(tipT);tipFor=null;tipEl.hidden=true}
function dragTip(e,html){if(html==null){dtip.hidden=true;return}dtip.innerHTML=html;dtip.hidden=false;dtip.style.left=clamp(e.clientX+14,4,innerWidth-dtip.offsetWidth-4)+'px';dtip.style.top=(e.clientY-30)+'px'}

/* ---------- dialogs ---------- */
document.addEventListener('click',e=>{const b=e.target.closest?.('dialog [data-close]');if(b)b.closest('dialog').close()});
$$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close()}));
// Mouse clicks shouldn't leave focus on a button, or Space would re-press it instead of play/pause.
document.addEventListener('click',e=>{const b=e.target.closest?.('button');if(b&&e.detail>0&&!b.closest('dialog'))b.blur()});

/* ============================================================
   APP — routing between the Rip and Stitch tools
   ============================================================ */
const App={
  mod:'rip',mods:{},cmds:[],keys:[],
  register(name,m){this.mods[name]=m},
  go(name,o={}){
    if(!this.mods[name])name='rip';
    if(name===this.mod&&!o.force){this.mods[name].onShow?.(o);return true}
    const cur=this.mods[this.mod];
    if(cur?.canLeave&&!cur.canLeave()){return false}
    cur?.onHide?.();
    this.mod=name;
    document.body.dataset.mod=name;
    for(const[n]of Object.entries(this.mods)){
      const v=$('#view-'+n);if(v)v.hidden=n!==name;
      const tb=$(`.tb[data-for="${n}"]`);if(tb)tb.hidden=n!==name;
      const tab=$(`.tab[data-go="${n}"]`);if(tab)tab.setAttribute('aria-selected',String(n===name));
    }
    if(location.hash!=='#'+name&&!o.noHash)history.replaceState(null,'','#'+name+location.search);
    hideTip();
    this.mods[name].onShow?.(o);
    LS.set('mod',name);
    return true;
  },
  /** Register a palette command. */
  cmd(c){this.cmds.push(c);return c},
  /** Shortcut sections for the help dialog: [title, [label, ...keys]...] */
  keySection(title,rows){this.keys.push([title,rows])},
};
$$('.tab').forEach(t=>t.onclick=()=>App.go(t.dataset.go));
$('#brand').onclick=e=>{e.preventDefault();openAbout()};
addEventListener('hashchange',()=>{const h=location.hash.slice(1);if(App.mods[h]&&h!==App.mod)App.go(h,{noHash:true})});

function appUrl(){return location.protocol.startsWith('http')?location.origin+location.pathname:'https://mattymattmattmatt.github.io/RipStitch/'}
function openAbout(){$('#dlgAbout').showModal()}
$('#bBmk').href=`javascript:void(window.open('${appUrl()}?url='+encodeURIComponent(location.href)))`;
$('#bBmk').onclick=e=>{e.preventDefault();toast('Drag the button to your bookmarks bar',{sub:'Then click it on any video page to send that page here.'})};
function openKeys(){
  $('#keysList').innerHTML=App.keys.map(([title,rows])=>`<h4>${esc(title)}</h4>`+rows.map(k=>`<div class="krow"><span>${esc(k[0])}</span><span>${k.slice(1).map(x=>`<kbd>${esc(x.replace(/^Ctrl\+/,MOD+'+'))}</kbd>`).join('')}</span></div>`).join('')).join('');
  $('#dlgKeys').showModal();$('#dlgKeys .db').focus({preventScroll:true});
}
$('#bKeys').onclick=openKeys;

/* ============================================================
   COMMAND PALETTE
   ============================================================ */
const Palette=(()=>{
  const dlg=$('#dlgCmd'),q=$('#cmdQ'),list=$('#cmdList');
  let items=[],active=0;
  function score(text,query){
    // subsequence match; consecutive and word-start hits score higher
    text=text.toLowerCase();let ti=0,s=0,run=0;const hits=[];
    for(const ch of query){
      const i=text.indexOf(ch,ti);if(i<0)return null;
      run=i===ti?run+1:0;s+=1+run*2+(i===0||/[\s:·/-]/.test(text[i-1])?3:0)-Math.min(i-ti,4)*.2;
      hits.push(i);ti=i+1;
    }
    return{s,hits};
  }
  function hl(text,hits){if(!hits)return esc(text);let o='';for(let i=0;i<text.length;i++)o+=hits.includes(i)?`<mark>${esc(text[i])}</mark>`:esc(text[i]);return o}
  function build(){
    const raw=q.value.trim(),query=raw.toLowerCase().replace(/\s+/g,' ');
    const all=App.cmds.filter(c=>!c.when||c.when());
    let out=[];
    const url=findUrl(raw);
    if(url&&/[./]/.test(raw))out.push({c:{id:'_rip',group:'Rip',title:'Rip this link',icon:'bolt',sub:url,run:()=>{App.go('rip');Rip.read(url)}},hits:null,s:1e9});
    if(!query){
      const rec=LS.get('cmdRecent',[]).map(id=>all.find(c=>c.id===id)).filter(Boolean).slice(0,4);
      out.push(...rec.map(c=>({c:{...c,group:'Recent'},hits:null,s:0})));
      out.push(...all.map(c=>({c,hits:null,s:0})));
    }else{
      for(const c of all){
        const r=score(c.title,query.replace(/ /g,''))||score(c.title,query);
        const g=!r&&score((c.group+' '+c.title+' '+(c.words||'')),query.replace(/ /g,''));
        if(r)out.push({c,hits:r.hits,s:r.s+(c.title.toLowerCase().startsWith(query)?20:0)});
        else if(g)out.push({c,hits:null,s:g.s-5});
      }
      out.sort((a,b)=>b.s-a.s);
      const top=out.find(x=>x.c.id!=='_rip')?.s||0;out=out.filter(x=>x.c.id==='_rip'||x.s>=top*0.45);
    }
    items=out;active=0;render();
  }
  function render(){
    if(!items.length){list.innerHTML='<div class="cmd-empty">No matching command. Paste a link here to rip it.</div>';return}
    let html='',g=null;const grouped=!q.value.trim();
    items.forEach((it,i)=>{
      const c=it.c;
      if(grouped&&c.group!==g){g=c.group;html+=`<div class="cmd-g">${esc(g)}</div>`}
      const keys=(c.keys||[]).map(k=>`<kbd>${esc(k.replace(/^Ctrl\+/,MOD+'+'))}</kbd>`).join('');
      html+=`<button class="cmd-i${i===active?' on':''}" data-i="${i}" role="option">${ic(c.icon||'right')}<span class="t">${grouped?'':`<span style="color:var(--faint)">${esc(c.group)} · </span>`}${hl(c.title,it.hits)}${c.sub?`<span style="color:var(--faint);font-family:var(--mono);font-size:11px"> ${esc(c.sub)}</span>`:''}</span><span class="k">${keys}</span></button>`;
    });
    list.innerHTML=html;
    list.querySelector('.cmd-i.on')?.scrollIntoView({block:'nearest'});
  }
  function run(i){
    const it=items[i];if(!it)return;close();
    if(it.c.id&&it.c.id[0]!=='_'){const r=LS.get('cmdRecent',[]).filter(x=>x!==it.c.id);r.unshift(it.c.id);LS.set('cmdRecent',r.slice(0,6))}
    setTimeout(()=>{try{it.c.run()}catch(e){console.error(e);toast('That command failed',{kind:'err',sub:e.message})}},30);
  }
  function open(pre=''){if(dlg.open)return;q.value=pre;build();dlg.showModal();q.focus();q.select()}
  function close(){if(dlg.open)dlg.close()}
  q.addEventListener('input',build);
  q.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!items.length)return;active=(active+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;render()}
    else if(e.key==='Enter'){e.preventDefault();run(active)}
    else if(e.key==='Tab'){e.preventDefault()}
  });
  list.addEventListener('pointermove',e=>{const b=e.target.closest('.cmd-i');if(b&&+b.dataset.i!==active){active=+b.dataset.i;$$('.cmd-i',list).forEach(x=>x.classList.toggle('on',x===b))}});
  list.addEventListener('click',e=>{const b=e.target.closest('.cmd-i');if(b)run(+b.dataset.i)});
  $('#bCmd').onclick=()=>open();
  return{open,close};
})();

/* ============================================================
   DESKTOP BRIDGE — asks the RipStitch window (WebView2) for things
   a web page can't do itself, like the Windows folder picker.
   ============================================================ */
const Host=(()=>{
  const wv=DESKTOP&&window.chrome?.webview;if(!wv)return null;
  let n=0;const wait=new Map();
  wv.addEventListener('message',e=>{const m=e.data,f=m&&wait.get(m.id);if(f){wait.delete(m.id);f(m)}});
  return{call:(cmd,args={})=>new Promise(res=>{const id='m'+(++n);wait.set(id,res);wv.postMessage({...args,id,cmd})})};
})();

/* ============================================================
   SETTINGS — one window; each tool adds its own section
   ============================================================ */
const Settings=(()=>{
  const dlg=$('#dlgSet'),nav=$('#setNav'),body=$('#setBody'),msg=$('#setMsg'),secs=[];
  const secEl=id=>body.querySelector(`.set-sec[data-s="${id}"]`),navEl=id=>nav.querySelector(`[data-s="${id}"]`);
  function build(){
    nav.innerHTML=secs.map(s=>`<button data-s="${s.id}">${ic(s.icon)}${esc(s.title)}<i></i></button>`).join('');
    body.innerHTML=secs.map(s=>`<section class="set-sec" data-s="${s.id}" hidden></section>`).join('');
  }
  function render(id){
    for(const s of secs){if(id&&s.id!==id)continue;const el=secEl(s.id);delete el.dataset.dirty;navEl(s.id).classList.remove('dirty');s.render(el)}
  }
  function show(id){
    if(!secs.some(s=>s.id===id))id=secs[0].id;
    LS.set('set.tab',id);
    for(const s of secs){secEl(s.id).hidden=s.id!==id;navEl(s.id).classList.toggle('on',s.id===id)}
    $('#setSub').textContent=secs.find(s=>s.id===id).sub||'';body.scrollTop=0;
  }
  function open(id){
    if(!nav.children.length)build();
    if(!dlg.open){render();msg.textContent='';delete dlg.dataset.dirty}
    show(id||(App.mod==='stitch'?'stitch':LS.get('set.tab','downloads')));
    if(!dlg.open){hideTip();dlg.showModal();body.focus({preventScroll:true})}
  }
  function dirty(el){
    const sec=el.closest?.('.set-sec');if(!sec)return;
    sec.dataset.dirty=dlg.dataset.dirty='1';navEl(sec.dataset.s).classList.add('dirty');
  }
  nav.onclick=e=>{const b=e.target.closest('[data-s]');if(b)show(b.dataset.s)};
  body.addEventListener('input',e=>dirty(e.target));body.addEventListener('change',e=>dirty(e.target));
  dlg.addEventListener('cancel',e=>{if(dlg.dataset.dirty&&!confirm('Close without saving your changes?'))e.preventDefault()});
  $('#setSave').onclick=async()=>{
    const btn=$('#setSave'),notes=[];btn.disabled=true;msg.textContent='Saving…';
    try{
      for(const s of secs){const el=secEl(s.id);if(s.save&&el.dataset.dirty){const n=await s.save(el);if(n)notes.push(n);delete el.dataset.dirty}}
      dlg.close();toast(notes.length?notes[0]:'Settings saved',{kind:'ok',sub:notes.slice(1).join(' ')||null});
    }catch(e){if(e.section)show(e.section);msg.innerHTML=`<span style="color:var(--cut)">${esc(e.message)}</span>`}
    finally{btn.disabled=false}
  };
  $('#bSettings').onclick=()=>open();
  return{
    /** {id, title, icon, order, sub, render(el), save(el) → optional note} */
    add(s){secs.push(s);secs.sort((a,b)=>a.order-b.order);if(nav.children.length)build()},
    open,show,dirty,
    /** Redraw a section with fresh data, unless someone is part-way through editing it. */
    refresh(id){if(dlg.open&&secEl(id)&&!secEl(id).dataset.dirty)render(id)},
    get isOpen(){return dlg.open},
  };
})();
Settings.add({id:'general',order:30,title:'General',icon:'sliders',sub:'How RipStitch starts and behaves.',
  render(el){
    const st=LS.get('start','last');
    el.innerHTML=`
      <div class="set-row"><div><b>Open on</b><span>The tool you see when RipStitch starts. Shared links always open in Rip.</span></div>
        <select class="inp" data-g="start">${[['last','Where I left off'],['rip','Rip'],['stitch','Stitch']].map(([v,l])=>`<option value="${v}"${v===st?' selected':''}>${l}</option>`).join('')}</select></div>
      <label class="set-row"><div><b>Button tips</b><span>Show what a button does, and its shortcut, when you rest the pointer on it.</span></div><input type="checkbox" class="sw" data-g="tips"${TIPS?' checked':''}></label>
      <div class="set-links"><button class="btn" data-ga="keys">${ic('keys')}Keyboard shortcuts</button><button class="btn" data-ga="about">${ic('info')}About RipStitch</button></div>`;
    el.onclick=e=>{const b=e.target.closest('[data-ga]');if(!b)return;$('#dlgSet').close();(b.dataset.ga==='keys'?openKeys:openAbout)()};
  },
  save(el){LS.set('start',el.querySelector('[data-g=start]').value);TIPS=el.querySelector('[data-g=tips]').checked;LS.set('tips',TIPS)}
});
App.cmd({id:'hp.settings',group:'Help',title:'Settings…',icon:'gear',keys:['Ctrl+,'],words:'preferences options setup',run:()=>Settings.open()});

/* ============================================================
   GLOBAL INPUT — keys, paste, drag & drop
   ============================================================ */
addEventListener('keydown',e=>{
  const k=e.key,ctrl=e.ctrlKey||e.metaKey;
  if(ctrl&&!e.altKey&&!e.shiftKey&&k.toLowerCase()==='k'){e.preventDefault();Palette.open();return}
  if(ctrl&&!e.altKey&&k===','){e.preventDefault();if(!$('dialog[open]'))Settings.open();return}
  if(e.altKey&&!ctrl&&(e.code==='Digit1'||e.code==='Digit2')){e.preventDefault();App.go(e.code==='Digit1'?'rip':'stitch');return}
  if($('dialog[open]'))return;
  const typing=e.target.closest?.('input,select,textarea,[contenteditable]');
  if(!typing&&!ctrl&&!e.altKey&&k==='?'){e.preventDefault();openKeys();return}
  App.mods[App.mod]?.onKey?.(e,typing);
});
document.addEventListener('paste',e=>{
  if(e.target.closest?.('input,textarea,[contenteditable]')||$('dialog[open]'))return;
  const files=[...(e.clipboardData?.files||[])];
  if(files.length&&App.mods.stitch){e.preventDefault();App.go('stitch');Stitch.addFiles(files);return}
  const url=findUrl(e.clipboardData?.getData('text')||'');
  if(url){e.preventDefault();App.go('rip');Rip.read(url)}
});
(function dropZone(){
  let depth=0;
  const kind=e=>{const t=[...(e.dataTransfer?.types||[])];return t.includes('Files')?'files':(t.includes('text/uri-list')||t.includes('text/plain'))?'link':null};
  addEventListener('dragenter',e=>{const k=kind(e);if(!k||document.body.classList.contains('dragging'))return;depth++;document.body.dataset.drop=k==='files'?'Drop to add clips to Stitch':'Drop to rip this link';document.body.classList.add('dropping')});
  addEventListener('dragleave',e=>{if(!kind(e))return;if(--depth<=0){depth=0;document.body.classList.remove('dropping')}});
  addEventListener('dragover',e=>{if(kind(e))e.preventDefault()});
  addEventListener('drop',e=>{
    const k=kind(e);if(!k)return;e.preventDefault();depth=0;document.body.classList.remove('dropping');
    if(k==='files'){
      const files=[...e.dataTransfer.files];
      const proj=files.find(f=>/\.(stitch\.|splice\.)?json$/i.test(f.name));
      App.go('stitch');
      if(proj&&files.length===1){Stitch.openProjectFile(proj);return}
      Stitch.addFiles(files);return;
    }
    const url=findUrl(e.dataTransfer.getData('text/uri-list')||e.dataTransfer.getData('text/plain'));
    if(url){App.go('rip');Rip.read(url)}else toast('That drop wasn’t a link or a video file',{kind:'warn'});
  });
})();

/* ---------- install as app ---------- */
let installEvt=null;
addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvt=e;$('#bInstall').hidden=false});
$('#bInstall').onclick=async()=>{if(!installEvt)return;installEvt.prompt();await installEvt.userChoice.catch(()=>{});installEvt=null;$('#bInstall').hidden=true};
