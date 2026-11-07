// Runs the page script against stub DOM + stub Web Audio, drives the whole rework pipeline with a synthetic song.
const fs=require('fs'),DSP=require('../src/dsp-worker.js'),{synthSong}=require('./synth_song.js');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const appSrc=html.match(/<script>\n"use strict";([\s\S]*?)<\/script>/)[1];
// ---- stub audio ----
let nodes=0; const calls={vocal:0,chop:0,kick:0,crash:0};
const param=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(v){if(!(v>0))throw new Error('exp ramp to '+v);},setTargetAtTime(){},cancelScheduledValues(){}});
function node(){nodes++;const n={connect:(x)=>x||node(),disconnect(){},start(){},stop(){},gain:param(),frequency:param(),detune:param(),playbackRate:param(),Q:param(),delayTime:param(),threshold:param(),ratio:param(),attack:param(),release:param(),
  set type(v){},set buffer(v){},set curve(v){},set oversample(v){},set loop(v){},fftSize:256,frequencyBinCount:128,getByteFrequencyData(){},stream:{}};return n;}
function fakeBuf(ch,len,sr){const d=[...Array(ch)].map(()=>new Float32Array(len));return {numberOfChannels:ch,length:len,sampleRate:sr,duration:len/sr,getChannelData:i=>d[i]};}
class Ctx{constructor(ch,len,sr){this.sampleRate=sr||44100;this.currentTime=0;this.destination=node();this._len=len;this._ch=ch;}
  createGain(){return node();}createBiquadFilter(){return node();}createDynamicsCompressor(){return node();}createAnalyser(){return node();}createMediaStreamDestination(){return node();}
  createDelay(){return node();}createConvolver(){return node();}createWaveShaper(){return node();}createOscillator(){return node();}createBufferSource(){return node();}
  createBuffer(ch,len,sr){return fakeBuf(ch,len,sr);} resume(){return Promise.resolve();}
  startRendering(){const b=fakeBuf(2,this._len,this.sampleRate);const L=b.getChannelData(0),R=b.getChannelData(1);for(let i=0;i<L.length;i++){L[i]=Math.sin(i/20)*0.5;R[i]=Math.cos(i/20)*0.5;}return Promise.resolve(b);}}
class OCtx extends Ctx{constructor(ch,len,sr){super(ch,len,sr);delete this.createMediaStreamDestination;} }
OCtx.prototype.createMediaStreamDestination=undefined;
// ---- stub DOM ----
const els={};const el=id=>els[id]||(els[id]={id,hidden:false,disabled:false,textContent:'',value:'',dataset:{},style:{},children:[],clientWidth:600,width:0,height:0,
  addEventListener(){},setAttribute(){},appendChild(c){this.children.push(c)},add(){},click(){},classList:{toggle(){},add(){},remove(){}},
  getContext:()=>new Proxy({},{get:(t,k)=>k==='globalAlpha'||k==='fillStyle'?undefined:()=>{} ,set:()=>true}),getBoundingClientRect:()=>({left:0,width:600}),querySelector:()=>el('x'),querySelectorAll:()=>[]});
global.document={querySelector:s=>el(s),querySelectorAll:()=>[],createElement:()=>el('c'+Math.random()),getElementById:id=>id==='dspSrc'?{textContent:''}:el(id),documentElement:{}};
global.window={AudioContext:Ctx,OfflineAudioContext:OCtx,addEventListener(){},devicePixelRatio:1};
global.getComputedStyle=()=>({getPropertyValue:()=>'#fff'});global.requestAnimationFrame=()=>{};global.matchMedia=()=>({matches:false});
global.Option=function(){};global.performance={now:()=>0};
const results=[];
eval(appSrc+`
;(async()=>{
  ensureCtx();
  const song=synthSong({bars:24});
  A.buf=fakeBuf(2,song.len,song.sr); A.buf.getChannelData(0).set(song.L); A.buf.getChannelData(1).set(song.R);
  A.peaks=peaks(A.buf); A.title="Synthetic test song";
  const tr=analyse(A.buf); results.push(['tempo detected',tr&&tr.bpm,'truth',song.bpm]);
  A.srcBpm=song.bpm; A.offset=0;
  A.sep=DSP.separate(song.L,song.R,song.sr,{},()=>{}); A.vocRaw=A.sep.vocal;
  regrid();
  const doStretch=()=>{const y=DSP.stretch(A.vocRaw,stretchS());A.voc=fakeBuf(1,y.length,22050);A.voc.getChannelData(0).set(y);A.vocS=stretchS();};
  doStretch();
  results.push(['nBars',A.nBars,'key',keyLabel(),'arr bars',A.arr.bars.length,'blocks',A.arr.blocks.map(b=>b.type+':'+b.len).join(' ')]);
  // expected output duration of the vocal = original/r
  results.push(['vocal stretch ok', Math.abs(A.voc.duration*pitchQ() - A.vocRaw.length/22050/rate()) < 0.2]);
  const _v=vocalAt,_c=chop,_k=kick,_cr=crash; vocalAt=(...a)=>{calls.vocal++;return _v(...a);}; chop=(...a)=>{calls.chop++;return _c(...a);}; kick=(...a)=>{calls.kick++;return _k(...a);}; crash=(...a)=>{calls.crash++;return _cr(...a);};
  for(const k of Object.keys(STYLES)){
    A.style=k; regen(1000+Object.keys(STYLES).indexOf(k)); doStretch(); prevInfo=null; buildStart=-1; lastAcid=null;
    const total=A.arr.bars.length*16; for(let st=0;st<total;st++) playStep(st,0.1+st*0.1);
    A.form="loop"; for(let st=0;st<64;st++) playStep(st,0.1+st*0.1); A.form="full";
    A.harmony="key"; for(let st=0;st<32;st++) playStep(st,0.1+st*0.1); A.harmony="song";
  }
  results.push(['styles run',Object.keys(STYLES).length,'calls',JSON.stringify(calls)]);
  // pitch modes
  for(const p of ["natural","2","-1","tempo"]){A.pitch=p;doStretch();results.push(['pitch',p,'q',pitchQ().toFixed(3),'s',stretchS().toFixed(3),'out dur ok',Math.abs(A.voc.duration/pitchQ()-A.vocRaw.length/22050/rate())<0.2]);}
  A.pitch="natural"; doStretch();
  // arrangement override cycle
  const gi=A.arr.blocks.findIndex(b=>b.type==="groove"); A.overrides[gi]="break"; rearrange(); results.push(['override applied',A.arr.blocks[gi].type]);
  // offline render + wav + zip
  A.style="pawsa"; const buf=await renderOffline(); const wav=wavBytes(buf); const z=zipStore("test.wav",wav);
  require('fs').writeFileSync('/tmp/test.zip',Buffer.from(await z.arrayBuffer()));
  results.push(['render',buf.duration.toFixed(1)+'s','expected',(A.arr.bars.length*barOut()+2.5).toFixed(1)+'s','ctx restored',ctx instanceof Ctx&&!(ctx instanceof OCtx),'rendering flag',rendering]);
  results.push(['nodes created',nodes]);
  results.forEach(r=>console.log(r.join(' ')));
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
`);
