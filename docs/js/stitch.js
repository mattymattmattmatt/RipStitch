'use strict';
/* ============================================================
   Stitch: offline video cut list (born as SPLICE v2).
   Clips are read straight from disk in the browser and never
   uploaded. Exports via MediaRecorder or a generated FFmpeg script.
   ============================================================ */
const Stitch=(()=>{
const STD_FPS=[23.976,24,25,29.97,30,48,50,59.94,60,90,100,119.88,120];
function fpsNorm(f){if(!f||!isFinite(f))return null;const s=STD_FPS.find(x=>Math.abs(x-f)<0.02);return s||Math.round(f*100)/100}
function fpsLabel(f){f=fpsNorm(f);return f?(Number.isInteger(f)?f:f.toFixed(f*100%1?3:2).replace(/0+$/,''))+' fps':'—'}
function fpsExpr(f){const map={23.976:'24000/1001',29.97:'30000/1001',59.94:'60000/1001',119.88:'120000/1001'};f=fpsNorm(f)||30;return map[f]||String(f)}
function mode(arr){const m=new Map();let best=null,bc=0;for(const v of arr){const c=(m.get(v)||0)+1;m.set(v,c);if(c>bc){bc=c;best=v}}return best}

/* ---------- state ---------- */
const ORIGIN=14, PROBE_W=84, MIN_LEN=0.04;
const pool=new Map(); let uid=0;
const S={clips:[],sel:null,view:'timeline',pps:null,exporting:null,blade:false};
/** Editor preferences (Settings → Stitch). */
const P=Object.assign({fadeLen:0.5,snap:true,skim:true,autosave:true,frameFmt:'png'},LS.get('stitch.prefs',{}));
const V={mode:'clip',clip:null,playing:false,seqT:0,seq:null,vol:true,stopAt:null};
const TL={pps:30,fit:30,segs:[],byId:new Map(),els:new Map(),gap:null,freeze:null,lift:null,trimId:null,insAt:null};
let SEQ={segs:[],total:0};
const hist={u:[],r:[]};
const D=[$('#d0'),$('#d1')];
const frame=$('#frame'),stage=$('#stage'),xcv=$('#xcv'),tls=$('#tls'),tlc=$('#tlc'),track=$('#track'),ph=$('#ph'),ins=$('#ins'),ruler=$('#ruler');

const ok=c=>c&&c.state==='ok';
const clipLen=c=>ok(c)?Math.max(0,c.out-c.in):0;
const canPlay=c=>ok(c)&&!!c.file&&c.playable;
const fpsOf=c=>fpsNorm(c?.meta?.fps)||30;
const idxOf=c=>S.clips.indexOf(c);
const tag=c=>pad2(idxOf(c)+1);
const volOf=c=>c?.vol??1;
/** Fade lengths that fit the clip: if they'd overlap, both shrink in proportion. */
function fades(c){const L=Math.max(0,c.out-c.in);let fi=Math.max(0,c.fi||0),fo=Math.max(0,c.fo||0);if(fi+fo>L&&fi+fo>0){const k=L/(fi+fo);fi*=k;fo*=k}return{fi,fo}}
/** Picture and sound level (0-1) at source time t of a clip, from its fades. Outside the trimmed part it's 1. */
function fxAlpha(c,t){if(!ok(c)||t<c.in-1e-3||t>c.out+1e-3)return 1;const{fi,fo}=fades(c);let a=1;if(fi>0)a=Math.min(a,(t-c.in)/fi);if(fo>0)a=Math.min(a,(c.out-t)/fo);return clamp(a,0,1)}

/* ---------- history (undo / redo) ---------- */
const snap=()=>S.clips.map(c=>({id:c.id,in:c.in,out:c.out,muted:c.muted,fi:c.fi,fo:c.fo,vol:c.vol}));
function restore(s){
  S.clips=s.map(x=>{const c=pool.get(x.id);c.in=x.in;c.out=x.out;c.muted=x.muted;c.fi=x.fi||0;c.fo=x.fo||0;c.vol=x.vol??1;return c}).filter(c=>c.state!=='error');
  if(!S.clips.some(c=>c.id===S.sel))S.sel=null;
}
function pushHist(){hist.u.push(snap());if(hist.u.length>300)hist.u.shift();hist.r.length=0}
function edit(fn){if(S.exporting)return false;stopPlayback();pushHist();fn();changed();return true}
function undo(){if(S.exporting||!hist.u.length)return;stopPlayback();hist.r.push(snap());restore(hist.u.pop());changed();viewerFollowSel()}
function redo(){if(S.exporting||!hist.r.length)return;stopPlayback();hist.u.push(snap());restore(hist.r.pop());changed();viewerFollowSel()}
function purgeFromHistory(id){for(const st of[hist.u,hist.r])for(const s of st){const i=s.findIndex(x=>x.id===id);if(i>=0)s.splice(i,1)}}

/* ---------- render scheduling ---------- */
let rq=false;
function changed(){if(!rq){rq=true;requestAnimationFrame(()=>{rq=false;renderAll()})}scheduleSave()}
function renderAll(){renderTimeline();renderInspector();renderChrome();layoutFrame();viewerSync();scheduleUI()}

/* ============================================================
   CONTAINER PROBING — reads MP4/MOV boxes and Matroska/WebM
   elements straight from the file to get codecs, fps, audio.
   ============================================================ */
const VCODEC={avc1:'H.264',avc3:'H.264',hvc1:'HEVC',hev1:'HEVC',dvh1:'HEVC',dvhe:'HEVC',vp08:'VP8',vp09:'VP9',av01:'AV1',mp4v:'MPEG-4',apch:'ProRes',apcn:'ProRes',apcs:'ProRes',apco:'ProRes',ap4h:'ProRes',ap4x:'ProRes',jpeg:'MJPEG',mjpa:'MJPEG','dvc ':'DV',dvcp:'DV',dvpp:'DV',s263:'H.263',h263:'H.263'};
const ACODEC={mp4a:'AAC',Opus:'Opus',opus:'Opus','ac-3':'AC-3','ec-3':'E-AC-3',alac:'ALAC',lpcm:'PCM',sowt:'PCM',twos:'PCM',in24:'PCM',in32:'PCM',fl32:'PCM',fl64:'PCM','raw ':'PCM','.mp3':'MP3',fLaC:'FLAC',samr:'AMR',sawb:'AMR'};
const MKV_V=[[/^V_MPEG4\/ISO\/AVC/,'H.264'],[/^V_MPEGH\/ISO\/HEVC/,'HEVC'],[/^V_VP8/,'VP8'],[/^V_VP9/,'VP9'],[/^V_AV1/,'AV1'],[/^V_MPEG4/,'MPEG-4'],[/^V_MJPEG/,'MJPEG'],[/^V_PRORES/,'ProRes'],[/^V_THEORA/,'Theora']];
const MKV_A=[[/^A_OPUS/,'Opus'],[/^A_VORBIS/,'Vorbis'],[/^A_AAC/,'AAC'],[/^A_AC3/,'AC-3'],[/^A_EAC3/,'E-AC-3'],[/^A_MPEG\/L3/,'MP3'],[/^A_PCM/,'PCM'],[/^A_FLAC/,'FLAC'],[/^A_DTS/,'DTS'],[/^A_TRUEHD/,'TrueHD']];
const fourcc=(dv,o)=>String.fromCharCode(dv.getUint8(o),dv.getUint8(o+1),dv.getUint8(o+2),dv.getUint8(o+3));
const sliceDV=async(f,a,b)=>new DataView(await f.slice(a,b).arrayBuffer());

async function sniff(file){
  const h=await sliceDV(file,0,Math.min(file.size,16));
  if(h.byteLength<12)return null;
  const t4=fourcc(h,4);
  if(['ftyp','moov','mdat','wide','free','skip','pnot'].includes(t4))return parseMp4(file);
  if(h.getUint32(0)===0x1A45DFA3)return parseMkv(file);
  if(fourcc(h,0)==='RIFF'&&fourcc(h,8)==='AVI ')return{container:'avi'};
  if(h.getUint8(0)===0x47||h.getUint8(4)===0x47)return{container:'ts'};
  return null;
}
function* boxes(dv,s,e){
  let o=s;
  while(o+8<=e){
    let sz=dv.getUint32(o),hd=8;const t=fourcc(dv,o+4);
    if(sz===1){if(o+16>e)return;sz=Number(dv.getBigUint64(o+8));hd=16}else if(sz===0)sz=e-o;
    if(sz<hd||o+sz>e)return;
    yield{t,s:o+hd,e:o+sz};o+=sz;
  }
}
async function parseMp4(file){
  const out={container:'mp4'};let off=0,n=0,moov=null;
  while(off+8<=file.size&&n++<5000){
    const h=await sliceDV(file,off,Math.min(file.size,off+16));
    let size=h.getUint32(0),hd=8;const type=fourcc(h,4);
    if(size===1){if(h.byteLength<16)break;size=Number(h.getBigUint64(8));hd=16}else if(size===0)size=file.size-off;
    if(size<hd)break;
    if(type==='ftyp'&&off+12<=file.size){const b=await sliceDV(file,off+8,off+12);if(fourcc(b,0)==='qt  ')out.container='mov'}
    if(type==='moov'){if(size>256*1024*1024)break;moov=await sliceDV(file,off+hd,off+size);break}
    off+=size;
  }
  if(!moov)return out;
  const tracks=[];
  for(const b of boxes(moov,0,moov.byteLength)){
    if(b.t==='mvhd'){const v=moov.getUint8(b.s);const ts=v===1?moov.getUint32(b.s+20):moov.getUint32(b.s+12);const du=v===1?Number(moov.getBigUint64(b.s+24)):moov.getUint32(b.s+16);if(ts)out.dur=du/ts}
    if(b.t==='trak')tracks.push(parseTrak(moov,b));
  }
  const v=tracks.find(t=>t.kind==='vide'),a=tracks.find(t=>t.kind==='soun');
  if(v){
    out.vcodec=VCODEC[v.fmt]||(v.fmt||'?').trim().toUpperCase();
    let w=v.w||Math.round(v.tw)||0,h=v.h||Math.round(v.th)||0;out.rot=v.rot||0;
    if(out.rot%180===90)[w,h]=[h,w];
    out.w=w;out.h=h;out.fps=v.fps||null;if(!out.dur&&v.dur)out.dur=v.dur;
  }
  out.hasAudio=!!a;
  if(a){out.acodec=ACODEC[a.fmt]||(a.fmt||'?').trim();out.ach=a.ch||null;out.asr=a.sr||null}
  return out;
}
function parseTrak(dv,trak){
  const t={};
  for(const b of boxes(dv,trak.s,trak.e)){
    if(b.t==='tkhd'){const v=dv.getUint8(b.s),m=b.s+(v===1?52:40);if(m+44<=b.e){const a=dv.getInt32(m),bb=dv.getInt32(m+4);t.rot=((Math.round(Math.atan2(bb,a)*180/Math.PI)%360)+360)%360;t.tw=dv.getUint32(m+36)/65536;t.th=dv.getUint32(m+40)/65536}}
    if(b.t!=='mdia')continue;
    for(const m of boxes(dv,b.s,b.e)){
      if(m.t==='mdhd'){const v=dv.getUint8(m.s);t.ts=v===1?dv.getUint32(m.s+20):dv.getUint32(m.s+12);const d=v===1?Number(dv.getBigUint64(m.s+24)):dv.getUint32(m.s+16);t.dur=t.ts?d/t.ts:null}
      else if(m.t==='hdlr')t.kind=fourcc(dv,m.s+8);
      else if(m.t==='minf')for(const x of boxes(dv,m.s,m.e))if(x.t==='stbl')for(const y of boxes(dv,x.s,x.e)){
        if(y.t==='stsd'&&y.s+16<=y.e){
          const e=y.s+8;t.fmt=fourcc(dv,e+4);
          if(t.kind==='vide'&&e+36<=y.e){t.w=dv.getUint16(e+32);t.h=dv.getUint16(e+34)}
          if(t.kind==='soun'&&e+36<=y.e){
            const ver=dv.getUint16(e+16);
            if(ver===2&&e+52<=y.e){t.sr=Math.round(dv.getFloat64(e+40));t.ch=dv.getUint32(e+48)}
            else{t.ch=dv.getUint16(e+24);t.sr=dv.getUint32(e+32)>>>16}
          }
        }
        if(y.t==='stts'){const cnt=dv.getUint32(y.s+4);let smp=0,tot=0;for(let i=0;i<cnt&&y.s+16+i*8<=y.e;i++){const c=dv.getUint32(y.s+8+i*8),d=dv.getUint32(y.s+12+i*8);smp+=c;tot+=c*d}t.smp=smp;t.stt=tot}
      }
    }
  }
  if(t.kind==='vide'&&t.ts&&t.stt&&t.smp>1)t.fps=t.smp*t.ts/t.stt;
  return t;
}
async function parseMkv(file){
  const b=new Uint8Array(await file.slice(0,Math.min(file.size,4*1024*1024)).arrayBuffer());
  const out={container:'mkv'};let p=0;const N=b.length;
  const vlen=x=>{for(let i=0;i<8;i++)if(x&(0x80>>i))return i+1;return 0};
  const rid=()=>{const l=vlen(b[p]);if(!l||l>4)throw new Error('ebml id');let v=0;for(let i=0;i<l;i++)v=v*256+b[p+i];p+=l;return v};
  const rsz=()=>{const l=vlen(b[p]);if(!l)throw new Error('ebml size');let v=b[p]&(0xFF>>l),ones=v===(0xFF>>l);for(let i=1;i<l;i++){v=v*256+b[p+i];if(b[p+i]!==255)ones=false}p+=l;return ones?-1:v};
  const el=()=>{const id=rid(),size=rsz();return{id,size,ds:p,end:size<0?N:Math.min(N,p+size)}};
  const uint=(s,n)=>{let v=0;for(let i=0;i<n;i++)v=v*256+b[s+i];return v};
  const flt=(s,n)=>{const dv=new DataView(b.buffer,s,n);return n===4?dv.getFloat32(0):n===8?dv.getFloat64(0):NaN};
  const str=(s,n)=>String.fromCharCode(...b.subarray(s,s+n)).replace(/\0+$/,'');
  let e=el();if(e.id!==0x1A45DFA3)return out;
  while(p<e.end){const c=el();if(c.id===0x4282&&str(c.ds,c.size)==='webm')out.container='webm';p=c.end}
  e=el();if(e.id!==0x18538067)return out;
  let scale=1e6,dur=null;const tracks=[];
  while(p<e.end&&p<N){
    const c=el();if(c.size<0&&c.id!==0x18538067)break;
    if(c.id===0x1549A966){while(p<c.end){const k=el();if(k.id===0x2AD7B1)scale=uint(k.ds,k.size);else if(k.id===0x4489)dur=flt(k.ds,k.size);p=k.end}}
    else if(c.id===0x1654AE6B){
      while(p<c.end){const te=el();if(te.id===0xAE){const t={};
        while(p<te.end){const k=el();
          if(k.id===0x83)t.type=uint(k.ds,k.size);
          else if(k.id===0x86)t.codec=str(k.ds,k.size);
          else if(k.id===0x23E383)t.defdur=uint(k.ds,k.size);
          else if(k.id===0xE0){while(p<k.end){const v=el();if(v.id===0xB0)t.w=uint(v.ds,v.size);else if(v.id===0xBA)t.h=uint(v.ds,v.size);p=v.end}}
          else if(k.id===0xE1){while(p<k.end){const a=el();if(a.id===0xB5)t.sr=Math.round(flt(a.ds,a.size));else if(a.id===0x9F)t.ch=uint(a.ds,a.size);p=a.end}}
          p=k.end}
        tracks.push(t)}p=te.end}
    }
    else if(c.id===0x1F43B675)break;
    p=c.end;
  }
  if(dur&&isFinite(dur))out.dur=dur*scale/1e9;
  const v=tracks.find(t=>t.type===1),a=tracks.find(t=>t.type===2);
  const pick=(tbl,id)=>{for(const[re,n]of tbl)if(re.test(id||''))return n;return(id||'?').replace(/^[VA]_/,'')};
  if(v){out.vcodec=pick(MKV_V,v.codec);out.w=v.w;out.h=v.h;if(v.defdur)out.fps=1e9/v.defdur}
  out.hasAudio=!!a;if(a){out.acodec=pick(MKV_A,a.codec);out.ach=a.ch||null;out.asr=a.sr||null}
  return out;
}

/* ---------- browser decode probe + thumbnail ---------- */
const MEDIA_ERR={1:'Read aborted',2:'File read error',3:'Browser could not decode the video',4:'Format or codec not supported by this browser'};
function realDuration(v){
  if(isFinite(v.duration)&&v.duration>0)return Promise.resolve(v.duration);
  // WebM from recorders often has no duration header: seek far past the end to make the browser find it.
  return new Promise((res,rej)=>{
    const done=()=>{if(isFinite(v.duration)&&v.duration>0){clearTimeout(to);v.removeEventListener('durationchange',done);v.removeEventListener('seeked',done);res(v.duration)}};
    const to=setTimeout(()=>{v.removeEventListener('durationchange',done);v.removeEventListener('seeked',done);rej(new Error('Duration unreadable'))},8000);
    v.addEventListener('durationchange',done);v.addEventListener('seeked',done);v.currentTime=1e9;
  });
}
function seekOnce(v,t,ms=8000){
  return new Promise(res=>{
    const h=()=>{clearTimeout(to);v.removeEventListener('seeked',h);res()};
    const to=setTimeout(h,ms);v.addEventListener('seeked',h);v.currentTime=t;
  });
}
function probeVideo(c){
  return new Promise((res,rej)=>{
    const v=document.createElement('video');v.preload='metadata';v.muted=true;v.playsInline=true;
    let done=false;
    const cleanup=()=>{clearTimeout(to);v.onerror=v.onloadedmetadata=null;v.removeAttribute('src');v.load()};
    const fail=m=>{if(done)return;done=true;cleanup();rej(new Error(m))};
    const to=setTimeout(()=>fail('Timed out reading the file'),20000);
    v.onerror=()=>fail(MEDIA_ERR[v.error?.code]||'Browser could not read this file');
    v.onloadedmetadata=async()=>{
      try{
        if(!v.videoWidth||!v.videoHeight)throw new Error('No video track this browser can decode');
        const dur=await realDuration(v);
        await seekOnce(v,Math.min(dur/2,Math.max(0.25,Math.min(2,dur*0.1))));
        if(v.readyState<2)await new Promise(r=>{const h=()=>{v.removeEventListener('loadeddata',h);r()};v.addEventListener('loadeddata',h);setTimeout(h,3000)});
        const th=120,tw=Math.max(16,Math.min(360,Math.round(th*v.videoWidth/v.videoHeight)));
        const cv=document.createElement('canvas');cv.width=tw;cv.height=th;cv.getContext('2d').drawImage(v,0,0,tw,th);
        const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.74));
        if(done)return;done=true;const out={dur,w:v.videoWidth,h:v.videoHeight,thumb:blob?URL.createObjectURL(blob):null};cleanup();
        if(out.thumb){const im=new Image();im.src=out.thumb;try{await im.decode()}catch{}} // warm the cache so tiles never flash black
        res(out);
      }catch(e){fail(e.message)}
    };
    v.src=c.url;
  });
}
const probeQ=[];let probing=0;
function queueProbe(c){probeQ.push(c);pumpProbe()}
function pumpProbe(){while(probing<3&&probeQ.length){const c=probeQ.shift();probing++;probe(c).catch(e=>console.error(e)).finally(()=>{probing--;pumpProbe();if(!probing&&!probeQ.length)changed()})}}
async function probe(c){
  let info=null,vid=null,vErr=null;
  try{info=await sniff(c.file)}catch(e){console.warn('container parse',c.name,e)}
  try{vid=await probeVideo(c)}catch(e){vErr=e.message}
  const m=Object.assign({},c.meta||{});
  if(info)for(const k of['container','vcodec','acodec','hasAudio','fps','ach','asr','rot'])if(info[k]!=null)m[k]=info[k];
  if(vid){m.dur=vid.dur;m.w=vid.w;m.h=vid.h}
  else if(info&&info.dur&&info.w){m.dur=info.dur;m.w=info.w;m.h=info.h}
  if(!m.dur||!m.w){
    const hint=info?.container==='ts'?'MPEG-TS (.mts/.ts) can’t be read in the browser. Remux it first: ffmpeg -i in.mts -c copy out.mp4'
      :info?.container==='avi'?'AVI can’t be read in the browser. Remux or convert it to MP4 first.'
      :(vErr||'Unrecognised file');
    fail(c,hint);return;
  }
  const first=c.state==='probing';
  c.meta=m;c.playable=!!vid;c.why=vid?null:(vErr||'Browser cannot decode this file');
  if(vid?.thumb)c.thumb=vid.thumb;
  if(first){c.in=0;c.out=m.dur}else{c.out=Math.min(c.out||m.dur,m.dur);c.in=Math.min(c.in,Math.max(0,c.out-MIN_LEN))}
  c.state='ok';changed();
  if(c.playable&&!first&&c.in>1)grabThumb(c);
  if(!c.playable&&first)noPreviewNotice(c);
}
const npPending=[];let npT=0;
function noPreviewNotice(c){
  npPending.push(c);clearTimeout(npT);
  npT=setTimeout(()=>{
    const list=npPending.splice(0).sort((a,b)=>idxOf(a)-idxOf(b)),codecs=[...new Set(list.map(c=>c.meta.vcodec||'unknown codec'))].join(' / ');
    toast(list.length===1?`${list[0].name}: no browser preview`:`${list.length} clips have no browser preview`,{kind:'warn',
      sub:`${codecs} can’t be decoded in this browser${list.length>1?' ('+list.map(tag).join(', ')+')':''}. They stay on the timeline — trim by timecode and render with the FFmpeg script.`});
  },400);
}
function fail(c,why){
  c.state='error';c.err=why;
  const i=S.clips.indexOf(c);if(i>=0)S.clips.splice(i,1);
  purgeFromHistory(c.id);if(S.sel===c.id)S.sel=null;
  toast(`Couldn’t add ${c.name}`,{kind:'err',sub:why});changed();
}

/* ---------- adding files / relinking ---------- */
const VIDEO_EXT=/\.(mp4|m4v|mov|qt|webm|mkv|avi|ogv|mts|m2ts|ts|mpg|mpeg|wmv|3gp|flv)$/i;
const isVideo=f=>(f.type&&f.type.startsWith('video/'))||VIDEO_EXT.test(f.name);
function newClip(f,src){const c={id:++uid,src:src||null,name:f.name,size:f.size,mtime:f.lastModified,file:f,url:URL.createObjectURL(f),state:'probing',playable:false,meta:null,thumb:null,in:0,out:0,muted:false,fi:0,fo:0,vol:1};pool.set(c.id,c);return c}
function addFiles(list,o={}){
  if(S.exporting){toast('Wait for the export to finish',{kind:'warn'});return}
  const files=[...list],vids=files.filter(isVideo),skipped=files.length-vids.length;
  let relinked=0,dupes=0;const fresh=[];
  for(const f of vids){
    const offs=S.clips.filter(c=>!c.file&&c.name===f.name&&(!c.size||c.size===f.size));
    if(offs.length){const url=URL.createObjectURL(f);for(const off of offs){off.file=f;off.size=f.size;off.mtime=f.lastModified;off.url=url;queueProbe(off)}relinked++;continue}
    if(S.clips.some(c=>c.file&&c.name===f.name&&c.size===f.size&&c.mtime===f.lastModified)){dupes++;continue}
    fresh.push(f);
  }
  fresh.sort((a,b)=>collator.compare(a.name,b.name));
  if(fresh.length){
    stopPlayback();pushHist();
    const made=fresh.map(f=>newClip(f,o.src));S.clips.push(...made);made.forEach(queueProbe);
    if(S.sel==null){S.sel=made[0].id;V.mode='clip'}
    changed();
  }else if(relinked)changed();
  const bits=[];
  if(fresh.length)bits.push(`Added ${fresh.length} clip${fresh.length>1?'s':''}`);
  if(relinked)bits.push(`relinked ${relinked}`);
  if(bits.length)toast(bits.join(' · '),{kind:'ok',sub:dupes?`${dupes} already on the timeline — use Duplicate (Ctrl+D) to reuse a clip`:null});
  else if(dupes)toast(`${dupes} file${dupes>1?'s are':' is'} already on the timeline`,{kind:'warn',sub:'Select a clip and press Ctrl+D to use it twice.'});
  if(skipped)toast(`${skipped} file${skipped>1?'s':''} skipped — not video`,{kind:'warn'});
}

/* ============================================================
   TIMELINE
   ============================================================ */
function rebuildSeq(){let t=0;const segs=[];for(const c of S.clips){if(!ok(c))continue;const len=c.out-c.in;segs.push({c,start:t,len,in:c.in,out:c.out});t+=len}SEQ={segs,total:t}}
function computePps(){
  const vw=Math.max(200,tls.clientWidth-ORIGIN*2-24);
  TL.fit=SEQ.total>0?vw/SEQ.total:40;
  if(TL.freeze!=null)return TL.freeze;
  return S.pps==null?clamp(TL.fit,0.005,600):clamp(S.pps,0.005,1200);
}
function layout(){
  const pps=TL.pps,segs=[];let t=0,extra=0;
  for(const c of S.clips){
    if(ok(c)){
      const len=c.out-c.in,g=TL.gap?.id===c.id?TL.gap.sec:0;
      segs.push({c,start:t,len,x:ORIGIN+(t+g)*pps+extra,w:Math.max(2,len*pps)});t+=len+g;
    }else if(c.state==='probing'){segs.push({c,start:t,len:0,x:ORIGIN+t*pps+extra,w:PROBE_W});extra+=PROBE_W+2}
  }
  return segs;
}
function makeClipEl(c){
  const el=document.createElement('div');el.className='clip';el.dataset.id=c.id;
  el.innerHTML=`<div class="film"></div><div class="au">${ic('mute','au-ic')}</div><div class="lab"><span class="n"></span><span class="t"></span></div><div class="dur"></div><div class="badges"></div><div class="sub2"></div><div class="fdi"></div><div class="fdo"></div><button class="x" tabindex="-1" data-tip="Remove clip" data-key="Del">${ic('x')}</button><div class="h l" data-tip="Drag to trim the start"></div><div class="h r" data-tip="Drag to trim the end"></div><div class="ring"></div>`;
  el._={};return el;
}
function setTxt(el,key,sel,val){if(el._[key]!==val){el._[key]=val;el.querySelector(sel).textContent=val}}
function setHtml(el,key,sel,val){if(el._[key]!==val){el._[key]=val;el.querySelector(sel).innerHTML=val}}
function updateClipEl(el,c,i,s,grid){
  const w=grid?178:s.w;
  if(!grid){const l=s.x+'px',ww=s.w+'px';if(el._l!==l){el.style.left=el._l=l}if(el._w!==ww){el.style.width=el._w=ww}}
  else if(el._l!==''){el.style.left=el.style.width='';el._l=el._w=''}
  const m=c.meta||{};
  const cls=['clip',c.id===S.sel&&'sel',c.state==='probing'&&'probing',ok(c)&&!c.file&&'offline',ok(c)&&c.file&&!c.playable&&'noplay',
    c.muted&&'muted',m.hasAudio===false&&'noaudio',ok(c)&&c.in>1e-3&&'ti',ok(c)&&c.out<m.dur-1e-3&&'to',
    !grid&&w<70&&'narrow',!grid&&w<24&&'tiny',TL.lift===c.id&&'lift',TL.trimId===c.id&&'trimming'].filter(Boolean).join(' ');
  if(el.className!==cls)el.className=cls;
  setTxt(el,'n','.n',pad2(i+1));setTxt(el,'t','.t',c.name);
  setTxt(el,'d','.dur',c.state==='probing'?'reading…':tc(clipLen(c),1));
  const bd=[];
  if(ok(c)&&!c.file)bd.push('<span class="badge b">MISSING</span>');
  else if(ok(c)&&!c.playable)bd.push(`<span class="badge w">${esc(m.vcodec||'NO PREVIEW')}</span>`);
  if(c.src==='rip')bd.push('<span class="badge r">RIP</span>');
  if(m.hasAudio===false)bd.push('<span class="badge">NO AUDIO</span>');else if(c.muted)bd.push('<span class="badge">MUTED</span>');else if(ok(c)&&volOf(c)!==1)bd.push(`<span class="badge">${Math.round(volOf(c)*100)}%</span>`);
  setHtml(el,'b','.badges',bd.join(''));
  setTxt(el,'s2','.sub2',ok(c)?`${m.w}×${m.h} · ${fpsLabel(m.fps)}${m.vcodec?' · '+m.vcodec:''}`:'');
  if(!grid){const f=ok(c)?fades(c):{fi:0,fo:0},a=f.fi>0?Math.max(4,f.fi*TL.pps)+'px':'0px',b=f.fo>0?Math.max(4,f.fo*TL.pps)+'px':'0px';
    if(el._fi!==a){el._fi=a;el.querySelector('.fdi').style.width=a}if(el._fo!==b){el._fo=b;el.querySelector('.fdo').style.width=b}}
  const bg=c.thumb?`url("${c.thumb}")`:'';if(el._bg!==bg){el._bg=bg;el.querySelector('.film').style.backgroundImage=bg}
  el.title=c.name;
}
function renderTimeline(){
  rebuildSeq();
  const grid=S.view==='grid';
  tls.classList.toggle('grid',grid);
  TL.pps=computePps();
  const segs=layout();TL.segs=segs;TL.byId=new Map(segs.map(s=>[s.c.id,s]));
  const seen=new Set();let prev=null;
  segs.forEach((s,i)=>{
    let el=TL.els.get(s.c.id);if(!el){el=makeClipEl(s.c);TL.els.set(s.c.id,el)}
    seen.add(s.c.id);updateClipEl(el,s.c,i,s,grid);
    const want=prev?prev.nextSibling:track.firstChild;if(want!==el)track.insertBefore(el,want);prev=el;
  });
  for(const[id,el]of TL.els)if(!seen.has(id)){el.remove();TL.els.delete(id)}
  if(grid)tlc.style.width='';
  else{const last=segs.at(-1);const endX=last?last.x+last.w:0;tlc.style.width=Math.max(tls.clientWidth,endX+(S.pps==null?ORIGIN:260))+'px'}
  $('#tlEmpty').hidden=S.clips.length>0;ruler.hidden=grid;
  $('#zRead').textContent=grid?'—':S.pps==null?'FIT':Math.round(TL.pps/TL.fit*100)+'%';
  for(const b of['#zIn','#zOut','#zFit'])$(b).disabled=grid||!SEQ.total;
  $$('#vView button').forEach(b=>b.classList.toggle('on',b.dataset.v===S.view));
  drawRuler();placePlayhead();stickyLabels();
}
function seqToX(t){
  const segs=SEQ.segs;if(!segs.length)return ORIGIN;
  let lo=0,hi=segs.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(t<segs[mid].start+segs[mid].len)hi=mid;else lo=mid+1}
  const s=segs[lo],v=TL.byId.get(s.c.id);if(!v)return ORIGIN+t*TL.pps;
  return v.x+clamp(t-s.start,0,s.len)*TL.pps;
}
function xToSeq(x){
  for(const s of SEQ.segs){const v=TL.byId.get(s.c.id);if(!v)continue;if(x<v.x+v.w)return s.start+clamp((x-v.x)/TL.pps,0,s.len)}
  return SEQ.total;
}
function segAt(t){const segs=SEQ.segs;if(!segs.length)return null;for(const s of segs)if(t<s.start+s.len-1e-6)return s;return segs.at(-1)}
const RULER_FONT='600 10px '+getComputedStyle(document.documentElement).getPropertyValue('--mono');
const rulerSteps=[0.1,0.2,0.5,1,2,5,10,15,30,60,120,300,600,900,1800,3600,7200];
function drawRuler(){
  if(S.view==='grid')return;
  const dpr=devicePixelRatio||1,w=ruler.clientWidth,h=ruler.clientHeight;if(!w)return;
  if(ruler.width!==Math.round(w*dpr)||ruler.height!==Math.round(h*dpr)){ruler.width=Math.round(w*dpr);ruler.height=Math.round(h*dpr)}
  const g=ruler.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);
  const pps=TL.pps,sl=tls.scrollLeft,total=SEQ.total;
  const endX=seqToX(total)-sl;
  if(endX<w){g.fillStyle='rgba(0,0,0,.25)';g.fillRect(Math.max(0,endX),0,w,h)}
  if(total>0){
    const step=rulerSteps.find(s=>s*pps>=78)||14400,minor=step/(step>=60&&step%60===0&&step<=120?4:5);
    const t0=Math.max(0,Math.floor(((sl-ORIGIN)/pps)/step)*step);
    g.font=RULER_FONT;g.textBaseline='middle';
    for(let t=Math.max(0,Math.floor(((sl-ORIGIN)/pps)/minor)*minor);ORIGIN+t*pps-sl<w;t+=minor){
      const x=Math.round(ORIGIN+t*pps-sl)+.5;g.strokeStyle='#2a333f';g.beginPath();g.moveTo(x,h);g.lineTo(x,h-4);g.stroke();
    }
    for(let t=t0;ORIGIN+t*pps-sl<w+60;t+=step){
      const x=Math.round(ORIGIN+t*pps-sl)+.5;
      g.strokeStyle='#3a4555';g.beginPath();g.moveTo(x,h);g.lineTo(x,h-9);g.stroke();
      g.fillStyle='#7f8a9a';g.fillText(step<1?tc(t,1):tc(t,0),x+4,h/2-1);
    }
    // cut points
    g.fillStyle='rgba(255,210,30,.55)';
    for(const s of SEQ.segs.slice(1)){const x=seqToX(s.start)-sl;if(x>-4&&x<w+4){g.fillRect(Math.round(x)-1,h-3,2,3)}}
  }
  const pt=playheadSeqTime();
  if(pt!=null&&S.clips.length){
    const x=Math.round(seqToX(pt)-sl);
    if(x>-8&&x<w+8){g.fillStyle='#fff';g.beginPath();g.moveTo(x-6,0);g.lineTo(x+6,0);g.lineTo(x+6,h-9);g.lineTo(x,h-2);g.lineTo(x-6,h-9);g.closePath();g.fill()}
  }
}
function placePlayhead(){
  const pt=playheadSeqTime();
  if(pt==null||S.view==='grid'||!SEQ.segs.length){ph.hidden=true;return}
  ph.hidden=false;ph.style.transform=`translateX(${seqToX(pt)}px)`;
}
function followPlayhead(){
  if(S.view==='grid'||!(V.playing||S.exporting))return;
  const pt=playheadSeqTime();if(pt==null)return;
  const x=seqToX(pt),l=tls.scrollLeft,w=tls.clientWidth;
  if(x>l+w-40||x<l)tls.scrollLeft=Math.max(0,x-60);
}
function zoomAt(factor,clientX){
  if(S.view==='grid'||!SEQ.total)return;
  const r=tls.getBoundingClientRect(),px=clientX==null?r.width/2:clientX-r.left;
  const t=(tls.scrollLeft+px-ORIGIN)/TL.pps;
  const next=TL.pps*factor;S.pps=next<=TL.fit*1.001?null:Math.min(next,1200);
  renderTimeline();tls.scrollLeft=Math.max(0,ORIGIN+t*TL.pps-px);drawRuler();
}
function zoomFit(){S.pps=null;renderTimeline();tls.scrollLeft=0;drawRuler()}

/* timeline pointer interactions */
track.addEventListener('pointerdown',e=>{
  if(e.button!==0||S.exporting)return;
  if(S.blade){const h=bladeHit(e);if(h){e.preventDefault();bladeCut(h)}return}
  if(e.target.closest('.x'))return;
  const el=e.target.closest('.clip'),h=e.target.closest('.h');
  const c=el&&pool.get(+el.dataset.id);
  if(h&&ok(c)&&S.view==='timeline'){startTrim(e,c,h.classList.contains('l')?'l':'r');return}
  if(c){startPress(e,c,el);return}
  if(S.view==='timeline'&&SEQ.total)startRulerScrub(e,tls);
});
track.addEventListener('pointermove',e=>{if(S.blade&&!S.exporting)bladeHover(e)});
track.addEventListener('pointerleave',()=>{if(S.blade){bladeHide();skimEnd()}});
track.addEventListener('contextmenu',e=>{
  const el=e.target.closest('.clip');if(!el)return;
  e.preventDefault();if(S.exporting)return;
  const c=pool.get(+el.dataset.id);if(!ok(c))return;
  const hit=S.view==='timeline'?bladeHit(e):null;
  openCtx(e,c,hit&&hit.c===c?hit:null);
});
track.addEventListener('click',e=>{const x=e.target.closest('.x');if(x){e.stopPropagation();removeClip(+x.closest('.clip').dataset.id)}});
track.addEventListener('dblclick',e=>{const el=e.target.closest('.clip');if(!el||S.exporting||S.blade)return;const c=pool.get(+el.dataset.id);if(canPlay(c)){selectClip(c.id);setTimeout(()=>clipPlay(true),60)}});
ruler.addEventListener('pointerdown',e=>{if(e.button!==0||S.exporting||!SEQ.total)return;startRulerScrub(e,ruler)});
function winDrag(move,up){
  const mv=e=>move(e),u=e=>{removeEventListener('pointermove',mv);removeEventListener('pointerup',u);removeEventListener('pointercancel',u);up(e)};
  addEventListener('pointermove',mv);addEventListener('pointerup',u);addEventListener('pointercancel',u);
}
function startRulerScrub(e,refEl){
  e.preventDefault();
  const go=ev=>{const r=refEl.getBoundingClientRect();const x=ev.clientX-r.left+tls.scrollLeft;seqSeek(xToSeq(x))};
  if(V.mode!=='seq'){stopPlayback();V.mode='seq';syncModeButtons()}
  go(e);winDrag(go,()=>{});
}
function startPress(e,c,el){
  const sx=e.clientX,sy=e.clientY;let drag=false,raf=0,last=e;
  const loop=()=>{raf=requestAnimationFrame(loop);
    const r=tls.getBoundingClientRect(),edge=48;
    if(S.view==='timeline'){if(last.clientX<r.left+edge)tls.scrollLeft-=Math.ceil((r.left+edge-last.clientX)/3);else if(last.clientX>r.right-edge)tls.scrollLeft+=Math.ceil((last.clientX-r.right+edge)/3)}
    else{if(last.clientY<r.top+edge)tls.scrollTop-=Math.ceil((r.top+edge-last.clientY)/3);else if(last.clientY>r.bottom-edge)tls.scrollTop+=Math.ceil((last.clientY-r.bottom+edge)/3)}
    showInsert(last);
  };
  winDrag(ev=>{
    last=ev;
    if(!drag){if(Math.hypot(ev.clientX-sx,ev.clientY-sy)<5)return;drag=true;TL.lift=c.id;document.body.classList.add('dragging');hideTip();renderTimeline();raf=requestAnimationFrame(loop)}
  },()=>{
    cancelAnimationFrame(raf);
    if(!drag){selectClip(c.id);return}
    document.body.classList.remove('dragging');TL.lift=null;ins.hidden=true;
    const at=TL.insAt;TL.insAt=null;moveClipTo(c.id,at);
  });
}
function insertIndex(e){
  if(S.view==='timeline'){
    const r=tls.getBoundingClientRect(),x=e.clientX-r.left+tls.scrollLeft;
    for(let i=0;i<TL.segs.length;i++){const s=TL.segs[i];if(x<s.x+s.w/2)return i}
    return TL.segs.length;
  }
  for(let i=0;i<S.clips.length;i++){const el=TL.els.get(S.clips[i].id);if(!el)continue;const r=el.getBoundingClientRect();if(e.clientY<r.top||(e.clientY<=r.bottom&&e.clientX<r.left+r.width/2))return i}
  return S.clips.length;
}
function showInsert(e){
  const at=insertIndex(e);TL.insAt=at;ins.hidden=false;
  if(S.view==='timeline'){
    const s=TL.segs[at],last=TL.segs.at(-1);
    ins.style.left=(s?s.x-1:last?last.x+last.w+1:ORIGIN)+'px';ins.style.top='4px';ins.style.bottom='4px';ins.style.height='';
  }else{
    const base=tlc.getBoundingClientRect(),el=TL.els.get(S.clips[at]?.id),lastEl=TL.els.get(S.clips.at(-1)?.id);
    const r=(el||lastEl).getBoundingClientRect();
    ins.style.left=((el?r.left-5:r.right+5)-base.left)+'px';ins.style.top=(r.top-base.top)+'px';ins.style.height=r.height+'px';ins.style.bottom='auto';
  }
}
function startTrim(e,c,side){
  e.preventDefault();e.stopPropagation();
  pushHist();stopPlayback();
  if(S.sel!==c.id||V.mode!=='clip'){S.sel=c.id;V.mode='clip';renderInspector();syncModeButtons()}
  TL.freeze=TL.pps;TL.trimId=c.id;document.body.classList.add('trimming');hideTip();
  const sx=e.clientX,in0=c.in,out0=c.out,fps=fpsOf(c),minL=Math.max(1/fps,MIN_LEN),snap=t=>Math.round(t*fps)/fps;
  const move=ev=>{
    const dt=(ev.clientX-sx)/TL.pps;
    if(side==='l'){c.in=clamp(snap(in0+dt),0,c.out-minL);TL.gap={id:c.id,sec:c.in-in0};previewAt(c,c.in)}
    else{c.out=clamp(snap(out0+dt),c.in+minL,c.meta.dur);previewAt(c,Math.max(c.in,c.out-1/fps))}
    const d=side==='l'?c.in-in0:c.out-out0;
    dragTip(ev,`${side==='l'?'IN':'OUT'} ${tc(side==='l'?c.in:c.out)} <span style="opacity:.6">${d>=0?'+':'−'}${tc(Math.abs(d))}</span> · ${tc(c.out-c.in,1)}`);
    renderTimeline();renderInspector();
  };
  winDrag(move,()=>{
    TL.freeze=null;TL.gap=null;TL.trimId=null;document.body.classList.remove('trimming');dragTip(null,null);
    if(c.in===in0&&c.out===out0)hist.u.pop();
    changed();
  });
  move(e);
}
tls.addEventListener('wheel',e=>{
  if(S.view==='grid')return;
  if(e.ctrlKey||e.metaKey||e.altKey){e.preventDefault();zoomAt(e.deltaY>0?0.8:1.25,e.clientX);return}
  if(Math.abs(e.deltaY)>Math.abs(e.deltaX)&&!e.shiftKey){e.preventDefault();tls.scrollLeft+=e.deltaY}
},{passive:false});
tls.addEventListener('scroll',()=>{drawRuler();stickyLabels();closeCtx();if(S.blade)bladeHide()},{passive:true});
/** Keep the name of a clip that starts off-screen readable at the left edge. */
let stuck=[];
function stickyLabels(){
  stuck.forEach(e=>e.style.transform='');stuck=[];
  if(S.view==='grid')return;
  const sl=tls.scrollLeft-ORIGIN+8,s=TL.segs.find(s=>s.x<sl&&s.x+s.w>sl+90);if(!s)return;
  const el=TL.els.get(s.c.id);if(!el)return;
  const d=Math.max(0,Math.min(sl-s.x,s.w-170));
  for(const q of['.lab','.dur']){const e=el.querySelector(q);e.style.transform=`translateX(${d}px)`;stuck.push(e)}
}

/* ---------- structural edits ---------- */
function selectClip(id){
  const c=pool.get(id);if(!c)return;
  let t=null;
  if(V.mode==='seq'){const s=SEQ.segs.find(s=>s.c===c);if(s&&V.seqT>=s.start&&V.seqT<s.start+s.len)t=s.in+(V.seqT-s.start)}
  else if(V.clip===c)t=null;
  stopPlayback();S.sel=id;V.mode='clip';syncModeButtons();
  showClip(c,t);changed();
}
function viewerFollowSel(){const c=pool.get(S.sel);if(V.mode==='clip')showClip(c||null)}
function removeClip(id){
  const c=pool.get(id);if(!c||S.exporting)return;
  const i=S.clips.indexOf(c);
  if(!edit(()=>{S.clips.splice(i,1);if(S.sel===id){const n=S.clips[i]||S.clips[i-1];S.sel=n?n.id:null}}))return;
  viewerFollowSel();
  toast(`Removed ${c.name}`,{action:{label:'Undo',fn:undo}});
}
function moveClipTo(id,at){
  const from=S.clips.findIndex(c=>c.id===id);
  if(at==null||from<0||at===from||at===from+1){renderTimeline();return}
  edit(()=>{const[m]=S.clips.splice(from,1);S.clips.splice(at>from?at-1:at,0,m)});
}
function nudge(id,d){const i=S.clips.findIndex(c=>c.id===id),j=i+d;if(i<0||j<0||j>=S.clips.length)return;edit(()=>{[S.clips[i],S.clips[j]]=[S.clips[j],S.clips[i]]});requestAnimationFrame(()=>scrollToClip(id))}
function duplicate(id){
  const c=pool.get(id);if(!ok(c))return;
  const d={...c,id:++uid};pool.set(d.id,d);
  edit(()=>{S.clips.splice(S.clips.indexOf(c)+1,0,d);S.sel=d.id});viewerFollowSel();toast(`Duplicated ${c.name}`,{kind:'ok'});
}
/* ---------- split ---------- */
/** Cut clip c at source time t into two parts that share the file. Returns the new right-hand part. */
function splitClip(c,t,o={}){
  if(!ok(c)||S.exporting)return null;
  const fps=fpsOf(c),minL=Math.max(1/fps,MIN_LEN);t=Math.round(t*fps)/fps;
  if(t<c.in+minL-1e-6||t>c.out-minL+1e-6){
    if(!o.quiet)toast(t<=c.in+1e-6||t>=c.out-1e-6?'Move the playhead inside the clip to split it':'Too close to the edge of the clip to split there',{kind:'warn'});
    return null;
  }
  const d={...c,id:++uid,in:t,fi:0};pool.set(d.id,d);
  edit(()=>{c.out=t;c.fo=0;S.clips.splice(S.clips.indexOf(c)+1,0,d);S.sel=d.id});
  if(V.mode==='clip')showClip(d,t);
  grabThumb(d);
  if(!o.quiet)toast(`Split clip ${tag(c)} at ${tc(t)}`,{kind:'ok',sub:'Each part trims, moves and removes on its own.',action:{label:'Undo',fn:undo}});
  return d;
}
function splitAtPlayhead(){
  if(S.exporting)return;
  if(!S.clips.length){toast('Add some clips first',{kind:'warn'});return}
  const m=markTarget();
  if(!m){toast(V.mode==='clip'?'Pick a clip that can preview, then move the playhead to where you want the cut':'Move the playhead over a clip first',{kind:'warn'});return}
  splitClip(m.c,m.t);
}

/* ---------- blade tool: click anywhere on a clip to cut it there ---------- */
function setBlade(on){
  on=!!on&&S.view==='timeline'&&!S.exporting&&S.clips.length>0;
  if(S.blade===on)return;
  S.blade=on;document.body.classList.toggle('blade',on);
  $('#bBlade').classList.toggle('on',on);$('#bBlade').setAttribute('aria-pressed',String(on));
  if(!on){bladeHide();skimEnd()}
  syncHint();
}
function bladeHit(e){
  if(S.view!=='timeline')return null;
  const r=tls.getBoundingClientRect(),x=e.clientX-r.left+tls.scrollLeft;
  const s=TL.segs.find(s=>ok(s.c)&&s.len>0&&x>=s.x&&x<s.x+s.w);if(!s)return null;
  const c=s.c,fps=fpsOf(c);let t=c.in+(x-s.x)/TL.pps;
  if(P.snap){const pt=SK.on&&SK.mode==='seq'?SK.t:playheadSeqTime();if(pt!=null&&pt>s.start&&pt<s.start+s.len&&Math.abs(seqToX(pt)-x)<=7)t=c.in+(pt-s.start)}
  t=clamp(Math.round(t*fps)/fps,c.in,c.out);
  return{c,s,t,x:s.x+(t-c.in)*TL.pps,seqT:s.start+(t-c.in)};
}
function bladeOk(h){const minL=Math.max(1/fpsOf(h.c),MIN_LEN);return h.t>=h.c.in+minL-1e-6&&h.t<=h.c.out-minL+1e-6}
function bladeHover(e){
  const h=bladeHit(e);if(!h){bladeHide();return}
  const ln=$('#bladeLn'),good=bladeOk(h);
  ln.hidden=false;ln.style.transform=`translateX(${h.x}px)`;ln.classList.toggle('no',!good);
  dragTip(e,good?`CUT ${tc(h.seqT)} <span style="opacity:.6">· clip ${tag(h.c)} @ ${tc(h.t)}</span>`:'Too close to the edge');
  skimTo(h.c,h.t);
}
function bladeHide(){$('#bladeLn').hidden=true;dragTip(null,null)}
function bladeCut(h){
  if(!bladeOk(h)){toast('Too close to the edge of the clip to cut there',{kind:'warn'});return}
  SK.on=false;SK.tok++;
  const d=splitClip(h.c,h.t,{quiet:true});
  if(d){if(V.mode!=='seq'){V.mode='seq';syncModeButtons()}seqSeek(h.seqT)}
}
/* Skimming: while the blade hovers, the viewer shows the frame under the pointer; the playhead stays put. */
const SK={on:false,mode:null,clip:null,t:0,tok:0};
function skimTo(c,t){
  if(!P.skim||V.playing||!canPlay(c))return;
  if(!SK.on){SK.on=true;SK.mode=V.mode;SK.clip=V.clip;SK.t=V.mode==='clip'?clipNow():V.seqT}
  const tok=++SK.tok,d=D[0];
  loadDeck(d,c).then(()=>{if(tok!==SK.tok||!SK.on)return;d.muted=true;D[1].classList.remove('on');showDeck(d);frameMsg(null);d.style.opacity='';return scrubDeck(d,t)}).catch(()=>{});
}
function skimEnd(){
  if(!SK.on)return;
  SK.on=false;SK.tok++;
  if(V.mode==='seq')seqSeek(V.seqT);
  else{const c=V.clip;if(c)showClip(c,c===SK.clip?SK.t:null)}
}

/* ---------- fades + volume ---------- */
function toggleFade(c,k){
  if(!ok(c)){toast('Select a clip first',{kind:'warn'});return}
  const v=c[k]>0?0:Math.min(P.fadeLen,(c.out-c.in)/2);
  edit(()=>{c[k]=+v.toFixed(3)});
  toast(v?`${k==='fi'?'Fades in from':'Fades out to'} black over ${+v.toFixed(2)} s`:`${k==='fi'?'Fade in':'Fade out'} removed`,{kind:v?'ok':'info',sub:v?'Change the length in the clip panel.':null});
}
function deckGain(d,g,instant){
  const i=D.indexOf(d),o=AU.outs[i];
  if(AU.ctx&&o){const p=o.gain,now=AU.ctx.currentTime;if(instant){p.cancelScheduledValues(now);p.setValueAtTime(g,now)}else p.setTargetAtTime(g,now,0.012);if(d.volume!==1)d.volume=1}
  else{const v=clamp(g,0,1);if(Math.abs(d.volume-v)>0.004)d.volume=v}
}
/** Apply a clip's fade and volume to a deck at source time t: opacity over black, and gain. */
function fxDeck(d,c,t,instant){
  const a=fxAlpha(c,t),op=a>=0.999?'':a.toFixed(3);
  if(d.style.opacity!==op)d.style.opacity=op;
  deckGain(d,volOf(c)*a,instant);
}
function applyFx(){
  if(S.exporting||SK.on)return;
  if(V.mode==='seq'){
    const d=D.find(x=>x.classList.contains('on'));if(!d)return;
    const s=V.playing?d._seg:segAt(V.seqT);if(!s||!canPlay(s.c))return;
    fxDeck(d,s.c,s.in+clamp(V.seqT-s.start,0,s.len));
  }else{const c=V.clip;if(canPlay(c))fxDeck(D[0],c,clipNow())}
}

/* ---------- thumbnails for parts that start later in the file ---------- */
const thumbQ=[];let thumbing=false;
function grabThumb(c){if(canPlay(c)&&!thumbQ.includes(c)){thumbQ.push(c);pumpThumbs()}}
async function pumpThumbs(){
  if(thumbing)return;thumbing=true;
  while(thumbQ.length){const c=thumbQ.shift();const u=await frameURL(c.url,Math.min(c.in+0.15,c.out),120);if(u){c.thumb=u;changed()}}
  thumbing=false;
}
function frameURL(url,t,h){
  return new Promise(res=>{
    const v=document.createElement('video');v.muted=true;v.preload='auto';v.playsInline=true;
    let fin=false;const done=x=>{if(fin)return;fin=true;clearTimeout(to);v.removeAttribute('src');v.load();res(x)};
    const to=setTimeout(()=>done(null),8000);
    v.onerror=()=>done(null);
    v.onloadedmetadata=()=>{v.currentTime=Math.max(0,Math.min(t,v.duration-0.05))};
    v.onseeked=()=>{try{const w=Math.max(16,Math.min(360,Math.round(h*v.videoWidth/v.videoHeight))),cv=document.createElement('canvas');cv.width=w;cv.height=h;cv.getContext('2d').drawImage(v,0,0,w,h);cv.toBlob(b=>done(b?URL.createObjectURL(b):null),'image/jpeg',.74)}catch{done(null)}};
    v.src=url;
  });
}

/* ---------- save the frame in the viewer as an image ---------- */
function saveFrame(){
  const d=D.find(x=>x.classList.contains('on'));
  if(!d||d.readyState<2||!d.videoWidth){toast('Show a frame in the viewer first',{kind:'warn'});return}
  const cv=document.createElement('canvas');cv.width=d.videoWidth;cv.height=d.videoHeight;cv.getContext('2d').drawImage(d,0,0);
  const c=V.mode==='seq'?segAt(V.seqT)?.c:V.clip,jpg=P.frameFmt==='jpg';
  const name=`${(c?.name||'frame').replace(/\.[^.]+$/,'')} ${tc(d.currentTime,2).replace(/:/g,'-')}.${jpg?'jpg':'png'}`;
  cv.toBlob(b=>{
    if(!b){toast('Couldn’t capture that frame',{kind:'err'});return}
    const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    toast(`Saved ${name}`,{kind:'ok',sub:`${cv.width}×${cv.height} ${jpg?'JPEG':'PNG'} in your Downloads folder`});
  },jpg?'image/jpeg':'image/png',0.92);
}

/* ---------- right-click menu on a clip ---------- */
const ctx=$('#ctxMenu');
function openCtx(e,c,hit){
  const pt=playheadSeqTime(),seg=SEQ.segs.find(s=>s.c===c),m=c.meta||{};
  const phIn=pt!=null&&seg&&pt>seg.start+1e-3&&pt<seg.start+seg.len-1e-3;
  const items=[
    hit?['split','split',`Split here <small>${tc(hit.seqT)}</small>`,!bladeOk(hit)]:null,
    ['splitph','split','Split at the playhead <small>B</small>',!phIn],
    '-',
    ['fi','fadein',c.fi>0?'Remove the fade in':'Fade in from black',false,c.fi>0],
    ['fo','fadeout',c.fo>0?'Remove the fade out':'Fade out to black',false,c.fo>0],
    m.hasAudio!==false?['mute',c.muted?'vol':'mute',c.muted?'Unmute <small>M</small>':'Mute <small>M</small>']:null,
    '-',
    ['dup','copy','Duplicate <small>Ctrl+D</small>'],
    ['reset','reset','Use the whole clip <small>X</small>',c.in===0&&c.out===m.dur],
    ['first','left','Move to the start',idxOf(c)===0],
    ['last','right','Move to the end',idxOf(c)===S.clips.length-1],
    '-',
    ['del','trash','Remove <small>Del</small>',false,false,'danger'],
  ].filter(Boolean);
  if(S.sel!==c.id){S.sel=c.id;changed()}
  ctx.innerHTML=`<div class="mh">${tag(c)} · ${esc(c.name)}</div>`+items.map(it=>it==='-'?'<hr>':`<button role="menuitem" data-c="${it[0]}" class="${it[5]||''}${it[4]?' on':''}"${it[3]?' disabled':''}>${ic(it[1])}${it[2]}</button>`).join('');
  ctx._c=c;ctx._hit=hit;ctx.hidden=false;hideTip();bladeHide();
  const w=ctx.offsetWidth,h=ctx.offsetHeight;
  ctx.style.left=clamp(e.clientX,4,innerWidth-w-4)+'px';ctx.style.top=clamp(e.clientY,4,innerHeight-h-4)+'px';
}
function closeCtx(){if(!ctx.hidden){ctx.hidden=true;ctx._c=null}}
ctx.addEventListener('click',e=>{
  const b=e.target.closest('[data-c]');if(!b||b.disabled)return;
  const c=ctx._c,hit=ctx._hit;closeCtx();if(!c||!S.clips.includes(c))return;
  ({split:()=>splitClip(c,hit.t),splitph:splitAtPlayhead,fi:()=>toggleFade(c,'fi'),fo:()=>toggleFade(c,'fo'),mute:()=>toggleMute(c),
    dup:()=>duplicate(c.id),reset:()=>resetTrim(c),first:()=>moveClipTo(c.id,0),last:()=>moveClipTo(c.id,S.clips.length),del:()=>removeClip(c.id)})[b.dataset.c]?.();
});
document.addEventListener('pointerdown',e=>{if(!ctx.hidden&&!e.target.closest('#ctxMenu'))closeCtx()},true);
addEventListener('blur',closeCtx);addEventListener('resize',closeCtx);

function clearAll(){if(!S.clips.length)return;edit(()=>{S.clips=[];S.sel=null});viewerFollowSel();toast('Timeline cleared',{action:{label:'Undo',fn:undo}})}
const SORTS={
  name:{fn:(a,b)=>collator.compare(a.name,b.name),label:'name A → Z'},
  nameDesc:{fn:(a,b)=>collator.compare(b.name,a.name),label:'name Z → A'},
  date:{fn:(a,b)=>(a.mtime||0)-(b.mtime||0)||collator.compare(a.name,b.name),label:'date, oldest first'},
  dateDesc:{fn:(a,b)=>(b.mtime||0)-(a.mtime||0)||collator.compare(a.name,b.name),label:'date, newest first'},
  len:{fn:(a,b)=>clipLen(a)-clipLen(b),label:'length'},
  rev:{fn:null,label:'reversed'}
};
function sortClips(k){if(S.clips.length<2)return;const s=SORTS[k];edit(()=>{if(s.fn)S.clips.sort(s.fn);else S.clips.reverse()});toast(`Sorted by ${s.label}`,{action:{label:'Undo',fn:undo}})}
function scrollToClip(id){const v=TL.byId.get(id);if(!v)return;if(S.view==='grid'){TL.els.get(id)?.scrollIntoView({block:'nearest'});return}const l=tls.scrollLeft,w=tls.clientWidth;if(v.x<l||v.x+Math.min(v.w,w)>l+w)tls.scrollLeft=Math.max(0,v.x-40)}

/* ============================================================
   VIEWER — two decks for gapless sequence playback
   ============================================================ */
function showDeck(d){D.forEach(x=>x.classList.toggle('on',x===d))}
function hideDecks(){D.forEach(x=>x.classList.remove('on'))}
function loadDeck(d,c){
  if(d._url===c.url&&d.readyState>=1)return Promise.resolve();
  if(d._url===c.url&&d._loading)return d._loading;
  d._spCancel?.();d.pause();d._url=c.url;d.src=c.url;
  d._loading=new Promise((res,rej)=>{
    const okf=()=>{off();d._loading=null;res()},bad=()=>{off();d._loading=null;rej(new Error(MEDIA_ERR[d.error?.code]||'Decode failed'))};
    const off=()=>{d.removeEventListener('loadedmetadata',okf);d.removeEventListener('error',bad)};
    d.addEventListener('loadedmetadata',okf);d.addEventListener('error',bad);
  });
  return d._loading;
}
/** Coalescing seek: rapid scrubs only ever chase the latest position. */
function scrubDeck(d,t){
  d._want=t;if(d._sp)return d._sp;
  // Claim the deck before the first step: a seek to where it already is finishes immediately,
  // and must not leave a settled promise behind that swallows every later scrub.
  let res,to=0;const sp=new Promise(r=>res=r);d._sp=sp;
  const done=()=>{clearTimeout(to);d.removeEventListener('seeked',on);if(d._sp===sp){d._sp=null;d._spCancel=null;d._want=null}res()};
  const step=()=>{const w=d._want;d._want=null;if(w==null){done();return}if(Math.abs(d.currentTime-w)<1e-4&&!d.seeking){done();return}clearTimeout(to);to=setTimeout(()=>{if(d._want!=null)step();else done()},4000);d.currentTime=w};
  const on=()=>{if(d._want!=null)step();else done();scheduleUI()};
  d._spCancel=done;d.addEventListener('seeked',on);step();
  return sp;
}
function seekExact(d,t){
  d._spCancel?.();
  return new Promise(res=>{
    if(Math.abs(d.currentTime-t)<1e-4&&d.readyState>=2&&!d.seeking)return res();
    const h=()=>{clearTimeout(to);d.removeEventListener('seeked',h);res()};const to=setTimeout(h,6000);
    d.addEventListener('seeked',h);d.currentTime=t;
  });
}
async function prime(d,s,t){
  await loadDeck(d,s.c);d.pause();await seekExact(d,t);
  if(d.readyState<2)await new Promise(r=>{const h=()=>{clearTimeout(to);d.removeEventListener('canplay',h);r()};const to=setTimeout(h,3000);d.addEventListener('canplay',h)});
}
function frameMsg(kind,c){
  const m=$('#fmsg');if(!kind){m.hidden=true;return}
  m.hidden=false;
  if(kind==='missing')m.innerHTML=`${ic('link')}<b>File not linked</b><p>Drop <b>${esc(c.name)}</b> anywhere on Stitch to relink it. Trims and order are kept.</p><button class="btn sm" onclick="document.getElementById('fileIn').click()">${ic('open')}Locate file…</button>`;
  else if(kind==='noplay')m.innerHTML=`${ic('warn')}<b>No browser preview</b><p>${esc(c.meta?.vcodec||'This codec')} can’t be decoded in this browser. Trim by timecode in the panel — the FFmpeg script renders it fine.</p>`;
  else if(kind==='skip')m.innerHTML=`${ic('warn')}<b>Not previewable</b><p>${esc(c.name)} can’t play in the browser — sequence preview skips it.</p>`;
  else if(kind==='none'){m.innerHTML=`${ic('film')}<b>No clip selected</b><p>Click a clip on the timeline to preview and trim it — or press <kbd>S</kbd> to play the whole cut.</p>`;m.querySelector('.ic').style.color='var(--dim)'}
  else if(kind==='err')m.innerHTML=`${ic('warn')}<b>Preview failed</b><p>${esc(c)}</p>`;
}
let showTok=0;
async function showClip(c,t){
  V.clip=c;const tok=++showTok;
  if(!c||!ok(c)){hideDecks();frameMsg(c?null:(S.clips.length?'none':null));scheduleUI();return}
  if(!c.file){hideDecks();frameMsg('missing',c);scheduleUI();return}
  if(!c.playable){hideDecks();frameMsg('noplay',c);scheduleUI();return}
  frameMsg(null);const d=D[0];
  try{
    await loadDeck(d,c);if(tok!==showTok)return;
    d.muted=!V.vol||c.muted;showDeck(d);
    const cur=d.currentTime,keep=t==null&&cur>=0&&d._lastClip===c.id;
    d._lastClip=c.id;
    await scrubDeck(d,clamp(t??(keep?cur:c.in),0,c.meta.dur));
  }catch(e){if(tok===showTok){hideDecks();frameMsg('err',e.message)}}
  scheduleUI();
}
function previewAt(c,t){
  if(!canPlay(c)){showClip(c);return}
  if(V.clip!==c||D[0]._url!==c.url){showClip(c,t);return}
  showDeck(D[0]);scrubDeck(D[0],t);scheduleUI();
}
function clipNow(){if(SK.on&&SK.mode==='clip')return SK.t;const c=V.clip,d=D[0];if(!canPlay(c)||d._url!==c.url)return c?c.in:0;return d._want??d.currentTime}
function playheadSeqTime(){
  if(V.mode==='seq')return V.seqT;
  const c=V.clip;if(!ok(c))return null;
  const s=SEQ.segs.find(s=>s.c===c);if(!s)return null;
  const t=clipNow();if(t<c.in-1e-3||t>c.out+1e-3)return null;
  return s.start+clamp(t-c.in,0,s.len);
}

/* --- sequence engine (shared by preview + export) --- */
function runSequence(segs,t0,H){
  const ctl={stopped:false,held:false,cur:null,live:false};let wake=null;
  ctl.stop=()=>{ctl.stopped=true;D.forEach(d=>d.pause());wake?.()};
  ctl.hold=()=>{ctl.held=true;ctl.cur?.pause()};
  ctl.release=()=>{ctl.held=false;if(ctl.cur&&ctl.live)ctl.cur.play().catch(()=>{})};
  const untilOut=(d,s)=>new Promise(res=>{
    const end=s.out-0.5/fpsOf(s.c);let done=false,iv=0;
    const fin=()=>{if(done)return;done=true;clearInterval(iv);d.removeEventListener('ended',fin);wake=null;res()};
    wake=fin;if(d.currentTime>=end){fin();return}
    if('requestVideoFrameCallback'in d){
      const cb=(now,meta)=>{if(done)return;if(meta.mediaTime>=end){fin();return}H.frame?.(d,meta);H.time?.(s.start+meta.mediaTime-s.in);d.requestVideoFrameCallback(cb)};
      d.requestVideoFrameCallback(cb);
      iv=setInterval(()=>{if(ctl.stopped||d.ended||d.currentTime>=s.out+0.25)fin()},100);
    }else{
      iv=setInterval(()=>{if(ctl.stopped||d.ended||d.currentTime>=end){fin();return}H.frame?.(d);H.time?.(s.start+d.currentTime-s.in)},1000/60);
    }
    d.addEventListener('ended',fin);
  });
  ctl.done=(async()=>{
    let i=segs.findIndex(s=>t0<s.start+s.len-1e-4);if(i<0)return'end';
    let a=D[0],b=D[1];
    H.prepare?.(a,segs[i]);await prime(a,segs[i],segs[i].in+Math.max(0,t0-segs[i].start));
    while(!ctl.stopped){
      const s=segs[i];ctl.cur=a;H.show?.(a,s,i);
      let nextP=null,nextReady=false;
      if(i+1<segs.length){H.prepare?.(b,segs[i+1]);nextP=prime(b,segs[i+1],segs[i+1].in).then(()=>{nextReady=true;return null},e=>{nextReady=true;return e})}
      ctl.live=true;
      if(!ctl.held){try{await a.play()}catch(e){if(!ctl.stopped)throw new Error('Playback was blocked ('+e.message+')')}}
      await untilOut(a,s);ctl.live=false;a.pause();
      if(ctl.stopped)return'stopped';
      i++;if(i>=segs.length)return'end';
      const stalled=!nextReady;if(stalled)H.stall?.(true);
      const err=await nextP;if(stalled)H.stall?.(false);
      if(err)throw new Error(`${segs[i].c.name}: ${err.message}`);
      [a,b]=[b,a];
    }
    return'stopped';
  })();
  return ctl;
}
function playSegs(){return SEQ.segs.filter(s=>s.len>0.01&&canPlay(s.c))}
function seqPlay(){
  const segs=playSegs();if(!segs.length){toast('Nothing previewable on the timeline',{kind:'warn'});return}
  const skipped=SEQ.segs.length-segs.length;
  if(skipped)toast(`Preview skips ${skipped} clip${skipped>1?'s':''} the browser can’t play`,{kind:'warn'});
  let t=V.seqT;if(t>=SEQ.total-0.02)t=0;
  audioForPreview();frameMsg(null);V.playing=true;
  const ctl=runSequence(segs,t,{
    prepare:(d,s)=>{d.muted=!V.vol||s.c.muted;d._seg=s;fxDeck(d,s.c,s.in,true)},
    show:(d,s)=>{fxDeck(d,s.c,d.currentTime,true);showDeck(d);V.seqClip=s.c;scheduleUI()},
    time:t=>{V.seqT=t;scheduleUI()}
  });
  V.seq=ctl;syncTransport();
  ctl.done.then(r=>{if(V.seq!==ctl)return;V.seq=null;V.playing=false;if(r==='end')V.seqT=SEQ.total;scheduleUI();syncTransport()})
    .catch(e=>{if(V.seq!==ctl)return;V.seq=null;V.playing=false;syncTransport();toast('Preview stopped',{kind:'err',sub:e.message})});
}
let seekTok=0;
async function seqSeek(t){
  if(V.seq||V.playing)stopPlayback();
  t=clamp(t,0,SEQ.total);V.seqT=t;scheduleUI();
  const s=segAt(t);if(!s){hideDecks();return}
  const tok=++seekTok;V.seqClip=s.c;
  if(!canPlay(s.c)){hideDecks();frameMsg(s.c.file?'skip':'missing',s.c);return}
  frameMsg(null);const d=D[0];
  try{await loadDeck(d,s.c);if(tok!==seekTok)return;d.muted=!V.vol||s.c.muted;showDeck(d);d._lastClip=s.c.id;await scrubDeck(d,s.in+Math.min(t-s.start,Math.max(0,s.len-1/fpsOf(s.c))))}catch{}
}
/* --- clip mode playback --- */
let clipRaf=0;
function clipPlay(fromIn){
  const c=V.clip,d=D[0];if(!canPlay(c)||d._url!==c.url)return;
  audioForPreview();
  const fps=fpsOf(c),eps=0.5/fps;let t=clipNow();
  if(fromIn||Math.abs(t-c.out)<1.5/fps||t>=c.meta.dur-eps){t=c.in;d.currentTime=t}
  V.stopAt=t<c.out-eps?c.out:c.meta.dur;
  d.muted=!V.vol||c.muted;
  d.play().then(()=>{V.playing=true;syncTransport();cancelAnimationFrame(clipRaf);clipLoop()}).catch(e=>toast('Playback blocked',{kind:'err',sub:e.message}));
}
function clipLoop(){
  clipRaf=requestAnimationFrame(clipLoop);
  const c=V.clip,d=D[0];
  if(!V.playing||V.mode!=='clip'){cancelAnimationFrame(clipRaf);return}
  if(d.currentTime>=V.stopAt-0.5/fpsOf(c)||d.paused){d.pause();V.playing=false;cancelAnimationFrame(clipRaf);syncTransport()}
  scheduleUI();
}
function stopPlayback(){
  if(V.seq){const s=V.seq;V.seq=null;s.stop()}
  cancelAnimationFrame(clipRaf);
  if(!S.exporting)D.forEach(d=>d.pause());
  if(V.playing){V.playing=false;syncTransport()}
}
function togglePlay(){
  if(S.exporting)return;
  if(V.playing){stopPlayback();return}
  if(V.mode==='seq')seqPlay();else clipPlay();
}
function setMode(m){
  if(S.exporting||V.mode===m)return;
  const pos=playheadSeqTime();stopPlayback();V.mode=m;syncModeButtons();
  if(m==='seq')seqSeek(pos??V.seqT);
  else{const c=pool.get(S.sel)||(segAt(V.seqT)?.c);if(c&&c.id!==S.sel){S.sel=c.id;changed()}
    const s=SEQ.segs.find(s=>s.c===c);const t=s&&V.seqT>=s.start&&V.seqT<s.start+s.len?s.in+(V.seqT-s.start):null;showClip(c||null,t)}
  scheduleUI();
}
function step(dir,big){
  if(S.exporting)return;stopPlayback();
  if(V.mode==='clip'){const c=V.clip;if(!canPlay(c))return;const fps=fpsOf(c);const t=clamp(clipNow()+(big?dir:dir/fps),0,Math.max(0,c.meta.dur-1/fps));scrubDeck(D[0],Math.round(t*fps)/fps);scheduleUI()}
  else{const s=segAt(V.seqT);seqSeek(V.seqT+(big?dir:dir/fpsOf(s?.c)))}
}
function goEdge(end){
  if(S.exporting)return;stopPlayback();
  if(V.mode==='clip'){const c=V.clip;if(!canPlay(c))return;scrubDeck(D[0],end?Math.max(c.in,c.out-1/fpsOf(c)):c.in);scheduleUI()}
  else seqSeek(end?SEQ.total:0);
}
function markTarget(){
  if(V.mode==='clip'){const c=V.clip;if(!ok(c)||!canPlay(c))return null;return{c,t:clipNow()}}
  const s=segAt(V.seqT);if(!s)return null;return{c:s.c,t:s.in+(V.seqT-s.start),s};
}
function mark(which){
  const m=markTarget();
  if(!m){toast(V.mode==='clip'?'Select a previewable clip first':'Nothing under the playhead',{kind:'warn'});return}
  const {c}=m,fps=fpsOf(c),minL=Math.max(1/fps,MIN_LEN),t=Math.round(m.t*fps)/fps;
  if(which==='in'){if(t>=c.out-minL+1e-6){toast('In point must be before the out point',{kind:'warn'});return}edit(()=>{c.in=clamp(t,0,c.out-minL)});if(m.s)V.seqT=m.s.start}
  else{const o=Math.min(c.meta.dur,t+1/fps);if(o<=c.in+minL-1e-6){toast('Out point must be after the in point',{kind:'warn'});return}edit(()=>{c.out=clamp(o,c.in+minL,c.meta.dur)})}
  scheduleUI();
}
function resetTrim(c){if(!ok(c))return;if(c.in===0&&c.out===c.meta.dur)return;edit(()=>{c.in=0;c.out=c.meta.dur})}
function toggleMute(c){if(!ok(c))return;edit(()=>{c.muted=!c.muted});if(V.clip===c)D[0].muted=!V.vol||c.muted}
function toggleVol(){V.vol=!V.vol;const c=V.mode==='clip'?V.clip:V.seqClip;D.forEach(d=>{if(!S.exporting)d.muted=!V.vol||(c?.muted??false)});syncTransport();toast(V.vol?'Preview sound on':'Preview sound off')}

/* --- viewer UI --- */
function layoutFrame(){
  const has=S.clips.length>0;frame.hidden=!has;$('#empty').hidden=has;
  if(!has){renderRestore();return}
  const T=target(),sw=stage.clientWidth-32,sh=stage.clientHeight-32,ar=T.w/T.h;
  let fw=sw,fh=fw/ar;if(fh>sh){fh=sh;fw=fh*ar}
  frame.style.width=Math.max(10,Math.floor(fw))+'px';frame.style.height=Math.max(10,Math.floor(fh))+'px';frame.dataset.fit=T.fit;
}
new ResizeObserver(()=>{layoutFrame()}).observe(stage);
new ResizeObserver(()=>{if(!TL.freeze)renderTimeline()}).observe(tls);
function viewerSync(){
  if(S.exporting)return;
  if(V.mode==='clip'){
    const c=pool.get(S.sel)||null;
    if(c!==V.clip||(c&&ok(c)&&c.playable&&D[0]._url!==c.url)||(c&&!ok(c)))showClip(c);
    else if(c&&ok(c)&&!c.playable)showClip(c);
  }else if(!V.playing){
    V.seqT=clamp(V.seqT,0,SEQ.total);
    const s=segAt(V.seqT);if(s&&!canPlay(s.c)){hideDecks();frameMsg(s.c.file?'skip':'missing',s.c)}
  }
}
let uq=false;function scheduleUI(){if(!uq){uq=true;requestAnimationFrame(()=>{uq=false;updateViewerUI()})}}
let cutsKey='';
function updateViewerUI(){
  const seq=V.mode==='seq',c=V.clip;
  let now=0,dur=0;
  if(seq){now=V.seqT;dur=SEQ.total}else if(ok(c)){now=clipNow();dur=c.meta.dur}
  const H=dur>=3600;
  $('#tcNow').textContent=tc(now,2,H);$('#tcDur').textContent='/ '+tc(dur,2,H);
  const pct=x=>dur?clamp(x/dur*100,0,100)+'%':'0%';
  $('#sbHead').style.left=pct(now);$('#sbPlay').style.width=pct(now);
  const showRange=!seq&&ok(c);
  $('#sbRange').hidden=$('#sbIn').hidden=$('#sbOut').hidden=!showRange;
  if(showRange){$('#sbRange').style.left=pct(c.in);$('#sbRange').style.width=dur?((c.out-c.in)/dur*100)+'%':'0';$('#sbIn').style.left=pct(c.in);$('#sbOut').style.left=pct(c.out)}
  const key=seq?SEQ.segs.map(s=>s.len.toFixed(3)).join():'';
  if(key!==cutsKey){cutsKey=key;$('#sbCuts').innerHTML=seq?SEQ.segs.slice(1).map(s=>`<div class="sb-cut" style="left:${s.start/SEQ.total*100}%"></div>`).join(''):''}
  const info=$('#tpInfo');
  if(!seq&&ok(c))info.innerHTML=`<span><em>IN</em><span class="hv">${tc(c.in)}</span></span><span><em>OUT</em><span class="hv">${tc(c.out)}</span></span><span><em>LEN</em>${tc(c.out-c.in)}</span>`;
  else if(seq&&SEQ.segs.length){const s=segAt(V.seqT);info.innerHTML=s?`<span><em>CLIP</em>${tag(s.c)} / ${pad2(SEQ.segs.length)}</span>`:''}
  else info.innerHTML='';
  const b=$('#fbadge');
  if(S.exporting){b.className='fbadge rec';b.innerHTML=`<i>EXPORTING</i>${esc(S.exporting.label||'')}`}
  else if(seq){const s=segAt(V.seqT);b.className='fbadge';b.innerHTML=`<i>SEQUENCE</i>${s?tag(s.c)+' · '+esc(s.c.name):''}`}
  else{b.className='fbadge';b.innerHTML=ok(c)?`<i>CLIP ${tag(c)}</i>${esc(c.name)}`:'<i>CLIP</i>none selected'}
  placePlayhead();drawRuler();followPlayhead();applyFx();
}
function syncModeButtons(){$$('#vMode button').forEach(b=>b.classList.toggle('on',b.dataset.m===V.mode))}
function syncTransport(){
  $('#tPlay').innerHTML=ic(V.playing?'pause':'play');
  $('#tVol').innerHTML=ic(V.vol?'vol':'mute');$('#tVol').classList.toggle('on',!V.vol);
  syncModeButtons();
  const c=V.clip,can=V.mode==='seq'?SEQ.segs.length>0:canPlay(c);
  for(const id of['#tPlay','#tBack','#tFwd','#tStart','#tEnd'])$(id).disabled=!can;
  $('#tIn').disabled=$('#tOut').disabled=!(V.mode==='seq'?SEQ.segs.length:canPlay(c));
}
/* scrub bar */
$('#scrub').addEventListener('pointerdown',e=>{
  if(e.button!==0||S.exporting)return;
  const r=$('#scrub').getBoundingClientRect(),seq=V.mode==='seq',c=V.clip;
  const dur=seq?SEQ.total:(ok(c)?c.meta.dur:0);if(!dur)return;
  e.preventDefault();
  const tAt=ev=>clamp((ev.clientX-r.left)/r.width,0,1)*dur;
  const handle=e.target.closest('.sb-h');
  if(handle&&!seq&&ok(c)){
    pushHist();stopPlayback();const which=handle.id==='sbIn'?'in':'out',in0=c.in,out0=c.out,fps=fpsOf(c),minL=Math.max(1/fps,MIN_LEN);
    document.body.classList.add('trimming');
    winDrag(ev=>{const t=Math.round(tAt(ev)*fps)/fps;if(which==='in'){c.in=clamp(t,0,c.out-minL);previewAt(c,c.in)}else{c.out=clamp(t,c.in+minL,c.meta.dur);previewAt(c,Math.max(c.in,c.out-1/fps))}dragTip(ev,`${which.toUpperCase()} ${tc(which==='in'?c.in:c.out)}`);renderTimeline();renderInspector();scheduleUI()},
      ()=>{document.body.classList.remove('trimming');dragTip(null,null);if(c.in===in0&&c.out===out0)hist.u.pop();changed()});
    return;
  }
  stopPlayback();
  const go=ev=>{const t=tAt(ev);if(seq)seqSeek(t);else if(canPlay(c)){showDeck(D[0]);scrubDeck(D[0],t);scheduleUI()}};
  go(e);winDrag(go,()=>{});
});

/* ============================================================
   INSPECTOR
   ============================================================ */
let inspKey='';
function renderInspector(){
  const box=$('#insp'),c=pool.get(S.sel);
  const key=c?`c${c.id}|${c.state}|${c.playable}|${!!c.file}|${!!c.meta}`:'p';
  if(key!==inspKey){inspKey=key;box.innerHTML=c?inspClipHTML(c):inspProjectHTML()}
  if(c)fillClip(c);else fillProject();
}
function inspClipHTML(c){
  const m=c.meta||{};
  const warn=!ok(c)?'':!c.file?`<div class="callout bad">${ic('link')}<div>File not linked. Drop <b>${esc(c.name)}</b> onto Stitch to relink — or keep going: the FFmpeg script only needs the name.<br><button class="btn sm" data-a="relink">${ic('open')}Locate file…</button></div></div>`
    :!c.playable?`<div class="callout">${ic('warn')}<div>No browser preview — ${esc(c.why||'codec not supported here')}. Trim by timecode; render with the FFmpeg script.</div></div>`:'';
  const codec=[m.vcodec,m.hasAudio===false?'no audio':m.acodec?`${m.acodec}${m.asr?' '+(m.asr/1000).toFixed(m.asr%1000?1:0)+' kHz':''}${m.ach?' · '+(m.ach===1?'mono':m.ach===2?'stereo':m.ach+'ch'):''}`:null].filter(Boolean).join(' · ')||'—';
  return `<div class="sec-h"><h2>Clip <span class="mono hv" data-f="idx"></span></h2><div class="r">
    <button class="btn sm io flat" data-a="dup" data-tip="Duplicate clip" data-key="Ctrl+D">${ic('copy')}</button>
    <button class="btn sm io flat danger" data-a="del" data-tip="Remove clip" data-key="Del">${ic('trash')}</button></div></div>
  <div class="fname">${esc(c.name)}</div>${warn}
  ${c.state==='probing'?'<p class="note">Reading file…</p>':`
  <dl class="kv">
    <dt>Source</dt><dd>${m.w}×${m.h} · ${fpsLabel(m.fps)}${m.rot?` · rotated ${m.rot}°`:''}</dd>
    <dt>Codec</dt><dd>${esc(codec)}</dd>
    <dt>Length</dt><dd>${tc(m.dur)}</dd>
    <dt>File</dt><dd>${c.size?fmtBytes(c.size):'—'}${c.mtime?' · '+new Date(c.mtime).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):''}</dd>
  </dl>
  <div class="sub">Trim</div>
  <div class="g2">
    <div class="fld"><label for="iIn">In</label><div class="trimrow"><input class="inp" id="iIn" data-f="in" spellcheck="false"><button class="btn io" data-a="setIn" data-tip="Set in at playhead" data-key="I">${ic('in')}</button></div></div>
    <div class="fld"><label for="iOut">Out</label><div class="trimrow"><input class="inp" id="iOut" data-f="out" spellcheck="false"><button class="btn io" data-a="setOut" data-tip="Set out at playhead" data-key="O">${ic('out')}</button></div></div>
  </div>
  <div class="tbar"><i data-f="bar"></i></div>
  <div class="lenrow">On timeline <b data-f="len"></b><button class="btn sm" data-a="split" data-tip="Split at the playhead" data-key="B">${ic('split')}Split</button><button class="btn sm" data-a="reset" data-tip="Use the whole clip" data-key="X">${ic('reset')}Reset</button></div>
  <div class="sub">Fades</div>
  <div class="g2">
    <div class="fld"><label for="iFi">Fade in · seconds</label><div class="trimrow"><input class="inp" id="iFi" data-f="fi" placeholder="off" spellcheck="false"><button class="btn io fadebtn" data-a="fi" data-tip="Fade in from black">${ic('fadein')}</button></div></div>
    <div class="fld"><label for="iFo">Fade out · seconds</label><div class="trimrow"><input class="inp" id="iFo" data-f="fo" placeholder="off" spellcheck="false"><button class="btn io fadebtn" data-a="fo" data-tip="Fade out to black">${ic('fadeout')}</button></div></div>
  </div>
  <p class="note" style="margin-top:6px">Picture and sound fade together. Used by the export and the FFmpeg re-encode.</p>
  <div class="sub">Audio</div>
  ${m.hasAudio===false?'<p class="note">This clip has no audio track — silence is filled in on export.</p>':`<div class="volrow"><input type="range" min="0" max="200" step="5" data-f="vol" aria-label="Clip volume" data-tip="Clip volume (double-click for 100%)"><b data-f="volv"></b></div>
  <label class="swrow"><span>Mute this clip</span><input type="checkbox" class="sw" data-a="mute" data-f="mute"></label>`}
  <div class="sub">Order</div>
  <div class="posrow"><button class="btn sm" data-a="left" data-tip="Move earlier" data-key="Alt+←">${ic('left')}Earlier</button><button class="btn sm" data-a="right" data-tip="Move later" data-key="Alt+→">Later${ic('right')}</button><span data-f="pos"></span></div>`}`;
}
function fillClip(c){
  const box=$('#insp'),f=k=>box.querySelector(`[data-f="${k}"]`);
  f('idx')&&(f('idx').textContent=tag(c));
  if(!ok(c))return;
  for(const k of['in','out']){const el=f(k);if(el&&document.activeElement!==el){el.value=tc(c[k]);el.classList.remove('bad')}}
  const bar=f('bar');if(bar){bar.style.left=(c.in/c.meta.dur*100)+'%';bar.style.width=((c.out-c.in)/c.meta.dur*100)+'%'}
  f('len')&&(f('len').textContent=tc(c.out-c.in));
  f('mute')&&(f('mute').checked=c.muted);
  for(const k of['fi','fo']){const el=f(k);if(el&&document.activeElement!==el){el.value=c[k]>0?String(+(+c[k]).toFixed(2)):'';el.classList.remove('bad')}box.querySelector(`[data-a="${k}"]`)?.classList.toggle('on',c[k]>0)}
  const vol=f('vol');if(vol){if(volFrom==null)vol.value=Math.round(volOf(c)*100);vol.disabled=c.muted;f('volv').textContent=c.muted?'muted':Math.round(volOf(c)*100)+'%'}
  f('pos')&&(f('pos').textContent=`${tag(c)} of ${pad2(S.clips.length)}`);
  box.querySelectorAll('[data-a="setIn"],[data-a="setOut"]').forEach(b=>b.disabled=!canPlay(c));
  const sp=box.querySelector('[data-a="split"]');if(sp){const pt=playheadSeqTime(),s=SEQ.segs.find(x=>x.c===c);sp.disabled=!(pt!=null&&s&&pt>s.start+1e-3&&pt<s.start+s.len-1e-3)}
}
function inspProjectHTML(){
  return `<div class="sec-h"><h2>Project</h2></div>
  <div class="stats"><div class="stat"><span>Clips</span><b data-f="n"></b></div><div class="stat"><span>Runtime</span><b data-f="rt"></b></div><div class="stat"><span>Source size</span><b data-f="sz"></b></div><div class="stat"><span>Trimmed out</span><b data-f="cut"></b></div></div>
  <div class="sub">Sources</div><div class="chips" data-f="res"></div>
  <div class="sub">Lossless stitch</div><div data-f="ll"></div>
  <div class="sub">Quick keys</div>
  <div class="tips"><span><kbd>Space</kbd></span><span>Play / pause</span><span><kbd>I</kbd><kbd>O</kbd></span><span>Mark in / out at the playhead</span><span><kbd>B</kbd></span><span>Split at the playhead</span><span><kbd>Shift</kbd><kbd>B</kbd></span><span>Blade tool: click to cut</span><span><kbd>←</kbd><kbd>→</kbd></span><span>Step a frame (Shift = 1 s)</span><span><kbd>S</kbd><kbd>C</kbd></span><span>Sequence / clip viewer</span><span><kbd>?</kbd></span><span>Everything else</span></div>`;
}
function fillProject(){
  const box=$('#insp'),f=k=>box.querySelector(`[data-f="${k}"]`);if(!f('n'))return;
  const list=S.clips.filter(ok);
  f('n').textContent=S.clips.length;f('rt').textContent=tc(SEQ.total,1);
  f('sz').textContent=fmtBytes(list.reduce((a,c)=>a+(c.size||0),0));
  f('cut').textContent=tc(list.reduce((a,c)=>a+c.meta.dur-(c.out-c.in),0),1);
  const g={};for(const c of list){const k=`${c.meta.w}×${c.meta.h} ${c.meta.vcodec||''}`.trim();g[k]=(g[k]||0)+1}
  f('res').innerHTML=Object.entries(g).map(([k,n])=>`<span class="chip">${esc(k)}${n>1?' ×'+n:''}</span>`).join('')||'<span class="note">No clips yet</span>';
  const R=losslessReport(list);
  f('ll').innerHTML=list.length?`<div class="callout ${R.lvl==='ok'?'ok':R.lvl==='bad'?'bad':''}">${ic(R.lvl==='ok'?'check':'warn')}<div><b>${esc(R.headline)}</b>${R.lvl!=='ok'?`<br>${esc(R.items.find(i=>i.lvl===R.lvl)?.msg||'')}`:''}<br><button class="btn sm" data-a="ff">${ic('term')}Open FFmpeg script</button></div></div>`:'<p class="note">Add clips to check compatibility.</p>';
}
$('#insp').addEventListener('click',e=>{
  const b=e.target.closest('[data-a]');if(!b||S.exporting)return;const c=pool.get(S.sel);const a=b.dataset.a;
  if(a==='ff')return openFF();
  if(!c)return;
  ({split:splitAtPlayhead,fi:()=>toggleFade(c,'fi'),fo:()=>toggleFade(c,'fo'),dup:()=>duplicate(c.id),del:()=>removeClip(c.id),setIn:()=>{if(V.mode!=='clip')setMode('clip');mark('in')},setOut:()=>{if(V.mode!=='clip')setMode('clip');mark('out')},
    reset:()=>resetTrim(c),left:()=>nudge(c.id,-1),right:()=>nudge(c.id,1),relink:()=>$('#fileIn').click()})[a]?.();
});
$('#insp').addEventListener('change',e=>{
  const c=pool.get(S.sel);if(!ok(c))return;
  if(e.target.dataset.a==='mute'){toggleMute(c);return}
  const k=e.target.dataset.f;
  if(k==='vol'){const nv=+e.target.value/100;if(volFrom!=null){c.vol=volFrom;volFrom=null}if(nv!==volOf(c))edit(()=>{c.vol=nv});return}
  if(k==='fi'||k==='fo'){
    const raw=e.target.value.trim(),v=raw===''||/^off$/i.test(raw)?0:parseTC(raw);
    if(isNaN(v)||v<0){e.target.classList.add('bad');toast('Fade length is in seconds, e.g. 0.5 or 2',{kind:'warn'});return}
    const nv=+Math.min(v,c.out-c.in).toFixed(3);if(nv!==(c[k]||0))edit(()=>{c[k]=nv});e.target.blur();return;
  }
  if(k!=='in'&&k!=='out')return;
  const v=parseTC(e.target.value);
  if(isNaN(v)){e.target.classList.add('bad');toast('Use seconds or m:ss.ff — e.g. 83.5 or 1:23.50',{kind:'warn'});return}
  const fps=fpsOf(c),minL=Math.max(1/fps,MIN_LEN);
  if(k==='in'){if(v>=c.out-minL+1e-6){e.target.classList.add('bad');toast('In point must be before the out point',{kind:'warn'});return}edit(()=>{c.in=clamp(v,0,c.out-minL)});previewAt(c,c.in)}
  else{if(v<=c.in+minL-1e-6){e.target.classList.add('bad');toast('Out point must be after the in point',{kind:'warn'});return}edit(()=>{c.out=clamp(v,c.in+minL,c.meta.dur)});previewAt(c,Math.max(c.in,c.out-1/fps))}
  e.target.blur();
});
let volFrom=null;
$('#insp').addEventListener('input',e=>{
  if(e.target.dataset.f!=='vol')return;const c=pool.get(S.sel);if(!ok(c))return;
  if(volFrom==null)volFrom=volOf(c);c.vol=+e.target.value/100;
  $('#insp [data-f="volv"]').textContent=Math.round(c.vol*100)+'%';if(c.vol>1)audioForPreview();applyFx();
});
$('#insp').addEventListener('dblclick',e=>{if(e.target.dataset.f!=='vol')return;const c=pool.get(S.sel);if(ok(c)&&volOf(c)!==1)edit(()=>{c.vol=1})});
$('#insp').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('.inp'))e.target.dispatchEvent(new Event('change',{bubbles:true}));if(e.key==='Escape'&&e.target.matches('.inp')){e.target.blur();renderInspector()}});

/* ============================================================
   OUTPUT SETTINGS
   ============================================================ */
const FORMATS=[
  ['video/mp4;codecs=avc1.640028,mp4a.40.2','MP4 · H.264 + AAC'],
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','MP4 · H.264 + AAC'],
  ['video/mp4;codecs=avc1,opus','MP4 · H.264 + Opus'],
  ['video/webm;codecs=vp9,opus','WebM · VP9 + Opus'],
  ['video/webm;codecs=vp8,opus','WebM · VP8 + Opus'],
  ['video/webm;codecs=av01,opus','WebM · AV1 + Opus'],
  ['video/mp4','MP4 · browser default'],
  ['video/webm','WebM · browser default']
];
(function initFormats(){
  const sel=$('#oFmt'),seen=new Set();
  const okf=FORMATS.filter(([m,l])=>{if(!window.MediaRecorder||!MediaRecorder.isTypeSupported(m)||seen.has(l))return false;seen.add(l);return true});
  if(!okf.length){sel.innerHTML='<option value="">Not supported in this browser</option>';sel.disabled=true;return}
  sel.innerHTML=okf.map(([m,l])=>`<option value="${m}">${l}</option>`).join('');
})();
const OUT_KEYS=['oRes','oW','oH','oFps','oFit','oName','oAudio','oFmt','oRate','oMon'];
function saveOut(){const o={};for(const k of OUT_KEYS){const el=$('#'+k);o[k]=el.type==='checkbox'?el.checked:el.value}LS.set('stitch.out',o)}
function loadOut(o){if(!o)return;for(const k of OUT_KEYS){const el=$('#'+k);if(!(k in o))continue;if(el.type==='checkbox')el.checked=!!o[k];else if(el.tagName!=='SELECT'||[...el.options].some(x=>x.value===String(o[k])))el.value=o[k]}$('#customRes').hidden=$('#oRes').value!=='custom'}
function firstMeta(){return S.clips.find(ok)?.meta}
function target(){
  const r=$('#oRes').value,m=firstMeta();let w,h;
  if(r==='auto'){w=m?.w||1920;h=m?.h||1080}else if(r==='custom'){w=+$('#oW').value||1920;h=+$('#oH').value||1080}else[w,h]=r.split('x').map(Number);
  w=clamp(Math.round(w/2)*2,16,7680);h=clamp(Math.round(h/2)*2,16,7680);
  const fv=$('#oFps').value,fps=fv==='auto'?(fpsNorm(m?.fps)||30):+fv;
  return{w,h,fps,fit:$('#oFit').value};
}
function bitrate(T){const v=$('#oRate').value;return v==='auto'?Math.round(clamp(T.w*T.h*T.fps*0.2,4e6,60e6)/5e5)*5e5:+v*1e6}
function outName(){return($('#oName').value.trim()||'stitched').replace(/[\\/:*?"<>|]+/g,'_')}
$('#outSec').addEventListener('change',e=>{
  if(e.target.id==='oRes')$('#customRes').hidden=e.target.value!=='custom';
  saveOut();renderChrome();layoutFrame();if(V.mode==='seq'&&!V.playing)scheduleUI();
});
function exportBlocker(){
  if(!window.MediaRecorder||!$('#oFmt').value)return'This browser can’t record video — use the FFmpeg script.';
  const list=S.clips;if(!list.length)return'Add clips first';
  if(list.some(c=>c.state==='probing'))return'Still reading clips…';
  const miss=list.filter(c=>ok(c)&&!c.file).length;if(miss)return`${miss} clip${miss>1?'s':''} missing — drop the file${miss>1?'s':''} in to relink`;
  const np=list.filter(c=>ok(c)&&!c.playable).length;if(np)return`${np} clip${np>1?'s':''} can’t be decoded here — use the FFmpeg script`;
  if(SEQ.total<0.05)return'Timeline is empty';
  return null;
}
function renderChrome(){
  $('#tyClips').textContent=S.clips.length;const cn=$('#stitchCnt');cn.hidden=!S.clips.length;cn.textContent=S.clips.length;$('#tyDur').textContent=tc(SEQ.total,1);
  const T=target();$('#tyOut').textContent=S.clips.length?`${T.w}×${T.h} · ${fpsNorm(T.fps)}`:'—';
  $('#outSum').textContent=S.clips.length?`${T.w}×${T.h} @ ${fpsNorm(T.fps)}`:'';
  $('#bUndo').disabled=!hist.u.length;$('#bRedo').disabled=!hist.r.length;
  const sc=pool.get(S.sel),has=S.clips.some(ok);
  $('#bSplit').disabled=!has;$('#bBlade').disabled=!has||S.view!=='timeline';if(S.blade&&(!has||S.view!=='timeline'))setBlade(false);
  for(const[id,k]of[['#bFadeIn','fi'],['#bFadeOut','fo']]){const b=$(id);b.disabled=!ok(sc);b.classList.toggle('on',ok(sc)&&sc[k]>0)}
  $('#tShot').disabled=!has;
  $('#bSave').disabled=$('#bClear').disabled=!S.clips.length;
  const why=exportBlocker();
  $('#bExport').disabled=!!why;$('#bFF').disabled=!S.clips.some(ok);
  const est=$('#est');est.classList.toggle('warn',!!why&&S.clips.length>0);
  if(why&&S.clips.length)$('#estTxt').textContent=why;
  else{const a=$('#oAudio').checked?192e3:0;const by=(bitrate(T)+a)*SEQ.total/8;$('#estTxt').textContent=SEQ.total?`≈ ${fmtBytes(by)} · ${tc(SEQ.total,0)}`:'—'}
  syncTransport();
}

/* ============================================================
   BROWSER EXPORT — canvas + MediaRecorder, gapless A/B decks
   ============================================================ */
const AU={ctx:null,outs:[],monitor:null};
function ensureAudio(){
  if(AU.ctx)return AU;
  const ctx=new(window.AudioContext||window.webkitAudioContext)();
  const mon=ctx.createGain();mon.connect(ctx.destination);
  // Each deck is wired exactly once for the life of the page (re-wiring throws).
  AU.outs=D.map(d=>{const s=ctx.createMediaElementSource(d),g=ctx.createGain();s.connect(g);g.connect(mon);return g});
  AU.ctx=ctx;AU.monitor=mon;return AU;
}
function resumeAudio(){if(AU.ctx&&AU.ctx.state!=='running')AU.ctx.resume().catch(()=>{})}
/** Volumes over 100% need the Web Audio graph; route preview through it once any clip is boosted. */
function audioForPreview(){if(!AU.ctx&&S.clips.some(c=>volOf(c)>1)){try{ensureAudio()}catch{}}resumeAudio()}
function fitRect(sw,sh,dw,dh,mode){if(mode==='fill')return{x:0,y:0,w:dw,h:dh};const s=mode==='cover'?Math.max(dw/sw,dh/sh):Math.min(dw/sw,dh/sh);const w=sw*s,h=sh*s;return{x:(dw-w)/2,y:(dh-h)/2,w,h}}
function recHold(X,why,on){
  if(on)X.holds.add(why);else X.holds.delete(why);
  try{if(X.holds.size&&X.rec.state==='recording')X.rec.pause();else if(!X.holds.size&&X.rec.state==='paused')X.rec.resume()}catch{}
}
let lastExportURL=null;
async function exportVideo(){
  const why=exportBlocker();if(why){toast(why,{kind:'err'});return}
  const segs=SEQ.segs.filter(s=>s.len>0.02);
  const T=target(),mime=$('#oFmt').value,audio=$('#oAudio').checked,mon=$('#oMon').checked,vbr=bitrate(T);
  const total=segs.reduce((a,s)=>a+s.len,0);
  stopPlayback();hideTip();
  let A=null;
  if(audio){try{A=ensureAudio();await A.ctx.resume()}catch(e){toast('Audio engine failed to start',{kind:'err',sub:e.message+' — turn off “Include audio” to export picture only.'});return}}
  xcv.width=T.w;xcv.height=T.h;
  const g=xcv.getContext('2d',{alpha:false});g.fillStyle='#000';g.fillRect(0,0,T.w,T.h);
  // Push exactly one captured frame per decoded source frame (captureStream(fps) sampling drops ~5%).
  let vs=xcv.captureStream(0),vtrack=vs.getVideoTracks()[0];
  if(typeof vtrack?.requestFrame!=='function'){vs.getTracks().forEach(t=>t.stop());vs=xcv.captureStream(T.fps);vtrack=null}
  let recDest=null;
  if(A){recDest=A.ctx.createMediaStreamDestination();A.outs.forEach(o=>o.connect(recDest));A.monitor.gain.value=mon?1:0}
  const stream=new MediaStream([...vs.getVideoTracks(),...(recDest?recDest.stream.getAudioTracks():[])]);
  let rec;
  try{rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:vbr,audioBitsPerSecond:192000})}
  catch(e){cleanup();toast('Recorder could not start',{kind:'err',sub:e.message});return}
  const chunks=[];let bytes=0;rec.ondataavailable=e=>{if(e.data?.size){chunks.push(e.data);bytes+=e.data.size}};
  const stopped=new Promise(r=>rec.onstop=r);
  const X={rec,holds:new Set(),cancel:false,ctl:null,t:0,total,label:'',start:performance.now()};
  S.exporting=X;lockUI(true);
  const draw=(d,meta)=>{
    if(d.readyState<2||!d.videoWidth)return;
    g.globalAlpha=1;g.fillStyle='#000';g.fillRect(0,0,T.w,T.h);
    const r=fitRect(d.videoWidth,d.videoHeight,T.w,T.h,T.fit);g.drawImage(d,r.x,r.y,r.w,r.h);
    const s=d._seg;
    if(s){const a=fxAlpha(s.c,meta?.mediaTime??d.currentTime);if(a<0.999){g.fillStyle=`rgba(0,0,0,${(1-a).toFixed(4)})`;g.fillRect(0,0,T.w,T.h)}if(A)deckGain(d,volOf(s.c)*a)}
    vtrack?.requestFrame();
  };
  xcv.classList.add('on');frameMsg(null);V.mode='seq';syncModeButtons();
  let err=null,result=null;
  const prog=setInterval(()=>updateExportUI(X),250);
  try{
    rec.start(1000);
    X.ctl=runSequence(segs,0,{
      prepare:(d,s)=>{d.muted=!audio||s.c.muted;d._seg=s;if(A)deckGain(d,volOf(s.c)*fxAlpha(s.c,s.in),true)},
      show:(d,s,i)=>{showDeck(d);draw(d);X.label=`${pad2(i+1)}/${pad2(segs.length)} · ${s.c.name}`;scheduleUI()},
      frame:(d,meta)=>draw(d,meta),
      time:t=>{X.t=t;V.seqT=t;scheduleUI()},
      stall:on=>recHold(X,'stall',on)
    });
    result=await X.ctl.done;
    await sleep(150);
  }catch(e){err=e}
  clearInterval(prog);
  try{if(rec.state!=='inactive'){rec.stop();await stopped}}catch{}
  cleanup();
  S.exporting=null;lockUI(false);xcv.classList.remove('on');updateExportUI(null);
  if(err){toast('Export failed',{kind:'err',sub:err.message});changed();return}
  if(X.cancel||result!=='end'){toast('Export cancelled');changed();return}
  let blob=new Blob(chunks,{type:mime.split(';')[0]});
  if(mime.startsWith('video/webm'))blob=await fixWebmDuration(blob,total*1000);
  const ext=mime.includes('mp4')?'mp4':'webm',name=`${outName()}.${ext}`;
  if(lastExportURL)URL.revokeObjectURL(lastExportURL);
  lastExportURL=URL.createObjectURL(blob);
  const dl=()=>{const a=document.createElement('a');a.href=lastExportURL;a.download=name;document.body.appendChild(a);a.click();a.remove()};
  dl();
  const secs=(performance.now()-X.start)/1000;
  toast(`Exported ${name}`,{kind:'ok',sub:`${segs.length} clips · ${tc(total,1)} · ${fmtBytes(blob.size)} · took ${tc(secs,0)}`,action:{label:'Save again',fn:dl},ms:15000});
  changed();
  function cleanup(){
    vs.getTracks().forEach(t=>t.stop());
    if(A&&recDest){A.outs.forEach(o=>{try{o.disconnect(recDest)}catch{}});A.monitor.gain.value=1}
  }
}
function updateExportUI(X){
  $('#actions').hidden=!!X;$('#xprog').hidden=!X;
  if(!X)return;
  const p=X.total?clamp(X.t/X.total,0,1):0;
  $('#xBar').style.width=(p*100).toFixed(1)+'%';$('#xPct').textContent=Math.floor(p*100)+'%';
  $('#xL').textContent=X.holds.has('hidden')?'Paused — tab hidden':X.holds.has('stall')?'Buffering next clip…':(X.label||'Starting…');
  $('#xT').textContent=`${tc(X.t,0)} / ${tc(X.total,0)}`;$('#xEta').textContent=`ETA ${tc(Math.max(0,X.total-X.t),0)}`;
}
function lockUI(on){
  document.body.classList.toggle('busy',on);
  $$('.lockable input,.lockable select,.lockable button').forEach(el=>{if(on){el._wasDis=el.disabled;el.disabled=true}else{el.disabled=el._wasDis??false}});
  if(on)updateExportUI(S.exporting);
}
$('#bCancel').onclick=()=>{const X=S.exporting;if(!X)return;X.cancel=true;X.ctl?.stop()};
document.addEventListener('visibilitychange',()=>{
  const X=S.exporting;if(!X)return;
  if(document.hidden){X.ctl?.hold();recHold(X,'hidden',true)}
  else{recHold(X,'hidden',false);X.ctl?.release();toast('Export resumed',{kind:'warn',sub:'Browsers throttle hidden tabs, so Stitch pauses while you’re away. Keep it in front until it finishes.'})}
});
addEventListener('beforeunload',e=>{if(S.exporting){e.preventDefault();e.returnValue=''}});
/** MediaRecorder WebM has no Duration element, so players can't seek it. Patch one into Segment Info. */
async function fixWebmDuration(blob,ms){
  try{
    const N=Math.min(blob.size,256*1024),b=new Uint8Array(await blob.slice(0,N).arrayBuffer());let p=0;
    const vlen=x=>{for(let i=0;i<8;i++)if(x&(0x80>>i))return i+1;return 0};
    const rid=()=>{const l=vlen(b[p]);if(!l||l>4)throw 0;let v=0;for(let i=0;i<l;i++)v=v*256+b[p+i];p+=l;return v};
    const rsz=()=>{const l=vlen(b[p]);if(!l)throw 0;let v=b[p]&(0xFF>>l),ones=v===(0xFF>>l);for(let i=1;i<l;i++){v=v*256+b[p+i];if(b[p+i]!==255)ones=false}const at=p;p+=l;return{v:ones?-1:v,at,l}};
    if(rid()!==0x1A45DFA3)return blob;const eh=rsz();p+=eh.v;
    if(rid()!==0x18538067)return blob;const seg=rsz();
    while(p<N){
      const st=p,id=rid(),sz=rsz(),ds=p;if(sz.v<0)return blob;
      if(id===0x1549A966){
        const de=ds+sz.v;if(de>N)return blob;let scale=1e6,durAt=-1,durLen=0;
        while(p<de){const cid=rid(),cs=rsz(),cds=p;if(cid===0x2AD7B1){scale=0;for(let i=0;i<cs.v;i++)scale=scale*256+b[cds+i]}else if(cid===0x4489){durAt=cds;durLen=cs.v}p=cds+cs.v}
        const val=ms*1e6/(scale||1e6);
        if(durAt>=0){const dv=new DataView(b.buffer);if(durLen===8)dv.setFloat64(durAt,val);else if(durLen===4)dv.setFloat32(durAt,val);else return blob;return new Blob([b,blob.slice(N)],{type:blob.type})}
        const durEl=new Uint8Array(11);durEl.set([0x44,0x89,0x88]);new DataView(durEl.buffer).setFloat64(3,val);
        const newSize=sz.v+11,hdr=new Uint8Array(12);hdr.set([0x15,0x49,0xA9,0x66,0x01]);
        for(let i=11,x=newSize;i>=5;i--){hdr[i]=x&255;x=Math.floor(x/256)}
        const head=b.slice(0,st);
        if(seg.v>=0){let nv=seg.v+11+(hdr.length-(ds-st));for(let i=seg.l-1;i>=0;i--){head[seg.at+i]=nv&255;nv=Math.floor(nv/256)}head[seg.at]|=(0x80>>(seg.l-1))}
        return new Blob([head,hdr,b.subarray(ds,de),durEl,b.subarray(de),blob.slice(N)],{type:blob.type});
      }
      if(id===0x1F43B675)return blob;
      p=ds+sz.v;
    }
  }catch(e){console.warn('WebM duration patch skipped',e)}
  return blob;
}

/* ============================================================
   FFMPEG SCRIPT GENERATOR
   ============================================================ */
const ENC={
  x264:{q:{high:18,bal:21,small:25},a:q=>['-c:v','libx264','-preset','slow','-crf',q,'-pix_fmt','yuv420p']},
  x265:{q:{high:20,bal:23,small:27},a:q=>['-c:v','libx265','-preset','medium','-crf',q,'-pix_fmt','yuv420p','-tag:v','hvc1']},
  nv264:{q:{high:19,bal:23,small:27},a:q=>['-c:v','h264_nvenc','-preset','p6','-tune','hq','-rc','vbr','-cq',q,'-b:v','0','-pix_fmt','yuv420p']},
  nv265:{q:{high:21,bal:25,small:29},a:q=>['-c:v','hevc_nvenc','-preset','p6','-tune','hq','-rc','vbr','-cq',q,'-b:v','0','-pix_fmt','yuv420p','-tag:v','hvc1']}
};
const FF=Object.assign({mode:null,enc:'x264',q:'high',shell:'ps'},LS.get('stitch.ff',{}));
const PS_SAFE=/^[A-Za-z0-9_\-.:+\/=]+$/,SH_SAFE=/^[A-Za-z0-9_\-.:+\/=,@%]+$/;
const psLit=s=>"'"+String(s).replace(/['\u2018\u2019\u201A\u201B]/g,m=>m+m)+"'";   // always quoted (arrays/expressions)
const shLit=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
const psQ=s=>PS_SAFE.test(s)?s:psLit(s);   // command-mode argument
const shQ=s=>SH_SAFE.test(s)?s:shLit(s);
const n3=x=>(+x).toFixed(3);
function losslessReport(list){
  const R={lvl:'ok',items:[],headline:''};
  const add=(lvl,msg)=>{R.items.push({lvl,msg});if(lvl==='bad')R.lvl='bad';else if(lvl==='warn'&&R.lvl==='ok')R.lvl='warn'};
  if(!list.length){R.lvl='bad';R.headline='Nothing on the timeline';return R}
  const nm=arr=>{const t=arr.map(tag);return t.length>3?t.slice(0,3).join(', ')+` +${t.length-3}`:t.join(', ')};
  const diff=(key,fmt,lvl,what)=>{
    const known=list.filter(c=>c.meta[key]!=null&&c.meta[key]!=='');if(known.length<2)return;
    const ref=mode(known.map(c=>fmt(c.meta)));const odd=known.filter(c=>fmt(c.meta)!==ref);
    if(odd.length)add(lvl,`${what} differs — ${nm(odd)} ${odd.length>1?'are':'is'} ${[...new Set(odd.map(c=>fmt(c.meta)))].join(' / ')}; the rest are ${ref}`);
  };
  const unk=list.filter(c=>!c.meta.vcodec);if(unk.length)add('warn',`Codec unknown for ${nm(unk)} — lossless may fail`);
  diff('vcodec',m=>m.vcodec,'bad','Video codec');
  diff('w',m=>`${m.w}×${m.h}`,'bad','Resolution');
  const withA=list.filter(c=>c.meta.hasAudio===true),noA=list.filter(c=>c.meta.hasAudio===false);
  if(withA.length&&noA.length)add('bad',`${nm(noA)} ${noA.length>1?'have':'has'} no audio track — audio would drift out of sync`);
  diff('acodec',m=>m.acodec,'bad','Audio codec');
  diff('asr',m=>(m.asr/1000)+' kHz','warn','Sample rate');
  diff('fps',m=>fpsLabel(m.fps),'warn','Frame rate');
  const conts=[...new Set(list.map(c=>contFamily(c.meta.container)))];if(conts.length>1)add('warn',`Mixed containers (${conts.join(' + ')}) — output will be .mkv`);
  const tr=list.filter(c=>c.in>1e-3||c.out<c.meta.dur-1e-3);if(tr.length)add('warn',`Trims on ${nm(tr)} snap to keyframes in lossless mode — cuts can land up to a few seconds early`);
  const mu=list.filter(c=>c.muted);if(mu.length)add('warn',`Mute is ignored by lossless copy (${nm(mu)}) — use Re-encode`);
  const fx=list.filter(c=>c.fi>0||c.fo>0||volOf(c)!==1);if(fx.length)add('warn',`Fades and volume changes are ignored by lossless copy (${nm(fx)}) — use Re-encode`);
  const m0=list[0].meta;
  if(R.lvl==='ok')add('ok',`All ${list.length} clip${list.length>1?'s':''} match: ${[m0.vcodec,`${m0.w}×${m0.h}`,fpsLabel(m0.fps),m0.acodec||(m0.hasAudio===false?'no audio':null)].filter(Boolean).join(' · ')}`);
  R.headline=R.lvl==='ok'?R.items[0].msg:R.lvl==='bad'?'Clips don’t match — lossless copy will fail or glitch. Re-encode instead.':'Lossless will work, with caveats.';
  return R;
}
const contFamily=c=>c==='mov'||c==='mp4'?'MP4':c==='webm'?'WebM':c==='mkv'?'MKV':(c||'?').toUpperCase();
function losslessExt(list){
  const fam=[...new Set(list.map(c=>contFamily(c.meta.container)))];
  if(fam.length===1&&fam[0]==='MP4')return list[0].meta.container==='mov'?'.mov':'.mp4';
  if(fam.length===1&&fam[0]==='WebM')return'.webm';
  return'.mkv';
}
function buildScript(o){
  const list=S.clips.filter(c=>ok(c)&&c.out-c.in>0.02);
  if(!list.length)return'# Nothing on the timeline.';
  const ps=o.shell==='ps',Q=ps?psQ:shQ,LIT=ps?psLit:shLit,copy=o.mode==='copy';
  const T=target(),audio=$('#oAudio').checked;
  const ext=copy?losslessExt(list):'.mp4',outFile=outName()+(copy?'_lossless':'')+ext;
  const total=list.reduce((a,c)=>a+c.out-c.in,0);
  const L=[],cmt=s=>L.push(s?'# '+s:'#');
  const trimmed=c=>c.in>5e-4||c.out<c.meta.dur-5e-4;
  if(!ps)L.push('#!/usr/bin/env bash');
  cmt(`RipStitch / Stitch - ${copy?'lossless stitch (stream copy, no quality loss)':`re-encode to ${T.w}x${T.h} @ ${fpsNorm(T.fps)} fps`}`);
  cmt(`${list.length} clip${list.length>1?'s':''}, ${tc(total)} total. Generated ${new Date().toISOString().slice(0,16).replace('T',' ')}`);
  if(ps){cmt('Save next to your clips and run:  powershell -ExecutionPolicy Bypass -File .\\'+outName()+'.ps1');cmt('...or paste into a PowerShell window opened in that folder.');L.push('& {','$ErrorActionPreference = \'Stop\'','if ($PSScriptRoot) { Set-Location -LiteralPath $PSScriptRoot }',
    "if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'ffmpeg is not on PATH. Install it (winget install Gyan.FFmpeg) and open a new PowerShell window.' }",'')}
  else{cmt('Save next to your clips and run:  bash '+outName()+'.sh   (or paste into a terminal in that folder)');L.push('(','set -euo pipefail','[ -f "${BASH_SOURCE[0]:-}" ] && cd "$(dirname "${BASH_SOURCE[0]}")"',"command -v ffmpeg >/dev/null || { echo 'ffmpeg is not on PATH' >&2; exit 1; }",'')}
  if(copy){const R=losslessReport(list);const bad=R.items.filter(i=>i.lvl!=='ok');if(bad.length){cmt('');cmt(R.lvl==='bad'?'WARNING - these clips do not match; stream copy will fail or glitch. Use Re-encode.':'Notes:');bad.forEach(i=>cmt('  - '+i.msg.replace(/[\u2014\u2013]/g,'-').replace(/[\u2019]/g,"'").replace(/\u00d7/g,'x')));cmt('')}}
  // clip list with a comment per line
  const w=Math.min(48,Math.max(...list.map(c=>LIT(c.name).length)));
  L.push(ps?'$clips = @(':'clips=(');
  list.forEach((c,i)=>{const f=fades(c);L.push('  '+LIT(c.name).padEnd(w)+`  # ${pad2(i+1)}  ${tc(c.in)} -> ${tc(c.out)}${c.muted?'  muted':''}${c.meta.hasAudio===false?'  no audio':''}${f.fi>0?`  fade in ${+f.fi.toFixed(2)}s`:''}${f.fo>0?`  fade out ${+f.fo.toFixed(2)}s`:''}${!c.muted&&volOf(c)!==1?`  volume ${Math.round(volOf(c)*100)}%`:''}`)});
  L.push(')');
  if(ps)L.push('$missing = @($clips | Where-Object { -not (Test-Path -LiteralPath $_) })','if ($missing.Count) { throw ("Not found in ${PWD}:`n  " + ($missing -join "`n  ")) }',"$ErrorActionPreference = 'Continue'  # ffmpeg logs to stderr; exit code is checked below",'');
  else L.push('for f in "${clips[@]}"; do [ -f "$f" ] || { echo "Not found: $f" >&2; exit 1; }; done','');
  if(copy){
    const lines=[];
    for(const c of list){lines.push(`file '${c.name.replace(/'/g,"'\\''")}'`);if(c.in>5e-4)lines.push('inpoint '+n3(c.in));if(c.out<c.meta.dur-5e-4)lines.push('outpoint '+n3(c.out))}
    const args=['-hide_banner','-y','-f','concat','-safe','0','-i','stitch_concat.txt','-map','0:v:0','-map','0:a:0?','-c','copy','-avoid_negative_ts','make_zero',...(ext==='.mp4'||ext==='.mov'?['-movflags','+faststart']:[]),outFile];
    if(ps){
      L.push('$list = @\'',...lines,'\'@','$listFile = Join-Path $PWD \'stitch_concat.txt\'','[IO.File]::WriteAllLines($listFile, [string[]]($list -split "`r?`n"), (New-Object Text.UTF8Encoding $false))',
        '& ffmpeg '+args.map(Q).join(' '),'$code = $LASTEXITCODE','Remove-Item -LiteralPath $listFile -ErrorAction SilentlyContinue',
        'if ($code -ne 0) { throw "ffmpeg failed (exit $code) - see the log above." }',`Write-Host ('Done -> ' + (Join-Path $PWD ${psLit(outFile)})) -ForegroundColor Green`,'}');
    }else{
      L.push("cat > stitch_concat.txt <<'STITCH_LIST'",...lines,'STITCH_LIST','ffmpeg '+args.map(Q).join(' ')+' || { rm -f stitch_concat.txt; exit 1; }','rm -f stitch_concat.txt',`echo "Done -> $PWD/${outFile.replace(/(["\\$`])/g,'\\$1')}"`,')');
    }
    return L.join('\n')+'\n';
  }
  // re-encode
  const W=T.w,Hh=T.h,fx=fpsExpr(T.fps);
  const scale=T.fit==='cover'?`scale=${W}:${Hh}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${Hh}`
    :T.fit==='fill'?`scale=${W}:${Hh}:flags=lanczos`
    :`scale=${W}:${Hh}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${Hh}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const inputs=[],graph=[],labels=[];
  list.forEach((c,i)=>{
    const len=c.out-c.in,seek=[];
    if(c.in>5e-4)seek.push('-ss',n3(c.in));if(trimmed(c))seek.push('-t',n3(len));
    inputs.push({seek,i});
    const f=fades(c),vfade=(f.fi>0.001?`,fade=t=in:st=0:d=${n3(f.fi)}`:'')+(f.fo>0.001?`,fade=t=out:st=${n3(len-f.fo)}:d=${n3(f.fo)}`:'');
    graph.push(`[${i}:v]setpts=PTS-STARTPTS,${scale},setsar=1,fps=${fx}${vfade},format=yuv420p[v${i}]`);
    if(audio){
      if(c.muted||c.meta.hasAudio===false)graph.push(`anullsrc=r=48000:cl=stereo,atrim=end=${n3(len)},asetpts=PTS-STARTPTS[a${i}]`);
      else graph.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS${volOf(c)!==1?`,volume=${+volOf(c).toFixed(2)}`:''}${f.fi>0.001?`,afade=t=in:st=0:d=${n3(f.fi)}`:''}${f.fo>0.001?`,afade=t=out:st=${n3(len-f.fo)}:d=${n3(f.fo)}`:''}[a${i}]`);
    }
    labels.push(audio?`[v${i}][a${i}]`:`[v${i}]`);
  });
  graph.push(`${labels.join('')}concat=n=${list.length}:v=1:a=${audio?1:0}${audio?'[v][a]':'[v]'}`);
  const E=ENC[o.enc]||ENC.x264,venc=E.a(String(E.q[o.q]??E.q.high));
  const tail=[...(audio?['-map','[v]','-map','[a]']:['-map','[v]']),...venc,...(audio?['-c:a','aac','-b:a','192k']:['-an']),'-movflags','+faststart'];
  if(ps){
    L.push('$inputs = @(');inputs.forEach(x=>L.push('  '+[...x.seek,'-i'].map(psLit).join(', ')+`, $clips[${x.i}]`));L.push(')');
    L.push('$graph = @(');graph.forEach(gp=>L.push('  '+psLit(gp)));L.push(") -join ';'",'');
    L.push('& ffmpeg -hide_banner -y @inputs -filter_complex $graph `','  '+tail.map(psQ).join(' ')+' `','  '+psQ(outFile));
    L.push('if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed (exit $LASTEXITCODE) - see the log above." }',`Write-Host ('Done -> ' + (Join-Path $PWD ${psLit(outFile)})) -ForegroundColor Green`,'}');
  }else{
    L.push('inputs=(');inputs.forEach(x=>L.push('  '+[...x.seek,'-i'].map(shQ).join(' ')+` "\${clips[${x.i}]}"`));L.push(')');
    L.push('graph=(');graph.forEach(gp=>L.push('  '+shLit(gp)));L.push(')',"fc=$(IFS=';'; echo \"${graph[*]}\")",'');
    L.push('ffmpeg -hide_banner -y "${inputs[@]}" -filter_complex "$fc" \\','  '+tail.map(shQ).join(' ')+' \\','  '+shQ(outFile));
    L.push(`echo "Done -> $PWD/${outFile.replace(/(["\\$`])/g,'\\$1')}"`,')');
  }
  return L.join('\n')+'\n';
}
function openFF(){
  if(!S.clips.some(ok))return;
  const list=S.clips.filter(ok),R=losslessReport(list);
  if(!FF.mode||FF._auto){FF.mode=R.lvl==='bad'||list.some(c=>c.fi>0||c.fo>0||volOf(c)!==1)?'encode':'copy';FF._auto=true}
  renderFF();$('#dlgFF').showModal();$('#ffText').focus({preventScroll:true});$('#ffText').setSelectionRange(0,0);$('#ffText').scrollTop=0;
}
function renderFF(){
  const list=S.clips.filter(ok),R=losslessReport(list),copy=FF.mode==='copy';
  for(const[id,k]of[['#ffMode','mode'],['#ffQ','q'],['#ffShell','shell']])$$(id+' button').forEach(b=>b.classList.toggle('on',b.dataset.v===FF[k]));
  $('#ffEnc').value=FF.enc;
  $$('[data-enc]').forEach(el=>el.hidden=copy);
  const T=target();
  $('#ffOut').innerHTML=`${T.w}×${T.h} · ${fpsNorm(T.fps)} fps · ${({contain:'letterbox',cover:'crop to fill',fill:'stretch'})[T.fit]}<br>${$('#oAudio').checked?'AAC 192 kbps audio':'no audio'} → ${esc(outName())}.mp4`;
  $('#ffCheck').innerHTML=R.items.map(it=>`<div class="chk ${it.lvl}">${ic(it.lvl==='ok'?'check':it.lvl==='bad'?'x':'warn')}<span>${esc(it.msg)}</span></div>`).join('');
  $('#ffText').value=buildScript(FF);
  const ps=FF.shell==='ps',file=outName()+(ps?'.ps1':'.sh');
  $('#ffHow').innerHTML=ps?`Paste into PowerShell opened in your clips folder (Shift + right-click the folder → <b>Open PowerShell window here</b>), or download and run <code>powershell -ExecutionPolicy Bypass -File .\\${esc(file)}</code> next to the clips.`
    :`Paste into a terminal in your clips folder, or download and run <code>bash ${esc(file)}</code> next to the clips.`;
  $('#ffNote').innerHTML=copy&&R.lvl==='bad'?`<span style="color:var(--cut)">These clips don’t match — switch to Re-encode.</span>`:copy?'Stream copy: no re-encoding, finishes in seconds.':'Uses your Output settings — trims are frame-accurate.';
  $('#ffDl').innerHTML=`${ic('dl')}Download ${esc(file)}`;
}
function ffSet(k,v){FF[k]=v;if(k==='mode')FF._auto=false;LS.set('stitch.ff',{mode:FF._auto?null:FF.mode,enc:FF.enc,q:FF.q,shell:FF.shell});renderFF()}
for(const[id,k]of[['#ffMode','mode'],['#ffQ','q'],['#ffShell','shell']])$(id).addEventListener('click',e=>{const b=e.target.closest('button');if(b)ffSet(k,b.dataset.v)});
$('#ffEnc').onchange=e=>ffSet('enc',e.target.value);
$('#ffCopy').onclick=async()=>{const t=$('#ffText').value;try{await navigator.clipboard.writeText(t)}catch{$('#ffText').select();document.execCommand('copy')}toast('Script copied',{kind:'ok'})};
$('#ffDl').onclick=()=>{
  const ps=FF.shell==='ps';let t=$('#ffText').value;
  if(ps)t='\uFEFF'+t.replace(/\r?\n/g,'\r\n'); // BOM so Windows PowerShell 5.1 reads non-ASCII names correctly
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:'text/plain'}));a.download=outName()+(ps?'.ps1':'.sh');a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
};
$$('dialog [data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close()}));

/* ============================================================
   PROJECT FILES + AUTOSAVE
   ============================================================ */
function projectData(){
  const o={};for(const k of OUT_KEYS){const el=$('#'+k);o[k]=el.type==='checkbox'?el.checked:el.value}
  return{app:'RipStitch',kind:'stitch',v:4,saved:new Date().toISOString(),output:o,clips:S.clips.filter(ok).map(c=>({name:c.name,size:c.size,mtime:c.mtime,in:+c.in.toFixed(4),out:+c.out.toFixed(4),muted:c.muted,fi:+(c.fi||0).toFixed(3),fo:+(c.fo||0).toFixed(3),vol:volOf(c),meta:c.meta}))};
}
let saveT=0;function scheduleSave(){clearTimeout(saveT);saveT=setTimeout(()=>{if(!P.autosave)return;if(S.clips.some(ok))LS.set('stitch.session',projectData());else if(!S.clips.length)LS.del('stitch.session')},800)}
function saveProject(){
  if(!S.clips.length)return;
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(projectData(),null,1)],{type:'application/json'}));
  a.download=outName()+'.stitch.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  toast('Project saved',{kind:'ok',sub:'Stores order, cuts, trims, fades, volume and output settings — not the video files.'});
}
function loadProject(p,src){
  if(!p||!(p.app==='SPLICE'||p.app==='RipStitch')||!Array.isArray(p.clips))throw new Error('Not a Stitch project file');
  const made=p.clips.filter(x=>x&&x.name&&x.meta&&x.meta.dur>0).map(x=>{
    const c={id:++uid,name:String(x.name),size:x.size||0,mtime:x.mtime||0,file:null,url:null,state:'ok',playable:false,meta:x.meta,thumb:null,
      in:clamp(+x.in||0,0,x.meta.dur),out:clamp(+x.out||x.meta.dur,0,x.meta.dur),muted:!!x.muted,
      fi:Math.max(0,+x.fi||0),fo:Math.max(0,+x.fo||0),vol:x.vol==null?1:clamp(+x.vol||0,0,2)};
    if(c.out-c.in<MIN_LEN){c.in=0;c.out=x.meta.dur}
    // Reuse a file already loaded this session (same name + size) so nothing needs relinking.
    const have=[...pool.values()].find(o=>o.file&&o.name===c.name&&(!c.size||o.size===c.size));
    if(have)Object.assign(c,{file:have.file,url:have.url,thumb:have.thumb,playable:have.playable,why:have.why,size:have.size,mtime:have.mtime});
    pool.set(c.id,c);return c;
  });
  if(!made.length)throw new Error('Project has no clips');
  if(p.output)loadOut(p.output);
  stopPlayback();pushHist();S.clips=made;S.sel=made[0].id;V.mode='clip';changed();viewerFollowSel();
  const missing=made.filter(c=>!c.file).length;
  toast(`${src} — ${plural(made.length,'clip')}`,{kind:'ok',sub:missing?`${plural(missing,'file')} to relink — drop ${missing===1?'it':'them'} onto Stitch. The FFmpeg script works straight away.`:'All files relinked from this session.'});
}
function renderRestore(){
  const box=$('#restore'),p=LS.get('stitch.session',null);
  if(!p||!p.clips?.length||S.clips.length){box.hidden=true;return}
  const t=p.clips.reduce((a,c)=>a+(c.out-c.in),0);
  box.hidden=false;
  box.innerHTML=`<div><b>Last session</b><span>${plural(p.clips.length,'clip')} · ${tc(t,1)} · ${new Date(p.saved).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}</span></div><button class="btn sm hv" id="bRestore">Restore</button><button class="btn sm flat io" id="bForget" data-tip="Forget it">${ic('x')}</button>`;
  $('#bRestore').onclick=()=>{try{loadProject(p,'Session restored')}catch(e){toast(e.message,{kind:'err'})}};
  $('#bForget').onclick=()=>{LS.del('stitch.session');renderRestore()};
}


/* ============================================================
   WIRING: buttons, menus, keyboard
   ============================================================ */
const menus=['#mSort','#mAdd'];
const closeMenus=()=>menus.forEach(m=>$(m).hidden=true);
const pickFiles=()=>{if(!S.exporting)$('#fileIn').click()};
const pickProject=()=>{if(!S.exporting)$('#projIn').click()};
const fromRip=()=>{if(S.exporting)return toast('Wait for the export to finish',{kind:'warn'});Rip.openImport()};
$('#bAdd').onclick=e=>{
  if(e.target.closest('#bAddMore')){e.stopPropagation();const m=$('#mAdd'),was=m.hidden;closeMenus();m.hidden=!was;return}
  pickFiles();
};
$('#mAdd').onclick=e=>{const b=e.target.closest('[data-add]');if(!b)return;closeMenus();({files:pickFiles,rip:fromRip,project:pickProject})[b.dataset.add]()};
$('#bAdd2').onclick=pickFiles;$('#bImp2').onclick=fromRip;
$('#fileIn').onchange=e=>{addFiles(e.target.files);e.target.value=''};
$('#bOpen').onclick=$('#bOpen2').onclick=pickProject;
$('#bSave').onclick=saveProject;$('#bClear').onclick=clearAll;$('#bUndo').onclick=undo;$('#bRedo').onclick=redo;
$('#bExport').onclick=exportVideo;$('#bFF').onclick=openFF;
$('#bSort').onclick=e=>{e.stopPropagation();const m=$('#mSort'),was=m.hidden;closeMenus();m.hidden=!was};
$('#mSort').onclick=e=>{const b=e.target.closest('[data-sort]');if(!b)return;closeMenus();sortClips(b.dataset.sort)};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.menu-wrap'))closeMenus()});
$('#vMode').onclick=e=>{const b=e.target.closest('button');if(b)setMode(b.dataset.m)};
$('#vView').onclick=e=>{const b=e.target.closest('button');if(!b||S.view===b.dataset.v)return;S.view=b.dataset.v;LS.set('stitch.view',S.view);if(S.view!=='timeline')setBlade(false);syncHint();renderTimeline();renderChrome();if(S.sel)requestAnimationFrame(()=>scrollToClip(S.sel))};
$('#tPlay').onclick=togglePlay;$('#tBack').onclick=e=>step(-1,e.shiftKey);$('#tFwd').onclick=e=>step(1,e.shiftKey);
$('#tStart').onclick=()=>goEdge(false);$('#tEnd').onclick=()=>goEdge(true);
$('#tIn').onclick=()=>mark('in');$('#tOut').onclick=()=>mark('out');$('#tVol').onclick=toggleVol;
$('#bSplit').onclick=splitAtPlayhead;$('#bBlade').onclick=()=>setBlade(!S.blade);
$('#bFadeIn').onclick=()=>toggleFade(pool.get(S.sel),'fi');$('#bFadeOut').onclick=()=>toggleFade(pool.get(S.sel),'fo');
$('#tShot').onclick=saveFrame;
const HINTS={timeline:'Drag to reorder · drag edges to trim · B splits at the playhead · right-click a clip for more',grid:'Drag to reorder · double-click to preview · right-click a clip for more',
  blade:'Blade: click a clip to cut it there · Esc or Shift+B puts the blade down'};
function syncHint(){$('#dockHint').textContent=HINTS[S.blade?'blade':S.view]}
$('#zIn').onclick=()=>zoomAt(1.4);$('#zOut').onclick=()=>zoomAt(1/1.4);$('#zFit').onclick=zoomFit;
D.forEach(d=>{d.addEventListener('pause',()=>{if(V.mode==='clip'&&V.playing&&!S.exporting&&d===D[0]){V.playing=false;syncTransport()}})});
$('#split').addEventListener('pointerdown',e=>{
  e.preventDefault();const y0=e.clientY,h0=$('.dock').getBoundingClientRect().height;$('#split').classList.add('drag');
  winDrag(ev=>{const h=clamp(h0-(ev.clientY-y0),150,innerHeight*0.62);document.documentElement.style.setProperty('--dock-h',h+'px')},
    ()=>{$('#split').classList.remove('drag');LS.set('stitch.dock',$('.dock').getBoundingClientRect().height)});
});
$('#projIn').onchange=e=>{const f=e.target.files[0];e.target.value='';if(f)openProjectFile(f)};
function openProjectFile(f){
  f.text().then(t=>loadProject(JSON.parse(t),`Opened ${f.name}`)).catch(err=>toast('Couldn’t open project',{kind:'err',sub:err.message}));
}

function onKey(e,typing){
  if(typing)return;
  const k=e.key,ctrl=e.ctrlKey||e.metaKey,c=pool.get(S.sel);
  const run=fn=>{e.preventDefault();fn()};
  if(ctrl){
    const kk=k.toLowerCase();
    if(kk==='z')return run(()=>e.shiftKey?redo():undo());
    if(kk==='y')return run(redo);
    if(kk==='s')return run(saveProject);
    if(kk==='o')return run(pickProject);
    if(kk==='d')return c&&run(()=>duplicate(c.id));
    if(kk==='b')return run(splitAtPlayhead);
    if(kk==='e')return run(()=>!S.exporting&&exportVideo());
    return;
  }
  if(S.exporting)return;
  if(!ctx.hidden){closeCtx();if(k==='Escape'){e.preventDefault();return}}
  if(e.altKey&&(k==='ArrowLeft'||k==='ArrowRight'))return c&&run(()=>nudge(c.id,k==='ArrowLeft'?-1:1));
  if(e.altKey)return;
  switch(k){
    case' ':case'k':case'K':return run(togglePlay);
    case'ArrowLeft':return run(()=>step(-1,e.shiftKey));
    case'ArrowRight':return run(()=>step(1,e.shiftKey));
    case'Home':return run(()=>goEdge(false));
    case'End':return run(()=>goEdge(true));
    case'i':case'I':return run(()=>mark('in'));
    case'o':case'O':return run(()=>mark('out'));
    case'x':case'X':return c&&run(()=>resetTrim(c));
    case'b':case'B':return run(()=>e.shiftKey?setBlade(!S.blade):splitAtPlayhead());
    case'p':case'P':return run(saveFrame);
    case'm':return c&&run(()=>toggleMute(c));
    case'M':return run(toggleVol);
    case'c':case'C':return run(()=>setMode('clip'));
    case's':case'S':return run(()=>setMode('seq'));
    case'Delete':case'Backspace':return c&&run(()=>removeClip(c.id));
    case'ArrowUp':case'ArrowDown':return run(()=>{if(!S.clips.length)return;const i=S.clips.indexOf(c),j=clamp(i<0?0:i+(k==='ArrowUp'?-1:1),0,S.clips.length-1);selectClip(S.clips[j].id);scrollToClip(S.clips[j].id)});
    case'+':case'=':return run(()=>zoomAt(1.4));
    case'-':case'_':return run(()=>zoomAt(1/1.4));
    case'0':return run(zoomFit);
    case'g':case'G':return run(()=>$(`#vView [data-v="${S.view==='grid'?'timeline':'grid'}"]`).click());
    case'a':case'A':return run(pickFiles);
    case'f':case'F':return run(openFF);
    case'Escape':return run(()=>{closeMenus();if(S.blade){setBlade(false);return}if(S.sel!=null){stopPlayback();S.sel=null;changed()}});
  }
}

/* ---------- shortcuts help + palette commands ---------- */
App.keySection('Stitch · playback',[['Play / pause','Space'],['Step one frame','←','→'],['Step one second','Shift+←','Shift+→'],['Go to start / end','Home','End'],['Clip viewer / sequence viewer','C','S'],['Preview sound on / off','Shift+M']]);
App.keySection('Stitch · editing',[['Split the clip at the playhead','B'],['Blade tool: click clips to cut them','Shift+B'],['Mark in / out at playhead','I','O'],['Reset trim','X'],['Save the frame as an image','P'],['Mute clip','M'],['Duplicate clip','Ctrl+D'],['Remove clip','Del'],['Move clip earlier / later','Alt+←','Alt+→'],['Select previous / next clip','↑','↓'],['Undo / redo','Ctrl+Z','Ctrl+Shift+Z']]);
App.keySection('Stitch · timeline & project',[['Zoom in / out / fit','+','−','0'],['Timeline / grid view','G'],['Add clips','A'],['Open / save project','Ctrl+O','Ctrl+S'],['Export video','Ctrl+E'],['FFmpeg script','F'],['Deselect / close','Esc']]);
const inStitch=fn=>()=>{App.go('stitch');setTimeout(fn,30)};
const has=()=>S.clips.length>0;
[
  {id:'st.add',title:'Add clips from this computer…',icon:'plus',keys:['A'],run:inStitch(pickFiles)},
  {id:'st.rip',title:'Add clips from Rip downloads…',icon:'dl',run:inStitch(fromRip)},
  {id:'st.open',title:'Open a project…',icon:'open',keys:['Ctrl+O'],run:inStitch(pickProject)},
  {id:'st.save',title:'Save project',icon:'save',keys:['Ctrl+S'],when:has,run:inStitch(saveProject)},
  {id:'st.play',title:'Play / pause',icon:'play',keys:['Space'],when:has,run:inStitch(togglePlay)},
  {id:'st.seq',title:'Preview the whole cut',icon:'film',keys:['S'],when:has,run:inStitch(()=>{setMode('seq');setTimeout(()=>{if(!V.playing)togglePlay()},120)})},
  {id:'st.export',title:'Export video',icon:'export',keys:['Ctrl+E'],when:has,run:inStitch(exportVideo)},
  {id:'st.ff',title:'FFmpeg script (fast & lossless)',icon:'term',keys:['F'],when:has,run:inStitch(openFF)},
  {id:'st.sort.name',title:'Sort clips by name',icon:'sort',when:has,run:inStitch(()=>sortClips('name'))},
  {id:'st.sort.date',title:'Sort clips by date, oldest first',icon:'sort',when:has,run:inStitch(()=>sortClips('date'))},
  {id:'st.sort.len',title:'Sort clips by length',icon:'sort',when:has,run:inStitch(()=>sortClips('len'))},
  {id:'st.sort.rev',title:'Reverse clip order',icon:'sort',when:has,run:inStitch(()=>sortClips('rev'))},
  {id:'st.view',title:'Toggle timeline / grid view',icon:'grid',keys:['G'],run:inStitch(()=>$(`#vView [data-v="${S.view==='grid'?'timeline':'grid'}"]`).click())},
  {id:'st.fit',title:'Zoom timeline to fit',icon:'fit',keys:['0'],when:has,run:inStitch(zoomFit)},
  {id:'st.undo',title:'Undo',icon:'undo',keys:['Ctrl+Z'],when:()=>hist.u.length>0,run:inStitch(undo)},
  {id:'st.redo',title:'Redo',icon:'redo',keys:['Ctrl+Shift+Z'],when:()=>hist.r.length>0,run:inStitch(redo)},
  {id:'st.clear',title:'Clear the timeline',icon:'trash',when:has,run:inStitch(clearAll)},
  {id:'st.split',title:'Split the clip at the playhead',icon:'split',keys:['B'],words:'cut razor',when:has,run:inStitch(splitAtPlayhead)},
  {id:'st.blade',title:'Blade tool: click clips to cut them',icon:'blade',keys:['Shift+B'],words:'split cut razor',when:has,run:inStitch(()=>{if(S.view!=='timeline')$('#vView [data-v="timeline"]').click();setBlade(!S.blade)})},
  {id:'st.fadein',title:'Fade the selected clip in from black',icon:'fadein',words:'fade transition',when:()=>ok(pool.get(S.sel)),run:inStitch(()=>toggleFade(pool.get(S.sel),'fi'))},
  {id:'st.fadeout',title:'Fade the selected clip out to black',icon:'fadeout',words:'fade transition',when:()=>ok(pool.get(S.sel)),run:inStitch(()=>toggleFade(pool.get(S.sel),'fo'))},
  {id:'st.frame',title:'Save the current frame as an image',icon:'camera',keys:['P'],words:'snapshot screenshot still png jpg',when:has,run:inStitch(saveFrame)},
  {id:'st.prefs',title:'Stitch settings…',icon:'gear',words:'preferences fade length blade',run:()=>Settings.open('stitch')},
].forEach(c=>App.cmd({group:'Stitch',...c}));

/* ---------- Settings → Stitch ---------- */
Settings.add({id:'stitch',order:20,title:'Stitch',icon:'cut',sub:'How the editor behaves. Video size and format are in the Output panel beside the viewer.',
  render(el){
    const sel=(k,opts)=>`<select class="inp" data-q="${k}">${opts.map(([v,l])=>`<option value="${v}"${String(P[k])===String(v)?' selected':''}>${l}</option>`).join('')}</select>`;
    const sw=k=>`<input type="checkbox" class="sw" data-q="${k}"${P[k]?' checked':''}>`;
    el.innerHTML=`
      <div class="set-row"><div><b>Fade length</b><span>Used when you switch on a fade with a button, the menu or the command palette. Each clip’s fades can still be set exactly.</span></div>${sel('fadeLen',[[0.25,'¼ second'],[0.5,'½ second'],[1,'1 second'],[1.5,'1½ seconds'],[2,'2 seconds'],[3,'3 seconds']])}</div>
      <label class="set-row"><div><b>Blade snaps to the playhead</b><span>When the blade is close to the playhead, it cuts exactly there.</span></div>${sw('snap')}</label>
      <label class="set-row"><div><b>Preview the frame under the blade</b><span>The viewer shows the exact frame you’re about to cut at while the blade hovers.</span></div>${sw('skim')}</label>
      <label class="set-row"><div><b>Remember my timeline</b><span>Keeps your cut between visits so you can pick up where you left off. Files may need relinking.</span></div>${sw('autosave')}</label>
      <div class="set-row"><div><b>Saved frames</b><span>The format for <kbd>P</kbd> / Save frame. PNG is lossless, JPEG is smaller.</span></div>${sel('frameFmt',[['png','PNG'],['jpg','JPEG']])}</div>`;
  },
  save(el){
    el.querySelectorAll('[data-q]').forEach(f=>{const k=f.dataset.q;P[k]=f.type==='checkbox'?f.checked:typeof P[k]==='number'?+f.value:f.value});
    LS.set('stitch.prefs',P);
    if(!P.autosave)LS.del('stitch.session');else scheduleSave();
    renderRestore();
  }
});

/* ---------- boot ---------- */
(function boot(){
  loadOut(LS.get('stitch.out',null));
  const dock=LS.get('stitch.dock',null);if(dock)document.documentElement.style.setProperty('--dock-h',clamp(dock,150,innerHeight*0.62)+'px');
  S.view=LS.get('stitch.view','timeline')==='grid'?'grid':'timeline';
  syncModeButtons();syncTransport();syncHint();renderAll();
})();

return{
  onShow(){changed();requestAnimationFrame(()=>{layoutFrame();renderTimeline()})},
  onHide(){stopPlayback();closeMenus();closeCtx();bladeHide();skimEnd()},
  canLeave(){if(S.exporting){toast('Export in progress',{kind:'warn',sub:'Stay on Stitch until it finishes: browsers pause hidden video. Cancel the export to leave.'});return false}return true},
  onKey,addFiles,openProjectFile,
  busy:()=>!!S.exporting,
  count:()=>S.clips.length,
  hasFile:(name,size)=>S.clips.some(c=>c.file&&c.name===name&&c.size===size),
  _debug:{S,V,P,pool,SEQ:()=>SEQ,buildScript,losslessReport,sniff,fixWebmDuration,FF,splitClip,fades,fxAlpha,setBlade,TL,seqToX,SK},
};
})();
App.register('stitch',Stitch);
