function peaks(buf,W=1000){const c=buf.getChannelData(0),step=Math.floor(c.length/W),p=new Float32Array(W);for(let i=0;i<W;i++){let m=0;const b=i*step;for(let k=0;k<step;k+=8){const v=Math.abs(c[b+k]);if(v>m)m=v;}p[i]=m;}return p;}

/* ---------------- DSP worker ---------------- */
let worker=null,reqId=0;const pending={};
function getWorker(){
  if(worker) return worker;
  const src=document.getElementById("dspSrc").textContent;
  worker=new Worker(URL.createObjectURL(new Blob([src],{type:"text/javascript"})));
  worker.onmessage=e=>{const m=e.data;
    if(m.cmd==="progress"){progress(m.p,m.label);lastBeat=Date.now();return;}
    const p=pending[m.id]; if(!p) return; delete pending[m.id]; clearTimeout(p.timer);
    if(m.cmd==="error") p.rej(new Error(m.message)); else p.res(m);};
  // a worker killed by the browser (usually low memory) fires error or simply goes silent: fail every waiting request
  worker.onerror=e=>{e.preventDefault&&e.preventDefault();killWorker("the background analysis crashed, most likely because the device ran low on memory");};
  worker.onmessageerror=()=>killWorker("the background analysis sent back data the page couldn't read");
  return worker;
}
let lastBeat=0;
function killWorker(reason){
  if(worker){try{worker.terminate();}catch(e){} worker=null;}
  Object.keys(pending).forEach(id=>{const p=pending[id];clearTimeout(p.timer);delete pending[id];p.rej(new Error(reason));});
}
/** Send a job to the worker. Rejects if no progress or result arrives for `silentMs`. */
function ask(msg,transfer,silentMs){
  return new Promise((res,rej)=>{
    const id=++reqId; lastBeat=Date.now();
    const watch=()=>{ if(!pending[id]) return; if(Date.now()-lastBeat>silentMs) killWorker("the analysis stopped responding, most likely because the device ran low on memory"); else pending[id].timer=setTimeout(watch,2000); };
    pending[id]={res,rej,timer:setTimeout(watch,2000)};
    getWorker().postMessage({...msg,id},transfer||[]);
  });
}
function showFailure(err){
  progress(null); A.busy=false; setState("analysis stopped");
  $("#nowSub").textContent="The rework stopped: "+(err&&err.message||"unknown error")+". Close other apps or tabs and load the song again, or try a shorter file or an a cappella.";
}
function progress(p,label){const box=$("#prog");if(p==null){box.hidden=true;return;}box.hidden=false;$("#progBar").style.width=Math.round(p*100)+"%";$("#progLabel").textContent=label+" · "+Math.round(p*100)+"%";}

/* ---------------- Loading and analysis pipeline ---------------- */
const SEP_SR=22050, MAX_SEC=360;
async function loadFile(file){
  ensureCtx(); if(playing) stop();
  A.busy=true; setState("decoding audio…"); progress(0.01,"Decoding audio");
  try{
    const ab=await file.arrayBuffer();
    const buf=await new Promise((res,rej)=>{const p=ctx.decodeAudioData(ab,res,rej);if(p&&p.then)p.then(res,rej);});
    A.buf={duration:buf.duration}; A.peaks=peaks(buf); A.title=A.pending?A.pending.title+" — "+A.pending.artist:file.name.replace(/\.[^.]+$/,"");
    A.pending=null; A.sep=null; A.voc=null; A.arr=null; A.chords=null; A.overrides={};
    progress(0.03,"Finding the tempo"); await new Promise(r=>setTimeout(r,20));
    const r=analyse(buf); if(r){A.srcBpm=r.bpm;A.offset=r.offset;} else {A.srcBpm=120;A.offset=0;}
    progress(0.05,"Preparing audio");
    const dur=Math.min(buf.duration,MAX_SEC), off=new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(2,Math.ceil(dur*SEP_SR),SEP_SR);
    const bs=off.createBufferSource(); bs.buffer=buf; bs.connect(off.destination); bs.start(0);
    const rs=await off.startRendering();
    const L=rs.getChannelData(0).slice(0), R=(rs.numberOfChannels>1?rs.getChannelData(1):rs.getChannelData(0)).slice(0);
    const sep=await ask({cmd:"separate",L,R,sr:SEP_SR,acappella:A.acap},[L.buffer,R.buffer],25000);
    A.sep=sep; A.vocRaw=sep.vocal;
    regrid(); regen(newSeed()); await restretch();
    progress(null); setState("rework ready");
  }catch(e){
    if(!A.sep&&!/memory|responding|crashed|read/.test(e&&e.message||"")){progress(null); setState("couldn't read that file");
      $("#nowSub").textContent="That file couldn't be decoded. Try an MP3, M4A or WAV that isn't copy-protected.";}
    else showFailure(e);
  }
  A.busy=false; ui();
}
/** Recompute bar grid, chords, key, vocal activity and arrangement (after load or a tempo/grid change). */
function regrid(keepOverrides){
  if(!A.sep) return;
  const dur=Math.min(A.buf.duration,MAX_SEC);
  A.nBars=Math.max(1,Math.floor((dur-A.offset)/barSong()));
  A.chords=Analysis.detectChords(A.sep,A.offset,barSong(),A.nBars);
  A.songKey=Analysis.detectKey(A.sep);
  A.va=A.acap?Analysis.vocalPerBar(A.sep,A.offset,barSong(),A.nBars):Analysis.vocalPerBar(A.sep,A.offset,barSong(),A.nBars);
  if(!keepOverrides) A.overrides={};
  rearrange();
  const first=A.va.findIndex(v=>v>0.5); A.secBar=Math.max(0,first<0?0:first-(first%4));
}
function rearrange(){ if(!A.chords) return; A.arr=Analysis.arrange({va:A.va,chords:A.chords,nBars:A.nBars,intro:A.intro,outro:A.outro,trimGaps:A.trim,overrides:A.overrides}); }
/** Time-stretch the extracted vocal for the current tempo ratio and pitch option. */
async function restretch(){
  if(!A.vocRaw) return; const s=stretchS(); if(A.voc&&A.vocS===s) return;
  const was=playing; if(was) stop(); A.busy=true; ui(); progress(0,"Fitting the vocal to the new tempo");
  A.voc=null; // release the previous stretch before making a new one
  try{
    const x=A.vocRaw.slice(0); const m=await ask({cmd:"stretch",x,s},[x.buffer],15000);
    const b=ctx.createBuffer(1,m.y.length,SEP_SR); b.getChannelData(0).set(m.y); A.voc=b; A.vocS=s;
  }catch(e){ A.vocS=null; showFailure(e); throw e; }
  progress(null); A.busy=false; if(was) start(); else ui();
}

/* ---------------- UI ---------------- */
const $=s=>document.querySelector(s);
function setState(t){$("#engineState").textContent=t;}
function fmtBpm(b){return b==null?"—":(Number.isInteger(b)?b:b.toFixed(1))+"";}
function fmtTime(sec){sec=Math.max(0,Math.round(sec));return Math.floor(sec/60)+":"+String(sec%60).padStart(2,"0");}
function keyLabel(){
  const k=A.songKey; if(!k) return "—";
  const sh=shiftSemis(), pc=((k.pc+sh)%12+12)%12, rel=k.mode==="major"?(pc+9)%12:(pc+3)%12;
  const main=NOTES[pc]+(k.mode==="minor"?" min":" maj");
  return k.conf<0.02? main+" / "+NOTES[rel]+(k.mode==="minor"?" maj":" min") : main;
}
function ui(){
  const has=!!A.buf, ready=hasRework();
  $("#play").textContent=playing?"■ Stop":"▶ Play"; $("#play").disabled=A.busy;
  ["#build","#brk"].forEach(s=>$(s).disabled=!playing);
  ["#half","#dbl","#shiftBeat","#nudgeL","#nudgeR"].forEach(s=>$(s).disabled=!ready||A.busy);
  $("#export").disabled=!ready||A.busy;
  $("#brk").classList.toggle("on",breakdown);$("#brk").setAttribute("aria-pressed",breakdown);
  $("#acap").setAttribute("aria-pressed",A.acap);
  $("#rTgt").textContent=A.target;
  $("#rSrc").textContent=ready?fmtBpm(A.srcBpm):"—";
  $("#rKey").textContent=ready?keyLabel():"—";
  const q=pitchQ(),st=12*Math.log2(q);
  $("#rVox").textContent=!ready?"—":A.pitch==="tempo"?("speed-up "+(st>=0?"+":"−")+Math.abs(st).toFixed(1)+" st"):(+A.pitch?((+A.pitch>0?"+":"−")+Math.abs(+A.pitch)+" st"):"natural pitch");
  $("#rLen").textContent=!ready?"—":A.form==="loop"?A.loopBars+"-bar loop":fmtTime(A.arr.bars.length*barOut());
  $("#loopRow").hidden=A.form!=="loop"; $("#arrNote").hidden=!ready||A.form==="loop";
  if(has){$("#nowTitle").textContent=A.title;
    $("#nowSub").textContent=ready?(STYLES[A.style].name+" rework · "+(A.form==="loop"?"looping bars "+(A.secBar+1)+"–"+(A.secBar+A.loopBars)+". Tap the waveform to move the loop.":A.arr.bars.length+" bars, built around the vocal")):"Working on it…";}
  else if(A.pending){$("#nowTitle").textContent=A.pending.title+" — "+A.pending.artist;$("#nowSub").textContent="Next up. Load your copy of this song and it will be rebuilt as "+STYLES[A.style].name.toLowerCase()+".";}
  else {$("#nowTitle").textContent="No song loaded";$("#nowSub").textContent="The groove plays on its own. Load a song (MP3, M4A, WAV) to rebuild it around its vocal.";}
  if(!A.busy){ if(ready) setState(playing?"playing · "+STYLES[A.style].name.toLowerCase():"rework ready"); else if(!has&&!A.pending) setState(playing?"playing · beat only":"beat only · no song loaded"); }
  $("#sepNote").textContent=!A.sep?"":A.acap?"Treating the file as an a cappella: the whole file is used as the vocal.":
    A.sep.mono?"This recording is mono, so instruments playing with the vocal can't be separated from it. Some backing will come through. An a cappella gives the cleanest result.":
    "Vocal extracted from the centre of the stereo mix, with drums removed. Instruments panned to the centre may still bleed through; raise Vocal low cut to clean up bass.";
  $("#chordNote").textContent=!A.chords?"":(()=>{const ok=A.chords.filter(c=>c.ok).length;return "Chords detected with confidence on "+ok+" of "+A.chords.length+" bars; the rest hold the previous chord."+(ok<A.chords.length*0.4?" Confidence is low, so Fixed key progression may sound better.":"");})();
  document.querySelectorAll("#deck .chip[data-k]").forEach(c=>c.setAttribute("aria-pressed",c.dataset.k===A.style));
  {const S=STYLES[A.style];$("#styleNote").textContent=S.desc+(S.by?" Inspired by the sound of "+S.by+".":"");}
  drawWave(); drawArr();
}

/* waveform of the original song: included bars, vocal activity, loop region, playhead */
const wv=$("#wave"),av=$("#arr");
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function sizeCanvas(c,h){const dpr=window.devicePixelRatio||1,w=c.clientWidth||600;if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);}const g=c.getContext("2d");g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,w,h);return [g,w];}
function curOutBar(){ if(!playing||!ctx) return -1; return (ctx.currentTime-T0)/barOut(); }
function drawWave(){
  const h=84,[g,w]=sizeCanvas(wv,h);
  if(!A.buf){g.fillStyle=css("--mute");g.font="13px 'IBM Plex Sans',sans-serif";g.textAlign="center";g.fillText("Load a song to see it here",w/2,h/2+4);return;}
  const D=A.buf.duration,X=t=>t/D*w,bs=barSong();
  if(A.arr&&A.form==="full"){const inc=new Set(A.arr.bars.map(b=>b.songBar));g.fillStyle="rgba(79,214,200,.10)";inc.forEach(sb=>{if(sb<0)return;const a=X(A.offset+sb*bs);g.fillRect(a,0,X(A.offset+(sb+1)*bs)-a+0.5,h);});}
  if(A.arr&&A.form==="loop"){const a=X(A.offset+A.secBar*bs),b=X(A.offset+(A.secBar+A.loopBars)*bs);g.fillStyle="rgba(255,138,61,.18)";g.fillRect(a,0,b-a,h);g.fillStyle=css("--accent");g.fillRect(a,0,2,h);g.fillRect(b-2,0,2,h);}
  const P=A.peaks;g.fillStyle="rgba(143,156,183,.55)";for(let x=0;x<w;x++){const v=P[Math.floor(x/w*P.length)]||0,hh=Math.max(1,v*(h-24));g.fillRect(x,(h-14-hh)/2,1,hh);}
  if(A.va){g.fillStyle=css("--accent");for(let b=0;b<A.va.length;b++){const a=X(A.offset+b*bs),e=X(A.offset+(b+1)*bs),v=Math.min(1,A.va[b]);g.globalAlpha=0.25+0.75*v;g.fillRect(a,h-10,Math.max(1,e-a-1),8*v+1);}g.globalAlpha=1;}
  const ob=curOutBar(); if(ob>=0&&A.arr){let sb=-1,fr=ob%1;
    if(A.form==="loop") sb=A.secBar+Math.floor(ob)%A.loopBars; else {const b=A.arr.bars[Math.floor(ob)];sb=b?b.songBar:-1;}
    if(sb>=0){g.fillStyle="#fff";g.fillRect(X(A.offset+(sb+fr)*bs),0,2,h);}}
}
const TYPE_COL={intro:"#2a3a5e",outro:"#2a3a5e",groove:"#2c6f6a",drop:"#ff8a3d",break:"#7c6fd6"};
const TYPE_NAME={intro:"Intro",outro:"Outro",groove:"Groove",drop:"Drop",break:"Break"};
function drawArr(){
  const h=62,[g,w]=sizeCanvas(av,h);
  if(!hasRework()||A.form==="loop"){g.fillStyle=css("--mute");g.font="12px 'IBM Plex Sans',sans-serif";g.textAlign="center";
    g.fillText(A.form==="loop"&&hasRework()?"Hook loop: the arrangement is off":"The arrangement appears here after a song is analysed",w/2,h/2);return;}
  const bars=A.arr.bars,n=bars.length,bw=w/n;
  bars.forEach((b,i)=>{g.fillStyle=TYPE_COL[b.type];g.fillRect(i*bw,4,Math.max(1,bw-0.5),34);
    if(b.build){g.fillStyle="rgba(255,255,255,.35)";for(let k=0;k<3;k++)g.fillRect(i*bw,4+k*12,bw-0.5,4);}});
  g.font="600 11px 'IBM Plex Sans',sans-serif";g.textAlign="left";g.textBaseline="middle";
  A.arr.blocks.forEach(B=>{const x=B.start*bw,ww=B.len*bw;if(ww<34)return;g.fillStyle=B.type==="drop"?"#1a0e04":"#eef1f7";g.fillText(TYPE_NAME[B.type],x+4,21);});
  g.font="10px 'IBM Plex Mono',monospace";g.fillStyle=css("--mute");let lastX=-99,last="";
  bars.forEach((b,i)=>{const nm=b.chord?NOTES[((b.chord.pc+shiftSemis())%12+12)%12]+(b.chord.q==="min"?"m":""):"";if(A.harmony!=="song")return;
    if(nm!==last&&i*bw-lastX>26){g.fillText(nm,i*bw+1,52);lastX=i*bw;}last=nm;});
  if(A.harmony!=="song"){g.fillText("Fixed key progression",2,52);}
  const ob=curOutBar(); if(ob>=0){g.fillStyle="#fff";g.fillRect(ob*bw,0,2,40);}
}
wv.addEventListener("click",e=>{
  if(!A.buf||!A.arr) return; const r=wv.getBoundingClientRect(),t=(e.clientX-r.left)/r.width*A.buf.duration;
  if(A.form!=="loop"){A.form="loop";$("#form").value="loop";}
  A.secBar=Math.max(0,Math.min(A.nBars-A.loopBars,Math.floor((t-A.offset)/barSong()))); restart();
});
av.addEventListener("click",e=>{
  if(!hasRework()||A.form==="loop") return; const r=av.getBoundingClientRect(),i=Math.floor((e.clientX-r.left)/r.width*A.arr.bars.length);
  const b=A.arr.bars[i]; if(!b) return; const B=A.arr.blocks[b.block]; if(!B||B.type==="intro"||B.type==="outro") return;
  const next={groove:"drop",drop:"break",break:"groove"}[B.type]; A.overrides[b.block]=next; rearrange(); ui();
});

/* step lights + spectrum */
const stepsEl=$("#steps");for(let i=0;i<16;i++){const d=document.createElement("i");if(i%4===0)d.className="beat";stepsEl.appendChild(d);}
const stepEls=[...stepsEl.children],sp=$("#spec");let lastLit=-1,lastDraw=0;
function frame(ts){
  if(ctx&&playing){
    const now=ctx.currentTime;let cur=-1;while(lights.length&&lights[0].t<=now){cur=lights.shift().s;}
    if(cur>=0&&cur!==lastLit){if(lastLit>=0)stepEls[lastLit].classList.remove("lit");stepEls[cur].classList.add("lit");lastLit=cur;}
    if(ts-lastDraw>60){drawWave();drawArr();lastDraw=ts;}
  } else if(lastLit>=0){stepEls[lastLit].classList.remove("lit");lastLit=-1;}
  const [g,w]=sizeCanvas(sp,56),h=56;
  if(ctx&&N.an){const d=new Uint8Array(N.an.frequencyBinCount);N.an.getByteFrequencyData(d);const n=48,bw=w/n;
    for(let i=0;i<n;i++){const v=d[Math.floor(Math.pow(i/n,1.6)*d.length*0.9)]/255;g.fillStyle=i<10?"#ff8a3d":"#4fd6c8";g.globalAlpha=0.35+0.65*v;g.fillRect(i*bw+1,h-v*(h-4),bw-2,v*(h-4));}g.globalAlpha=1;}
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener("resize",()=>{drawWave();drawArr();});

/* ---------------- Controls ---------------- */
const safely=fn=>async(...a)=>{try{await fn(...a);}catch(e){ui();}};
$("#play").addEventListener("click",safely(async()=>{ if(playing) return stop(); if(A.vocRaw&&!A.voc) await restretch(); start(); }));
$("#fileIn").addEventListener("change",e=>{const f=e.target.files[0];if(f)loadFile(f);e.target.value="";});
$("#acap").addEventListener("click",()=>{A.acap=!A.acap;ui();if(A.buf&&!A.busy){$("#sepNote").textContent="Reload the file to apply this.";}});
$("#build").addEventListener("click",()=>{if(!playing||buildStart>=0)return;buildStart=Math.ceil((step+1)/16)*16;});
$("#brk").addEventListener("click",()=>{breakdown=!breakdown;ui();});
$("#tgt").addEventListener("input",e=>{$("#tgtOut").textContent=e.target.value+" BPM";});
$("#tgt").addEventListener("change",safely(async e=>{A.target=+e.target.value;applyMix();await restretch();restart();}));
$("#form").addEventListener("change",e=>{A.form=e.target.value;restart();});
$("#loopLen").addEventListener("change",e=>{A.loopBars=+e.target.value;A.secBar=Math.min(A.secBar,Math.max(0,A.nBars-A.loopBars));restart();});
$("#prevSec").addEventListener("click",()=>{A.secBar=Math.max(0,A.secBar-A.loopBars);restart();});
$("#nextSec").addEventListener("click",()=>{A.secBar=Math.min(Math.max(0,A.nBars-A.loopBars),A.secBar+A.loopBars);restart();});
$("#intro").addEventListener("change",e=>{A.intro=+e.target.value;A.overrides={};rearrange();restart();});
$("#outro").addEventListener("change",e=>{A.outro=+e.target.value;A.overrides={};rearrange();restart();});
$("#trim").addEventListener("click",()=>{A.trim=!A.trim;$("#trim").setAttribute("aria-pressed",A.trim);A.overrides={};rearrange();restart();});
$("#pitch").addEventListener("change",safely(async e=>{A.pitch=e.target.value;await restretch();restart();}));
$("#harmony").addEventListener("change",e=>{A.harmony=e.target.value;ui();});
$("#autoArr").addEventListener("click",()=>{A.overrides={};rearrange();ui();});
async function regridAnd(fn){try{fn();regrid();await restretch();restart();}catch(e){ui();}}
$("#half").addEventListener("click",()=>regridAnd(()=>{A.srcBpm=Math.round(A.srcBpm*5)/10;A.offset%=(60/A.srcBpm);}));
$("#dbl").addEventListener("click",()=>regridAnd(()=>{A.srcBpm=Math.round(A.srcBpm*20)/10;A.offset%=(60/A.srcBpm);}));
$("#shiftBeat").addEventListener("click",()=>regridAnd(()=>{A.offset=(A.offset+60/A.srcBpm)%barSong();}));
$("#nudgeL").addEventListener("click",()=>regridAnd(()=>{A.offset=Math.max(0,A.offset-0.01);}));
$("#nudgeR").addEventListener("click",()=>regridAnd(()=>{A.offset+=0.01;}));
let taps=[];$("#tap").addEventListener("click",()=>{const n=performance.now();taps=taps.filter(x=>n-x<2500);taps.push(n);
  if(taps.length>=4){const iv=(taps[taps.length-1]-taps[0])/(taps.length-1);const b=60000/iv;$("#tap").textContent="Use tapped tempo: "+b.toFixed(1);$("#tap").dataset.bpm=b.toFixed(1);}
  else {$("#tap").textContent="Tap "+(4-taps.length)+" more";delete $("#tap").dataset.bpm;}});
$("#tapUse").addEventListener("click",()=>{const b=+$("#tap").dataset.bpm;if(!b||!hasRework())return;regridAnd(()=>{A.srcBpm=Math.round(b*10)/10;A.offset%=(60/A.srcBpm);});});

// style chips
Object.entries(STYLES).forEach(([k,s])=>{const b=document.createElement("button");b.type="button";b.className="chip";b.dataset.k=k;b.textContent=s.name+" · "+s.bpm;b.addEventListener("click",()=>setStyle(k));$("#styles"+s.group).appendChild(b);});
/* ---------------- Generated beats ---------------- */
function newSeed(){ try{const u=new Uint32Array(1);crypto.getRandomValues(u);return u[0];}catch(e){return (Math.random()*4294967296)>>>0;} }
/** Roll a new beat for the current style (or rebuild one from a known seed). */
function regen(seed){
  A.seed=seed>>>0; A.groove=Gen.generate(STYLES[A.style],A.seed);
  A.target=A.groove.bpm; $("#tgt").value=A.target; $("#tgtOut").textContent=A.target+" BPM";
  A.mix.pump=STYLES[A.style].pump; $("#mPump").value=A.mix.pump; outs(); applyMix(); renderPattern();
}
async function setStyle(k){A.style=k;regen(newSeed());try{if(A.vocRaw)await restretch();}catch(e){}restart();}
$("#newBeat").addEventListener("click",safely(async()=>{regen(newSeed());if(A.vocRaw)await restretch();restart();}));
const ROWS=[["Kick",S=>[0,4,8,12]],["Clap",S=>S.clap],["Hats",S=>[...new Set(S.hat.concat(S.open,S.hat2||[]))]],["Perc",S=>S.perc.map(p=>p[0]).concat((S.dropPerc||[]).map(p=>p[0]))],
  ["Bass",S=>S.bass.notes.map(n=>n[0])],["Chords",S=>S.chords?S.chords.hits.map(h=>h[0]):[]],["Chops",S=>S.chops?S.chops.map(c=>c[0]):[]]];
function renderPattern(){
  const G=A.groove; if(!G) return; const el=$("#pattern"); el.innerHTML="";
  ROWS.forEach(([name,f])=>{const on=new Set(f(G));const row=document.createElement("div");row.className="prow";
    const lab=document.createElement("span");lab.textContent=name;row.appendChild(lab);
    for(let s=0;s<16;s++){const c=document.createElement("i");if(on.has(s))c.className="on";if(s%4===0)c.classList.add("q");row.appendChild(c);}el.appendChild(row);});
  $("#beatCode").textContent="Beat "+G.code+" · "+STYLES[A.style].name+" · "+G.bpm+" BPM · swing "+Math.round(G.swing*100)+"% · "+G.bass.type+" bass";
}

// keys
NOTES.forEach((n,j)=>$("#key").add(new Option(n,j)));
$("#key").value=A.key;
$("#key").addEventListener("change",e=>{A.key=+e.target.value;});
$("#mode").addEventListener("change",e=>{A.mode=e.target.value;});

// mix sliders
const MIX=[["mVox","vox",v=>Math.round(v*100)+"%"],["mLow","low",v=>Math.round(60*Math.pow(10,v))+" Hz"],["mDrums","drums",v=>Math.round(v*100)+"%"],["mPerc","perc",v=>Math.round(v*100)+"%"],["mChops","chops",v=>Math.round(v*100)+"%"],["mBass","bass",v=>Math.round(v*100)+"%"],["mChords","chords",v=>Math.round(v*100)+"%"],["mPump","pump",v=>Math.round(v*100)+"%"],["mFilt","filt",v=>{const f=250*Math.pow(80,v);return v>=0.995?"open":f>=1000?(f/1000).toFixed(1)+" kHz":Math.round(f)+" Hz";}]];
function outs(){MIX.forEach(([id,k,f])=>{$("#"+id+"O").textContent=f(A.mix[k]);});}
MIX.forEach(([id,k])=>$("#"+id).addEventListener("input",e=>{A.mix[k]=+e.target.value;outs();applyMix();}));
outs();

/* ---------------- Record (real time) and Export (offline render) ---------------- */
const dlP=(window.claude&&typeof window.claude.use==="function")?window.claude.use("downloads").catch(()=>null):Promise.resolve(null);
let mr=null,chunks=[],take=null,takeName="";
function pickMime(){if(!window.MediaRecorder)return null;for(const m of["audio/webm;codecs=opus","audio/webm","audio/mp4"]){try{if(MediaRecorder.isTypeSupported(m))return m;}catch(e){}}return "";}
function baseName(){return (A.title||"house-groove").replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"-").slice(0,60)||"house-groove";}
function showTake(blob,label,fname){take=blob;takeName=fname;const a=$("#takeAudio");if(a.src)URL.revokeObjectURL(a.src);a.src=URL.createObjectURL(blob);$("#takeLabel").textContent=label;$("#takeBox").hidden=false;$("#saveMsg").textContent="";}
$("#rec").addEventListener("click",async()=>{
  if(mr&&mr.state==="recording"){mr.stop();return;}
  ensureCtx(); const mime=pickMime();
  if(mime===null||!N.rec){$("#takeBox").hidden=false;$("#saveMsg").textContent="Recording isn't supported in this browser. Use Export WAV instead.";$("#saveTake").hidden=true;return;}
  if(!playing) await start();
  chunks=[]; mr=new MediaRecorder(N.rec.stream,mime?{mimeType:mime}:undefined);
  mr.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
  mr.onstop=()=>{const type=mr.mimeType||mime||"audio/webm",blob=new Blob(chunks,{type});const ext=type.includes("mp4")?"mp4":"webm";
    showTake(blob,"Live recording",baseName()+"-house-rework."+ext);$("#rec").classList.remove("on");$("#rec").textContent="● Record";};
  mr.start(250);$("#rec").classList.add("on");$("#rec").textContent="■ Stop recording";
});
$("#export").addEventListener("click",async()=>{
  if(!hasRework()||A.busy) return; if(playing) stop();
  A.busy=true;ui();progress(0.3,"Rendering the full track");
  try{
    const buf=await renderOffline(); progress(0.9,"Writing WAV");
    const wav=wavBytes(buf), name=baseName()+"-house-rework";
    showTake(new Blob([wav],{type:"audio/wav"}),"Rendered track · "+fmtTime(buf.duration)+" WAV",name+".zip");
    $("#takeBox").dataset.wav="1"; window.__wavForZip={name:name+".wav",wav};
  }catch(e){$("#takeBox").hidden=false;$("#saveMsg").textContent="Rendering failed on this device ("+(e&&e.message||"unknown")+"). Try Record instead.";}
  progress(null);A.busy=false;ui();
});
dlP.then(d=>{if(!d){$("#saveTake").hidden=true;$("#saveMsg").textContent="Saving isn't available in this view. You can still play your take here.";}});
$("#saveTake").addEventListener("click",async()=>{
  const d=await dlP; if(!d||!take) return;
  let data=take,fname=takeName;
  if(take.type==="audio/wav"&&window.__wavForZip){data=zipStore(window.__wavForZip.name,window.__wavForZip.wav);}
  try{await d.save({filename:fname,data});$("#saveMsg").textContent="Saved.";}
  catch(e){$("#saveMsg").textContent=e&&e.code==="declined"?"Save cancelled.":"Couldn't save the file here ("+(e&&e.code||"unknown")+").";}
});

// first beat on page load
regen(newSeed());
