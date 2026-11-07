// Builds a synthetic stereo "song" with known parts, for testing separation, chords and stretch.
// vocal: centred harmonic voice with vibrato, phrased (on/off); keys: chords panned hard L/R; drums: centred kick+hat.
function synthSong({sr=22050, bpm=100, bars=16, seed=1}={}){
  let s=seed; const rnd=()=>{s=(s*16807)%2147483647; return s/2147483647;};
  const beat=60/bpm, bar=4*beat, len=Math.floor(bars*bar*sr)+sr;
  const L=new Float32Array(len), R=new Float32Array(len), V=new Float32Array(len);
  const prog=[[0,"maj"],[9,"min"],[5,"maj"],[7,"maj"]]; // C Am F G
  const mtof=m=>440*Math.pow(2,(m-69)/12);
  for(let b=0;b<bars;b++){
    const [root,q]=prog[b%4], tri=[0,q==="maj"?4:3,7];
    const t0=Math.floor(b*bar*sr), t1=Math.floor((b+1)*bar*sr);
    // keys: hard-panned chord tones (L gets root+third, R gets fifth+root octave)
    for(let i=t0;i<t1;i++){const t=(i-t0)/sr, e=Math.exp(-t*1.5)*0.12;
      L[i]+=e*(Math.sin(2*Math.PI*mtof(48+root+tri[0])*t)+Math.sin(2*Math.PI*mtof(48+root+tri[1])*t));
      R[i]+=e*(Math.sin(2*Math.PI*mtof(48+root+tri[2])*t)+Math.sin(2*Math.PI*mtof(60+root)*t));}
    // vocal: sings chord tones, phrased: bars 4-7 and 10-15 (others silent)
    const sing=(b>=4&&b<8)||(b>=10);
    if(sing) for(let n=0;n<4;n++){const ns=Math.floor((b*bar+n*beat)*sr), ne=ns+Math.floor(beat*0.9*sr), f0=mtof(60+root+tri[n%3]);
      let ph=0; for(let i=ns;i<ne;i++){const t=(i-ns)/sr, f=f0*(1+0.01*Math.sin(2*Math.PI*5.5*t)); ph+=2*Math.PI*f/sr;
        const env=Math.min(1,t/0.03)*Math.min(1,(ne-i)/sr/0.05); let v=0; for(let h=1;h<=6;h++) v+=Math.sin(h*ph)/h; v*=0.18*env; V[i]+=v; L[i]+=v; R[i]+=v;}}
    // drums: kick each beat, hat each offbeat (centred)
    for(let n=0;n<4;n++){const ks=Math.floor((b*bar+n*beat)*sr); for(let i=0;i<sr*0.25&&ks+i<len;i++){const t=i/sr, v=0.5*Math.sin(2*Math.PI*(50+100*Math.exp(-t*30))*t)*Math.exp(-t*12); L[ks+i]+=v;R[ks+i]+=v;}
      const hs=Math.floor((b*bar+(n+0.5)*beat)*sr); for(let i=0;i<sr*0.04&&hs+i<len;i++){const v=(rnd()*2-1)*0.12*Math.exp(-i/sr*90); L[hs+i]+=v;R[hs+i]+=v;}}
  }
  return {L,R,V,sr,bpm,bars,prog,len};
}
module.exports={synthSong};
