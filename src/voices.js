/* ---------------- Voices ----------------
   Sound-design values come from the current generated beat (A.groove.snd), so each beat has its own kick, clap, hats and bass tone. */
const DEFAULT_SND={kf0:155,kf1:48,kdec:0.38,clapF:1300,hatF:8500,bassCut:1,bassQ:1,verb:0.35,dlyFb:0.35,dlyBeats:0.75};
const SND=()=>(A.groove&&A.groove.snd)||DEFAULT_SND;
function env(gn,t,a,peak,dec){gn.gain.setValueAtTime(0.0001,t);gn.gain.exponentialRampToValueAtTime(peak,t+a);gn.gain.exponentialRampToValueAtTime(0.0001,t+a+dec);}
function noiseSrc(t,dur){const s=ctx.createBufferSource();s.buffer=noise;s.loop=true;s.start(t,Math.random()*0.5);s.stop(t+dur+0.05);return s;}
function kick(t){
  const o=ctx.createOscillator(),gn=ctx.createGain();o.type="sine";
  const k=SND(); o.frequency.setValueAtTime(k.kf0,t);o.frequency.exponentialRampToValueAtTime(k.kf1,t+0.09);
  env(gn,t,0.002,1,k.kdec);o.connect(gn).connect(N.drums);o.start(t);o.stop(t+k.kdec+0.07);
  const c=noiseSrc(t,0.02),cf=ctx.createBiquadFilter(),cg=ctx.createGain();cf.type="highpass";cf.frequency.value=3000;env(cg,t,0.001,0.25,0.012);c.connect(cf).connect(cg).connect(N.drums);
}
function clap(t,v=1){
  const s=noiseSrc(t,0.3),f=ctx.createBiquadFilter(),gn=ctx.createGain();f.type="bandpass";f.frequency.value=SND().clapF;f.Q.value=0.9;
  gn.gain.setValueAtTime(0.0001,t);
  [0,0.011,0.022].forEach(o=>{gn.gain.setValueAtTime(0.75*v,t+o);gn.gain.exponentialRampToValueAtTime(0.08*v,t+o+0.009);});
  gn.gain.setValueAtTime(0.6*v,t+0.031);gn.gain.exponentialRampToValueAtTime(0.0001,t+0.22);
  s.connect(f).connect(gn);gn.connect(N.drums);const sg=ctx.createGain();sg.gain.value=0.25;gn.connect(sg).connect(N.verbIn);
}
function hat(t,open,v=1){
  const s=noiseSrc(t,open?0.3:0.06),f=ctx.createBiquadFilter(),gn=ctx.createGain();f.type="highpass";f.frequency.value=open?SND().hatF-1500:SND().hatF;
  env(gn,t,0.001,(open?0.32:0.18)*v,open?0.22:0.04);s.connect(f).connect(gn).connect(N.drums);
}
function snare(t,v){
  const s=noiseSrc(t,0.12),f=ctx.createBiquadFilter(),gn=ctx.createGain();f.type="bandpass";f.frequency.value=1900;f.Q.value=0.7;
  env(gn,t,0.001,0.08+0.5*v,0.09);s.connect(f).connect(gn).connect(N.drums);
}
function crash(t){
  const s=noiseSrc(t,2),f=ctx.createBiquadFilter(),gn=ctx.createGain();f.type="highpass";f.frequency.value=4500;
  env(gn,t,0.003,0.35,1.8);s.connect(f).connect(gn);gn.connect(N.drums);gn.connect(N.verbIn);
}
function bassNote(t,midi,dur){
  const o=ctx.createOscillator(),sub=ctx.createOscillator(),f=ctx.createBiquadFilter(),gn=ctx.createGain();
  o.type="sawtooth";sub.type="sine";o.frequency.value=mtof(midi);sub.frequency.value=mtof(midi);
  f.type="lowpass";f.Q.value=6*SND().bassQ;f.frequency.setValueAtTime(1100*SND().bassCut,t);f.frequency.exponentialRampToValueAtTime(220,t+dur*0.9);
  gn.gain.setValueAtTime(0.0001,t);gn.gain.exponentialRampToValueAtTime(0.5,t+0.006);gn.gain.setValueAtTime(0.45,t+dur*0.8);gn.gain.exponentialRampToValueAtTime(0.0001,t+dur);
  const sg=ctx.createGain();sg.gain.value=0.6;
  o.connect(f).connect(gn);sub.connect(sg).connect(gn);gn.connect(N.bass);
  o.start(t);sub.start(t);o.stop(t+dur+0.02);sub.stop(t+dur+0.02);
}
function chord(t,notes,dur,tone,dub){
  const f=ctx.createBiquadFilter(),gn=ctx.createGain();f.type="lowpass";
  if(tone==="pad"){f.frequency.value=900;gn.gain.setValueAtTime(0.0001,t);gn.gain.linearRampToValueAtTime(0.16,t+0.25);gn.gain.setValueAtTime(0.16,t+dur-0.2);gn.gain.linearRampToValueAtTime(0.0001,t+dur);}
  else if(tone==="rhodes"){f.frequency.value=2600;env(gn,t,0.004,0.2,dur+0.7);}
  else if(tone==="piano"){f.frequency.setValueAtTime(4000,t);f.frequency.exponentialRampToValueAtTime(900,t+0.4);env(gn,t,0.003,0.22,Math.min(0.9,dur+0.3));}
  else {f.frequency.setValueAtTime(3200,t);f.frequency.exponentialRampToValueAtTime(600,t+0.18);env(gn,t,0.003,0.2,0.2);}
  f.connect(gn);gn.connect(N.chords);const sg=ctx.createGain();sg.gain.value=0.5;gn.connect(sg).connect(N.verbIn);
  if(dub){const dg=ctx.createGain();dg.gain.value=0.9;gn.connect(dg).connect(N.dly);}
  const end=t+dur+1;
  notes.forEach(m=>{
    const types=tone==="pad"?["triangle","sawtooth"]:tone==="piano"?["triangle","square"]:tone==="rhodes"?["sine","triangle"]:["sawtooth","sawtooth"];
    const oct=tone==="piano"||tone==="rhodes";
    types.forEach((ty,i)=>{const o=ctx.createOscillator();o.type=ty;o.frequency.value=mtof(m+(oct&&i?12:0));o.detune.value=i?7:-7;
      const og=ctx.createGain();og.gain.value=(oct&&i)?(tone==="rhodes"?0.07:0.12):0.25;o.connect(og).connect(f);o.start(t);o.stop(end);});
  });
}
function perc(t,type){
  if(type==="snr") return snare(t,0.3);
  if(type==="ride") return ride(t);
  if(type==="tim") return timbale(t);
  if(type==="zap") return zap(t);
  if(type==="rim"){const o=ctx.createOscillator(),f=ctx.createBiquadFilter(),gn=ctx.createGain();o.type="square";o.frequency.value=1750;f.type="bandpass";f.frequency.value=2200;f.Q.value=3;env(gn,t,0.001,0.22,0.03);o.connect(f).connect(gn).connect(N.perc);o.start(t);o.stop(t+0.06);return;}
  const hi=type==="cHi",o=ctx.createOscillator(),gn=ctx.createGain();o.type="sine";
  o.frequency.setValueAtTime(hi?380:240,t);o.frequency.exponentialRampToValueAtTime(hi?300:185,t+0.05);env(gn,t,0.002,0.45,0.2);
  o.connect(gn).connect(N.perc);const sg=ctx.createGain();sg.gain.value=0.2;gn.connect(sg).connect(N.verbIn);o.start(t);o.stop(t+0.3);
}
function ride(t){const s=noiseSrc(t,0.4),f=ctx.createBiquadFilter(),f2=ctx.createBiquadFilter(),gn=ctx.createGain();f.type="highpass";f.frequency.value=5000;f2.type="peaking";f2.frequency.value=7500;f2.gain.value=8;env(gn,t,0.002,0.14,0.35);s.connect(f).connect(f2).connect(gn).connect(N.perc);}
function timbale(t){const o=ctx.createOscillator(),gn=ctx.createGain();o.type="triangle";o.frequency.setValueAtTime(600,t);o.frequency.exponentialRampToValueAtTime(520,t+0.04);env(gn,t,0.001,0.3,0.13);o.connect(gn).connect(N.perc);o.start(t);o.stop(t+0.2);
  const n=noiseSrc(t,0.04),nf=ctx.createBiquadFilter(),ng=ctx.createGain();nf.type="bandpass";nf.frequency.value=3200;env(ng,t,0.001,0.15,0.03);n.connect(nf).connect(ng).connect(N.perc);const sg=ctx.createGain();sg.gain.value=0.25;gn.connect(sg).connect(N.verbIn);}
function zap(t){const o=ctx.createOscillator(),f=ctx.createBiquadFilter(),gn=ctx.createGain();o.type="square";o.frequency.setValueAtTime(1800,t);o.frequency.exponentialRampToValueAtTime(110,t+0.08);f.type="lowpass";f.frequency.value=3000;env(gn,t,0.001,0.14,0.09);o.connect(f).connect(gn).connect(N.perc);o.start(t);o.stop(t+0.12);}
function lead(t,midi,dur,tone){
  const gn=ctx.createGain(),f=ctx.createBiquadFilter(),fq=mtof(midi);f.type="lowpass";
  if(tone==="flute"){
    const o=ctx.createOscillator(),v=ctx.createOscillator(),vg=ctx.createGain();o.type="triangle";o.frequency.value=fq;v.frequency.value=5.5;vg.gain.value=fq*0.006;v.connect(vg).connect(o.frequency);
    f.frequency.value=2400;o.connect(f);v.start(t);v.stop(t+dur+0.1);o.start(t);o.stop(t+dur+0.1);
    const b=noiseSrc(t,dur),bf=ctx.createBiquadFilter(),bg=ctx.createGain();bf.type="bandpass";bf.frequency.value=fq*2;bf.Q.value=4;bg.gain.value=0.08;b.connect(bf).connect(bg).connect(f);
    gn.gain.setValueAtTime(0.0001,t);gn.gain.exponentialRampToValueAtTime(0.24,t+0.03);gn.gain.setValueAtTime(0.22,t+dur*0.8);gn.gain.exponentialRampToValueAtTime(0.0001,t+dur+0.05);
  } else {
    [-8,8].forEach(d=>{const o=ctx.createOscillator();o.type=d<0?"sawtooth":"square";o.frequency.value=fq;o.detune.value=d;o.connect(f);o.start(t);o.stop(t+dur+0.3);});
    f.Q.value=3;f.frequency.setValueAtTime(5000,t);f.frequency.exponentialRampToValueAtTime(1400,t+0.25);env(gn,t,0.005,0.12,dur+0.2);
  }
  f.connect(gn);gn.connect(N.chords);const s=ctx.createGain();s.gain.value=0.4;gn.connect(s);s.connect(N.dly);s.connect(N.verbIn);
}
let driveCurve=null;
function getDrive(){if(!driveCurve){driveCurve=new Float32Array(1024);for(let i=0;i<1024;i++){const x=i/511.5-1;driveCurve[i]=Math.tanh(4*x)/Math.tanh(4);}}return driveCurve;}
function shaker(t,v){const s=noiseSrc(t,0.06),f=ctx.createBiquadFilter(),gn=ctx.createGain();f.type="bandpass";f.frequency.value=6500;f.Q.value=1.2;env(gn,t,0.004,0.13*v,0.045);s.connect(f).connect(gn).connect(N.perc);}
let lastAcid=null;
function bassVoice(type,t,midi,dur,acc,slide){
  if(type==="saw") return bassNote(t,midi,dur);
  const gn=ctx.createGain();gn.connect(N.bass);const fq=mtof(midi);
  if(type==="sub"){const o=ctx.createOscillator();o.type="sine";o.frequency.setValueAtTime(fq*1.5,t);o.frequency.exponentialRampToValueAtTime(fq,t+0.03);
    gn.gain.setValueAtTime(0.0001,t);gn.gain.exponentialRampToValueAtTime(0.75,t+0.008);gn.gain.setValueAtTime(0.7,t+dur*0.7);gn.gain.exponentialRampToValueAtTime(0.0001,t+dur);o.connect(gn);o.start(t);o.stop(t+dur+0.02);return;}
  if(type==="rubber"){const o=ctx.createOscillator(),s2=ctx.createOscillator(),f=ctx.createBiquadFilter(),og=ctx.createGain(),sg=ctx.createGain();
    o.type="square";s2.type="sine";o.frequency.value=fq;s2.frequency.value=fq;f.type="lowpass";f.Q.value=9*SND().bassQ;
    f.frequency.setValueAtTime((acc?1800:900)*SND().bassCut,t);f.frequency.exponentialRampToValueAtTime(160,t+0.09);og.gain.value=0.35;sg.gain.value=0.6;
    o.connect(f).connect(og).connect(gn);s2.connect(sg).connect(gn);env(gn,t,0.003,0.8,Math.max(0.06,dur));o.start(t);s2.start(t);o.stop(t+dur+0.1);s2.stop(t+dur+0.1);return;}
  if(type==="acid"){const o=ctx.createOscillator(),f=ctx.createBiquadFilter();o.type="sawtooth";
    if(slide&&lastAcid){o.frequency.setValueAtTime(lastAcid,t);o.frequency.exponentialRampToValueAtTime(fq,t+0.06);}else o.frequency.value=fq;lastAcid=fq;
    f.type="lowpass";f.Q.value=Math.min(22,16*SND().bassQ);f.frequency.setValueAtTime((acc?2600:900)*SND().bassCut,t);f.frequency.exponentialRampToValueAtTime(220,t+0.16);
    o.connect(f).connect(gn);env(gn,t,0.003,acc?0.42:0.3,Math.max(0.08,dur*1.1));o.start(t);o.stop(t+dur+0.2);return;}
  if(type==="reese"){const f=ctx.createBiquadFilter(),lfo=ctx.createOscillator(),lg=ctx.createGain(),end=t+dur+0.05;
    f.type="lowpass";f.Q.value=4;f.frequency.value=650*SND().bassCut;lfo.frequency.value=A.target/60*2;lg.gain.value=450;lfo.connect(lg).connect(f.frequency);
    [-14,14].forEach(d=>{const o=ctx.createOscillator(),og=ctx.createGain();o.type="sawtooth";o.frequency.value=fq;o.detune.value=d;og.gain.value=0.22;o.connect(og).connect(f);o.start(t);o.stop(end);});
    const s=ctx.createOscillator(),sg=ctx.createGain();s.type="sine";s.frequency.value=fq;sg.gain.value=0.45;s.connect(sg).connect(gn);s.start(t);s.stop(end);
    f.connect(gn);lfo.start(t);lfo.stop(end);
    gn.gain.setValueAtTime(0.0001,t);gn.gain.exponentialRampToValueAtTime(0.7,t+0.01);gn.gain.setValueAtTime(0.65,t+dur*0.85);gn.gain.exponentialRampToValueAtTime(0.0001,t+dur);}
}
