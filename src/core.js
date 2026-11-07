/* ---------------- Shared core: tempo detection, offline render, WAV + zip ----------------
   Used by the browser app and by the server render worker. No DOM access. */
function analyse(buf){
  const sr=buf.sampleRate,hop=256,c0=buf.getChannelData(0),c1=buf.numberOfChannels>1?buf.getChannelData(1):c0;
  const dur=buf.duration,st=dur>110?20:0,len=Math.min(90,dur-st);
  const i0=Math.floor(st*sr),F=Math.floor(len*sr/hop); if(F<200) return null;
  const a=1-Math.exp(-2*Math.PI*180/sr),env=new Float32Array(F);let y=0;
  for(let f=0;f<F;f++){let e=0;const b=i0+f*hop;for(let k=0;k<hop;k++){const x=(c0[b+k]+c1[b+k])*0.5;y+=a*(x-y);e+=y*y;}env[f]=Math.log(1+1000*e);}
  const o=new Float32Array(F);for(let f=1;f<F;f++)o[f]=Math.max(0,env[f]-env[f-1]);
  const fr=sr/hop,ip=x=>{const i=x|0,q=x-i;return i+1<F?o[i]*(1-q)+o[i+1]*q:0;};
  const score=bpm=>{const p=60*fr/bpm,lim=F-2*p-2;let s=0;for(let i=0;i<lim;i++){if(o[i]) s+=o[i]*(ip(i+p)+0.5*ip(i+2*p));}return s/lim;};
  let best=-1,bb=120;
  for(let b=78;b<=160;b+=0.5){const s=score(b);if(s>best){best=s;bb=b;}}
  const os=new Float32Array(F);for(let f=1;f<F-1;f++)os[f]=0.5*o[f]+0.25*(o[f-1]+o[f+1]);
  const comb=bpm=>{const p=60*fr/bpm;let bs=-1,bp=0;for(let ph=0;ph<p;ph+=1){let s=0;for(let x=ph;x<F-1;x+=p){const i=x|0,q=x-i;s+=os[i]*(1-q)+os[i+1]*q;}if(s>bs){bs=s;bp=ph;}}return [bs,bp];};
  let fine=bb,bp=0;best=-1;for(let b=bb-1.5;b<=bb+1.5;b+=0.02){const [s,ph]=comb(b);if(s>best){best=s;fine=b;bp=ph;}}
  if(Math.abs(fine-Math.round(fine))<0.06){fine=Math.round(fine);bp=comb(fine)[1];}
  const beat=60/fine,offAbs=st+bp/fr;
  return {bpm:Math.round(fine*10)/10,offset:((offAbs%beat)+beat)%beat};
}
async function renderOffline(){
  const bars=A.form==="loop"?A.loopBars*Math.max(1,Math.ceil(32/A.loopBars)):A.arr.bars.length;
  const SR=44100,dur=bars*barOut()+2.5;
  const OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext, off=new OAC(2,Math.ceil(dur*SR),SR);
  const saved={ctx,N,noise,lastAcid,prevInfo,buildStart,breakdown};
  ctx=off;N={};rendering=true;buildStart=-1;breakdown=false;lastAcid=null;prevInfo=null;
  let out;
  try{ reseedNoise(A.seed||1); buildGraph(); const sp=60/A.target/4; for(let st=0;st<bars*16;st++) playStep(st,0.05+st*sp); out=await off.startRendering(); }
  finally{ ({ctx,N,noise,lastAcid,prevInfo,buildStart,breakdown}=saved); rendering=false; }
  return out;
}
function wavBytes(buf){
  const ch=2,sr=buf.sampleRate,n=buf.length,L=buf.getChannelData(0),R=buf.numberOfChannels>1?buf.getChannelData(1):L;
  let peak=0;for(let i=0;i<n;i++){peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i]));}
  const gain=peak>0.98?0.98/peak:1, dv=new DataView(new ArrayBuffer(44+n*4)), ws=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
  ws(0,"RIFF");dv.setUint32(4,36+n*4,true);ws(8,"WAVE");ws(12,"fmt ");dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,ch,true);
  dv.setUint32(24,sr,true);dv.setUint32(28,sr*4,true);dv.setUint16(32,4,true);dv.setUint16(34,16,true);ws(36,"data");dv.setUint32(40,n*4,true);
  for(let i=0,o=44;i<n;i++,o+=4){dv.setInt16(o,Math.max(-1,Math.min(1,L[i]*gain))*32767,true);dv.setInt16(o+2,Math.max(-1,Math.min(1,R[i]*gain))*32767,true);}
  return new Uint8Array(dv.buffer);
}
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(u){let c=0xFFFFFFFF;for(let i=0;i<u.length;i++)c=CRC[(c^u[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function zipStore(name,data){
  const nm=new TextEncoder().encode(name),crc=crc32(data),sz=data.length;
  const lh=new DataView(new ArrayBuffer(30)),cd=new DataView(new ArrayBuffer(46)),ed=new DataView(new ArrayBuffer(22));
  lh.setUint32(0,0x04034b50,true);lh.setUint16(4,20,true);lh.setUint32(14,crc,true);lh.setUint32(18,sz,true);lh.setUint32(22,sz,true);lh.setUint16(26,nm.length,true);
  cd.setUint32(0,0x02014b50,true);cd.setUint16(4,20,true);cd.setUint16(6,20,true);cd.setUint32(16,crc,true);cd.setUint32(20,sz,true);cd.setUint32(24,sz,true);cd.setUint16(28,nm.length,true);
  const cdOff=30+nm.length+sz;
  ed.setUint32(0,0x06054b50,true);ed.setUint16(8,1,true);ed.setUint16(10,1,true);ed.setUint32(12,46+nm.length,true);ed.setUint32(16,cdOff,true);
  return new Blob([lh.buffer,nm,data,cd.buffer,nm,ed.buffer],{type:"application/zip"});
}
