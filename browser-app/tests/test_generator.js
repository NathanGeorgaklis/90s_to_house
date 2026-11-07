// Validity + uniqueness of generated beats across all styles.
const fs=require('fs'),Gen=require('../src/generator.js');
const html=fs.readFileSync(__dirname+'/../index.html','utf8'),js=html.match(/<script>\n"use strict";([\s\S]*?)<\/script>/)[1];
const STYLES=eval(js.slice(js.indexOf('const ALL16'),js.indexOf('const PROG='))+';STYLES');
const isStep=s=>Number.isInteger(s)&&s>=0&&s<16;
let problems=[],sigs={},n=0;
for(const [k,T] of Object.entries(STYLES)){
  const seen=new Set();
  for(let i=0;i<200;i++){
    const seed=(i*2654435761)>>>0, g=Gen.generate(T,seed); n++;
    const check=(ok,what)=>{if(!ok)problems.push(k+' seed '+seed+': '+what);};
    [g.hat,g.open,g.clap,g.shaker,g.hat2].forEach(a=>check(a.every(isStep),'bad drum step'));
    check(g.perc.every(([s,t])=>isStep(s)&&typeof t==='string'),'bad perc');
    for(const notes of [g.bass.notes,g.bass.notesB]) check(notes.length>0&&notes.every(([s,iv,len])=>isStep(s)&&Number.isFinite(iv)&&len>=1),'bad bass');
    if(g.chords) check(g.chords.hits.every(([s,l])=>isStep(s)&&l>=1),'bad chords');
    if(g.chops) check(g.chops.every(([s,sl,l])=>isStep(s)&&sl>=0&&sl<=7&&l>=1),'bad chops');
    check(Object.values(g.snd).every(Number.isFinite),'bad sound');
    check(g.bpm>=T.bpm-2&&g.bpm<=T.bpm+2,'bpm out of style range');
    // the style's percussion palette is kept
    const tp=new Set(T.perc.map(p=>p[1])); if(tp.size) check(g.perc.every(p=>tp.has(p[1])),'perc outside palette');
    seen.add(JSON.stringify([g.hat,g.perc,g.bass.notes,g.chords&&g.chords.hits,g.chops]));
    // determinism
    if(i<3) check(JSON.stringify(Gen.generate(T,seed))===JSON.stringify(g),'not deterministic');
  }
  sigs[k]=seen.size;
}
console.log('beats generated',n,'| problems',problems.length,problems.slice(0,5));
console.log('distinct patterns per 200 seeds:',JSON.stringify(sigs));
// two PAWSA-style reworks: how different are their basslines and percussion?
const a=Gen.generate(STYLES.pawsa,111),b=Gen.generate(STYLES.pawsa,222);
const fmt=g=>'bass '+g.bass.type+' '+g.bass.notes.map(n=>n[0]).join(',')+' | perc '+g.perc.map(p=>p[0]+p[1]).join(',')+' | chops '+(g.chops||[]).map(c=>c[0]).join(',')+' | '+g.bpm+'bpm swing '+g.swing;
console.log('PAWSA beat A:',fmt(a)); console.log('PAWSA beat B:',fmt(b));
