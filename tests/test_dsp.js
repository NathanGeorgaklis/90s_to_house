const DSP=require('../src/dsp-worker.js'); const {synthSong}=require('./synth_song.js');
const song=synthSong({}); const t0=Date.now();
const r=DSP.separate(song.L,song.R,song.sr,{},()=>{}); const tSep=Date.now()-t0;
// quality: correlation of estimate with true vocal; leakage = energy of estimate where true vocal is silent vs where singing
const V=song.V, E=r.vocal; let vv=0,ee=0,ve=0; for(let i=0;i<V.length;i++){vv+=V[i]*V[i];ee+=E[i]*E[i];ve+=V[i]*E[i];}
const corr=ve/Math.sqrt(vv*ee);
const bar=4*60/song.bpm*song.sr; let eSil=0,eSing=0,nSil=0,nSing=0;
for(let b=0;b<song.bars;b++){const sing=(b>=4&&b<8)||(b>=10);for(let i=Math.floor(b*bar);i<Math.floor((b+1)*bar);i++){if(sing){eSing+=E[i]*E[i];nSing++;}else{eSil+=E[i]*E[i];nSil++;}}}
const leakDb=10*Math.log10((eSil/nSil)/(eSing/nSing));
// mix-vs-estimate baseline: correlation of raw mid with vocal
let mm=0,vm=0;for(let i=0;i<V.length;i++){const m=(song.L[i]+song.R[i])/2;mm+=m*m;vm+=V[i]*m;} const corrMix=vm/Math.sqrt(vv*mm);
console.log(JSON.stringify({sepMs:tSep,mono:r.mono,corrVocal:+corr.toFixed(3),corrRawMix:+corrMix.toFixed(3),leakageDb:+leakDb.toFixed(1)}));
// stretch: duration and pitch preserved (zero-crossing rate of a steady tone)
const sr=22050,tone=new Float32Array(sr*2);for(let i=0;i<tone.length;i++)tone[i]=Math.sin(2*Math.PI*220*i/sr);
const zc=x=>{let z=0;for(let i=1;i<x.length;i++)if((x[i-1]<0)!==(x[i]<0))z++;return z/2/(x.length/sr);};
for(const s of [0.8,1.25]){const t=Date.now();const y=DSP.stretch(tone,s);console.log(JSON.stringify({s,lenRatio:+(y.length/tone.length).toFixed(3),pitchHz:+zc(y.subarray(2048,y.length-2048)).toFixed(1),ms:Date.now()-t}));}
const t2=Date.now();DSP.stretch(new Float32Array(sr*180).map(()=>Math.random()-.5),1.27);console.log('stretch 3min ms',Date.now()-t2);
module.exports={r,song};
