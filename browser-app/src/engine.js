/* ---------------- State ---------------- */
const A={buf:null,srcBpm:null,offset:0,target:127,style:"peak",key:9,mode:"minor",
  mix:{vox:.9,low:.25,drums:.8,perc:.7,bass:.6,chords:.4,chops:.6,pump:.7,filt:1},
  title:null,pending:null,peaks:null,
  acap:false,sep:null,vocRaw:null,voc:null,vocS:null,pitch:"natural",
  chords:null,songKey:null,va:null,nBars:0,arr:null,overrides:{},intro:8,outro:8,trim:true,
  form:"full",secBar:0,loopBars:4,harmony:"song",busy:false};
let ctx=null,N={},noise=null,playing=false,timer=null,step=0,nextTime=0,buildStart=-1,breakdown=false;
let T0=0,lights=[],live=[],prevInfo=null,endTimer=null,rendering=false;

/* ---------------- Seeded noise ----------------
   Hi-hats, claps and reverb use noise. A seeded generator makes an offline render bit-identical for the same
   beat code, so evaluation runs can be compared exactly. */
let noiseState=1;
function R(){noiseState=(noiseState+0x6D2B79F5)|0;let t=Math.imul(noiseState^(noiseState>>>15),1|noiseState);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}
function reseedNoise(s){noiseState=(s>>>0)||1;}

/* ---------------- Timing helpers ----------------
   song time τ (seconds in the original file) → vocal buffer time τ·s, played at rate q → output time τ/r.  */
function rate(){return A.srcBpm? A.target/A.srcBpm : 1;}
function barSong(){return 4*60/(A.srcBpm||120);}
function barOut(){return 4*60/A.target;}
function pitchQ(){ if(A.pitch==="tempo") return rate(); return Math.pow(2,(+A.pitch||0)/12); }
function stretchS(){ return A.pitch==="tempo"?1:pitchQ()/rate(); }
function shiftSemis(){ return Math.round(12*Math.log2(pitchQ())); }
function hasRework(){ return !!(A.voc&&A.arr&&A.chords); }

/* ---------------- Audio graph ---------------- */
function buildGraph(){
  const g=()=>ctx.createGain();
  N.master=g(); N.lp=ctx.createBiquadFilter(); N.lp.type="lowpass"; N.lp.Q.value=0.7;
  N.hp=ctx.createBiquadFilter(); N.hp.type="highpass"; N.hp.frequency.value=20;
  N.comp=ctx.createDynamicsCompressor(); N.comp.threshold.value=-10; N.comp.ratio.value=4; N.comp.attack.value=0.005; N.comp.release.value=0.15;
  N.out=g(); N.out.gain.value=0.9;
  N.master.connect(N.hp).connect(N.lp).connect(N.comp).connect(N.out); N.out.connect(ctx.destination);
  if(!rendering){N.an=ctx.createAnalyser(); N.an.fftSize=256; N.an.smoothingTimeConstant=0.75; N.out.connect(N.an);
    N.rec=ctx.createMediaStreamDestination? ctx.createMediaStreamDestination():null; if(N.rec) N.out.connect(N.rec);}
  // extracted vocal: low cut -> compressor -> level -> light pump -> master, with reverb + echo sends
  N.voxIn=g(); N.voxHP=ctx.createBiquadFilter(); N.voxHP.type="highpass"; N.voxHP.Q.value=0.7;
  N.voxComp=ctx.createDynamicsCompressor(); N.voxComp.threshold.value=-20; N.voxComp.ratio.value=3; N.voxComp.attack.value=0.004; N.voxComp.release.value=0.12;
  N.voxG=g(); N.duckA=g();
  N.voxIn.connect(N.voxHP).connect(N.voxComp).connect(N.voxG).connect(N.duckA).connect(N.master);
  N.drums=g(); N.drums.connect(N.master);
  N.duckB=g(); N.duckB.connect(N.master);
  N.bass=g(); N.bass.connect(N.duckB); N.chords=g(); N.chords.connect(N.duckB);
  N.perc=g(); N.perc.connect(N.drums);
  N.chopIn=g(); N.chopHP=ctx.createBiquadFilter(); N.chopHP.type="highpass"; N.chopHP.frequency.value=250; N.chopG=g();
  N.chopIn.connect(N.chopHP).connect(N.chopG).connect(N.duckB);
  N.dly=ctx.createDelay(2); N.dlyFb=g(); N.dlyFb.gain.value=0.35; N.dlyLP=ctx.createBiquadFilter(); N.dlyLP.type="lowpass"; N.dlyLP.frequency.value=3000; N.dlyOut=g(); N.dlyOut.gain.value=0.3;
  N.chopG.connect(N.dly); N.dly.connect(N.dlyLP).connect(N.dlyFb).connect(N.dly); N.dlyLP.connect(N.dlyOut).connect(N.duckB);
  N.verb=ctx.createConvolver(); N.verb.buffer=impulse(2.2); N.verbIn=g(); N.verbIn.gain.value=0.35; N.verbIn.connect(N.verb).connect(N.duckB);
  N.voxVerb=g(); N.voxVerb.gain.value=0.22; N.voxG.connect(N.voxVerb).connect(N.verbIn);
  N.voxDly=g(); N.voxDly.gain.value=0; N.voxG.connect(N.voxDly).connect(N.dly);
  noise=ctx.createBuffer(1,ctx.sampleRate,ctx.sampleRate); const d=noise.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=R()*2-1;
  applyMix();
}
function ensureCtx(){ if(ctx) return ctx; const AC=window.AudioContext||window.webkitAudioContext; ctx=new AC(); buildGraph(); return ctx; }
function impulse(sec){const sr=ctx.sampleRate,len=Math.floor(sr*sec),b=ctx.createBuffer(2,len,sr);for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<len;i++)d[i]=(R()*2-1)*Math.pow(1-i/len,3);}return b;}
function applyMix(){
  const m=A.mix; if(!ctx) return; const t=ctx.currentTime;
  N.voxG.gain.setTargetAtTime(m.vox,t,0.02);
  N.voxHP.frequency.setTargetAtTime(60*Math.pow(10,m.low),t,0.02); // 60 Hz to 600 Hz
  N.drums.gain.setTargetAtTime(m.drums,t,0.02);
  N.bass.gain.setTargetAtTime(m.bass*0.9,t,0.02);
  N.chords.gain.setTargetAtTime(m.chords*0.5,t,0.02);
  N.perc.gain.setTargetAtTime(m.perc,t,0.02);
  N.chopG.gain.setTargetAtTime(m.chops,t,0.02);
  const snd=SND(); N.dly.delayTime.setTargetAtTime(snd.dlyBeats*60/A.target,t,0.02); N.dlyFb.gain.setTargetAtTime(snd.dlyFb,t,0.02); N.verbIn.gain.setTargetAtTime(snd.verb,t,0.02);
  N.lp.frequency.setTargetAtTime(250*Math.pow(80,m.filt),t,0.03); // 250 Hz to 20 kHz
}
