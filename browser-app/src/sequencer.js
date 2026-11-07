/* ---------------- Vocal, chops, pump ---------------- */
function vocalAt(t,songBar,bars){
  if(!A.voc) return;
  const s=stretchS(),q=pitchQ(),bo=(A.offset+songBar*barSong())*s,dur=bars*barOut();
  if(bo>=A.voc.duration) return;
  const src=ctx.createBufferSource(),gn=ctx.createGain();src.buffer=A.voc;src.playbackRate.value=q;
  gn.gain.setValueAtTime(0,t);gn.gain.linearRampToValueAtTime(1,t+0.006);gn.gain.setValueAtTime(1,t+dur-0.02);gn.gain.linearRampToValueAtTime(0,t+dur);
  src.connect(gn).connect(N.voxIn);src.start(t,bo);src.stop(t+dur+0.02);
  if(!rendering){live.push(src);if(live.length>64)live.splice(0,live.length-64);}
}
function chop(t,slice,dur){
  if(!A.voc) return;
  const G=A.groove||STYLES[A.style], hooks=A.arr&&A.arr.hooks&&A.arr.hooks.length?A.arr.hooks:[A.arr?A.arr.hookBar:0];
  const s=stretchS(),q=pitchQ(),hb=A.form==="loop"?A.secBar:hooks[Math.min(G.hookRank||0,hooks.length-1)];
  const bo=(A.offset+hb*barSong()+slice*barSong()/8)*s; if(bo>=A.voc.duration-0.05) return;
  const src=ctx.createBufferSource(),gn=ctx.createGain();src.buffer=A.voc;src.playbackRate.value=q;
  gn.gain.setValueAtTime(0.0001,t);gn.gain.exponentialRampToValueAtTime(1.3,t+0.004);gn.gain.setValueAtTime(1.3,t+dur*0.8);gn.gain.exponentialRampToValueAtTime(0.0001,t+dur);
  if(G.chopDrive){const ws=ctx.createWaveShaper();ws.curve=getDrive();ws.oversample="2x";const pre=ctx.createGain();pre.gain.value=2.2;src.connect(pre).connect(ws).connect(gn);} else src.connect(gn);
  gn.connect(N.chopIn);src.start(t,bo);src.stop(t+dur+0.02);
}
function duck(t){
  const d=A.mix.pump,b=60/A.target;
  N.duckB.gain.cancelScheduledValues(t);N.duckB.gain.setValueAtTime(1-d,t);N.duckB.gain.setTargetAtTime(1,t+0.02,b*0.16);
  N.duckA.gain.cancelScheduledValues(t);N.duckA.gain.setValueAtTime(1-d*0.35,t);N.duckA.gain.setTargetAtTime(1,t+0.02,b*0.16);
}

/* ---------------- Arrangement lookup ----------------
   Returns what output bar `bar` should be: {type, songBar, chord, build, runLen}. null = past the end. */
function barInfo(bar){
  if(!hasRework()) return {type:breakdown?"break":"drop",songBar:-1,chord:null,build:false,runLen:0};
  if(A.form==="loop"){
    const k=bar%A.loopBars,sb=A.secBar+k;
    return {type:breakdown?"break":"drop",songBar:sb,chord:A.chords[Math.min(sb,A.chords.length-1)],build:false,runLen:k===0?A.loopBars:0};
  }
  const b=A.arr.bars[bar]; if(!b) return null;
  const run=A.arr.runs.find(r=>r.outStart===bar);
  return {type:breakdown&&b.type!=="intro"&&b.type!=="outro"?"break":b.type,songBar:b.songBar,chord:b.chord,build:b.build,runLen:run?run.len:0,runSong:run?run.songStart:0,
    pos:bar-(A.arr.blocks[b.block]?A.arr.blocks[b.block].start:0)};
}
function harmonyAt(info){
  // returns {root, qual}: the song's chord (transposed with the vocal) or the fixed key progression
  if(info&&info.chord&&A.harmony==="song"){return {root:((info.chord.pc+shiftSemis())%12+12)%12,qual:info.chord.q==="min"?"m7":"M7"};}
  return null;
}
function keyPc(){ return (A.songKey&&A.harmony==="song")? ((A.songKey.pc+shiftSemis())%12+12)%12 : A.key; }
function keyMajor(){ return (A.songKey&&A.harmony==="song")? A.songKey.mode==="major" : A.mode==="major"; }

/* ---------------- Sequencer ---------------- */
function playStep(st,t0){
  const S=A.groove||STYLES[A.style],bar=Math.floor(st/16),s=st%16,sp=60/A.target/4,t=(s%2)?t0+S.swing*sp:t0;
  const info=barInfo(bar);
  if(!info){ if(!rendering&&!endTimer) endTimer=setTimeout(()=>{endTimer=null;stop();},Math.max(0,(t0-ctx.currentTime)*1000+400)); return; }
  const T=info.type;
  // vocal audio for this bar's run
  if(s===0&&info.runLen) vocalAt(t0,A.form==="loop"?info.songBar:info.runSong,info.runLen);
  // automatic build (from the arrangement) and drop
  if(s===0){
    if(info.build&&!(prevInfo&&prevInfo.build)){N.hp.frequency.cancelScheduledValues(t0);N.hp.frequency.setValueAtTime(20,t0);N.hp.frequency.exponentialRampToValueAtTime(1400,t0+2*barOut());}
    if(T==="drop"&&prevInfo&&(prevInfo.build||prevInfo.type!=="drop")){N.hp.frequency.cancelScheduledValues(t0);N.hp.frequency.setValueAtTime(20,t0);crash(t0);}
    N.voxDly.gain.setValueAtTime(T==="drop"||T==="break"?0.28:0.08,t0);
    prevInfo=info;
  }
  // manual Build & drop button
  if(buildStart>=0 && st===buildStart){N.hp.frequency.cancelScheduledValues(t0);N.hp.frequency.setValueAtTime(20,t0);N.hp.frequency.exponentialRampToValueAtTime(1600,t0+32*sp);}
  if(buildStart>=0 && st===buildStart+32){N.hp.frequency.cancelScheduledValues(t0);N.hp.frequency.setValueAtTime(20,t0);crash(t0);buildStart=-1;}
  const inBuild=(buildStart>=0 && st>=buildStart)||info.build;
  if(inBuild){
    const manual=buildStart>=0&&st>=buildStart, pb=bar>0?barInfo(bar-1):null;
    const k=manual?st-buildStart:((pb&&pb.build)?16+s:s), v=k/32;
    if(k<16? s%2===0 : true) snare(t0,v);
  }
  const pos=info.pos||0;
  const kickOn=!inBuild&&T!=="break"&&!(T==="outro"&&pos>=A.outro-2);
  const bassOn=!inBuild&&(T==="groove"||T==="drop"||(T==="intro"&&pos>=Math.max(0,A.intro-4))||(T==="outro"&&pos<4));
  const clapOn=!inBuild&&T!=="break"&&!(T==="intro"&&pos<4);
  const chordsOn=T==="drop"||T==="break"||(!hasRework());
  if(s%4===0&&kickOn){kick(t0);duck(t0);}
  if(!inBuild){
    if(clapOn&&S.clap.includes(s)) clap(t);
    if(S.open.includes(s)&&!(T==="intro"&&pos<2)) hat(t,true,T==="break"?0.5:1);
    if(T!=="break"){
      if(S.hat.includes(s)) hat(t,false,s%2?0.9:0.5);
      if(S.hat2&&S.hat2.includes(s)) hat(t+sp/2,false,0.45);
      if(S.shaker.includes(s)) shaker(t,s%4===2?1:0.6);
      S.perc.forEach(([ps,ty])=>{if(ps===s) perc(t,ty);});
      if(T==="drop"&&S.dropPerc) S.dropPerc.forEach(([ps,ty])=>{if(ps===s) perc(t,ty);});
    }
    if(S.fill && kickOn && T!=="intro" && bar%8===7 && s>=12 && !info.build) snare(t,(s-11)/4);
  }
  const h=harmonyAt(info);
  const root=h?h.root:(A.key+PROG[A.mode][bar%4][0])%12, qual=h?h.qual:PROG[A.mode][bar%4][1];
  let notes=QUAL[qual].map(i=>55+((root+5)%12)-5+i);
  for(let k=0;k<(S.inv||0);k++){notes=notes.slice(1).concat(notes[0]+12);} // generated chord voicing
  const bn=(S.bass.notesB&&bar%2===1)?S.bass.notesB:S.bass.notes, majorChord=qual!=="m7";
  if(bassOn) bn.forEach(([bs,iv,len,acc,sl])=>{if(bs===s){ let x=iv; if(majorChord&&((iv%12)+12)%12===3) x=iv+1; bassVoice(S.bass.type,t,36+root+x,len*sp*0.95,acc,sl);}});
  if(T==="break"){ if(s===0) chord(t,notes,16*sp,"pad"); }
  else if(chordsOn&&S.chords) S.chords.hits.forEach(([cs,len])=>{if(cs===s) chord(t,notes,len*sp,S.chords.tone,S.chords.dub);});
  if(S.lead && !inBuild && (T==="drop"||!hasRework())){const ev=S.lead.every||1; if(bar%ev===ev-1) S.lead.notes.forEach(([ls,iv,len])=>{if(ls===s){
    let x=iv; if(keyMajor()){ const m=((iv%12)+12)%12; if(m===3||m===8) x=iv+1; }
    lead(t,60+((keyPc()+5)%12)-5+x,len*sp,S.lead.tone);}});}
  if(S.arp&&chordsOn&&T!=="break"){const k=S.arp.indexOf(s); if(k>=0) chord(t,[notes[k%4]+12],sp*1.5,"stab");}
  if(S.chops && !inBuild && (T==="drop"||A.form==="loop")) S.chops.forEach(([cs,sl,len])=>{if(cs===s) chop(t,sl,len*sp*0.9);});
  if(!rendering) lights.push({s,t:t0});
}
function schedule(){const sp=60/A.target/4;while(nextTime<ctx.currentTime+0.15){playStep(step,nextTime);nextTime+=sp;step++;}}
async function start(){
  if(A.busy) return;
  ensureCtx(); try{await ctx.resume();}catch(e){} applyMix(); lastAcid=null; prevInfo=null;
  const t=ctx.currentTime+0.12; step=0; nextTime=t; T0=t; lights=[];
  N.duckA.gain.cancelScheduledValues(0);N.duckA.gain.value=1;N.duckB.gain.cancelScheduledValues(0);N.duckB.gain.value=1;
  N.hp.frequency.cancelScheduledValues(0);N.hp.frequency.value=20;
  schedule(); timer=setInterval(schedule,25); playing=true; ui();
}
function stop(){
  clearInterval(timer);timer=null; if(endTimer){clearTimeout(endTimer);endTimer=null;}
  live.forEach(n=>{try{n.stop();}catch(e){}}); live=[];
  if(ctx){N.hp.frequency.cancelScheduledValues(0);N.hp.frequency.value=20;}
  buildStart=-1; playing=false; ui();
}
function restart(){ if(playing){stop();start();} else ui(); }
