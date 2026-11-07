// Regression: the analysis must find which beat starts the bar (downbeat), not just the beat phase.
// Ground truth comes from the generator: first downbeat at `lead` seconds.
const DSP=require('../src/dsp-worker.js'),An=require('../src/analysis.js'),{synthSong}=require('./synth_song.js');
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../src/core.js','utf8');
const analyse=eval('('+src.slice(src.indexOf('function analyse('),src.indexOf('async function renderOffline'))+')');
const cases=[
  {bpm:100,lead:0},{bpm:118,lead:0},{bpm:124,lead:0.35},{bpm:96,lead:1.1},{bpm:110,lead:0.62,snare:true},
  {bpm:126,lead:0.2,snare:true,chordEvery:2},{bpm:92,lead:2.0,snare:true},{bpm:120,lead:0.5+60/120}];
let pass=0;const rows=[];
for(const c of cases){
  const song=synthSong({sr:22050,bars:24,...c});
  const buf={sampleRate:22050,duration:song.len/22050,numberOfChannels:2,getChannelData:i=>i?song.R:song.L};
  const tempo=analyse(buf);
  const sep=DSP.separate(song.L,song.R,22050,{},()=>{});
  const bar=4*60/c.bpm, truth=c.lead%bar;
  const got=An.detectDownbeat?An.detectDownbeat(sep,tempo,22050).offset:tempo.offset;
  let err=((got-truth)%bar+bar)%bar; err=Math.min(err,bar-err);
  const ok=err*1000<=60; if(ok)pass++;
  rows.push(`${ok?'PASS':'FAIL'} bpm ${c.bpm} lead ${c.lead.toFixed(2)}${c.snare?' snare':''}${c.chordEvery?' chords/'+c.chordEvery:''}: truth ${truth.toFixed(3)} got ${got.toFixed(3)} err ${(err*1000).toFixed(0)} ms`);
}
console.log(rows.join('\n'));console.log(`downbeat: ${pass}/${cases.length} within 60 ms`);
process.exit(pass===cases.length?0:1);
