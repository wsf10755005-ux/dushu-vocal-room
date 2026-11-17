import {noteName} from './audio.js';

const finite=Number.isFinite;
const DEGREES=[1,1,2,2,3,4,4,5,5,6,6,7];
const SHARPS=new Set([1,3,6,8,10]);
const MAJOR=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const mod=(value,base)=>((value%base)+base)%base;
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function tonicValue(tonic){if(!finite(tonic)||!Number.isInteger(tonic)||tonic<0||tonic>127)throw new Error('簡譜調性必須是有效的整數音高。');return tonic;}

/** Degrees use a movable major-do scale. 1=C4 means tonic MIDI60. Chromatic
 * notes keep their sharp, octave dots become apostrophes/commas in plain text,
 * and cents are retained separately rather than hidden by semitone notation. */
export function midiToJianpu(midi,tonic=60){
  tonicValue(tonic);
  if(!finite(midi)||midi<0||midi>127)return null;
  const rounded=Math.round(midi),difference=rounded-tonic,pitchClass=mod(difference,12),degree=DEGREES[pitchClass],octave=Math.floor(difference/12),accidental=SHARPS.has(pitchClass)?'♯':'';
  return {degree,accidental,octave,text:`${accidental?'#':''}${degree}${octave>0?"'".repeat(octave):','.repeat(-octave)}`,letter:noteName(midi),cents:(midi-rounded)*100,midi:rounded,rawMidi:midi,tonic};
}

function correlation(a,b){const ma=a.reduce((s,v)=>s+v,0)/a.length,mb=b.reduce((s,v)=>s+v,0)/b.length;let covariance=0,va=0,vb=0;for(let i=0;i<a.length;i++){const da=a[i]-ma,db=b[i]-mb;covariance+=da*db;va+=da*da;vb+=db*db;}return va>1e-12&&vb>1e-12?covariance/Math.sqrt(va*vb):0;}

/** A duration-weighted key-profile estimate, not source separation or proof of
 * a song's key. A minor candidate is represented by its relative major tonic,
 * so e.g. A-minor singing uses 6=A within 1=C numbered notation. */
export function estimateMajorTonic(notes){
  if(!Array.isArray(notes)||notes.length>30000)throw new Error('旋律音符資料無效或過多。');
  const histogram=Array(12).fill(0);let count=0,total=0;
  for(const note of notes){if(!note||!finite(note.midi)||note.midi<0||note.midi>127||!finite(note.duration)||note.duration<=0||note.duration>86400)continue;const weight=note.duration;histogram[mod(Math.round(note.midi),12)]+=weight;total+=weight;count++;}
  if(!count||total<=0)return null;
  const distinct=histogram.filter(value=>value>0).length,candidates=[];
  for(let root=0;root<12;root++)for(const [mode,profile] of [['major',MAJOR],['minor',MINOR]]){const rotated=Array.from({length:12},(_,pc)=>profile[mod(pc-root,12)]),tonic=mode==='minor'?mod(root+3,12):root;candidates.push({tonic,root,mode,score:correlation(histogram,rotated)});}
  // Compare distinct numbered tonic candidates; relative major/minor pairs are
  // deliberately one choice, not competing duplicates that imply false doubt.
  const byTonic=new Map();for(const candidate of candidates){const previous=byTonic.get(candidate.tonic);if(!previous||candidate.score>previous.score)byTonic.set(candidate.tonic,candidate);}
  const ranked=[...byTonic.values()].sort((a,b)=>b.score-a.score||a.tonic-b.tonic),best=ranked[0],margin=Math.max(0,best.score-ranked[1].score);
  const evidence=clamp(distinct/7,0,1)*clamp(total/8,0,1);
  const confidence=clamp((Math.max(0,best.score)*.35+Math.min(1,margin*5)*.65)*evidence,0,1);
  const tonic=60+best.tonic;
  return {tonic,confidence,label:`1 = ${noteName(tonic).replace(/-?\d+$/,'')}`,source:'estimate',mode:best.mode,keyRoot:60+best.root,noteCount:count,distinctPitchClasses:distinct};
}

const validNote=note=>note&&finite(note.start)&&note.start>=0&&finite(note.duration)&&note.duration>0&&note.start+note.duration<=86400&&finite(note.midi)&&note.midi>=0&&note.midi<=127;

/** Preserve actual note start/duration, adding only observed gaps >=150ms as
 * rests. Empty/no-voice input stays empty. Polyphonic overlaps are rejected
 * instead of selecting an arbitrary chord tone and calling it a vocal melody. */
export function buildJianpuSequence(notes,{tonic=60,bpm=80,duration,includeRests=true}={}){
  tonicValue(tonic);
  if(!Array.isArray(notes)||notes.length>30000)throw new Error('旋律音符資料無效或過多。');
  if(!finite(bpm)||bpm<20||bpm>300)throw new Error('簡譜速度必須介於 20 至 300 BPM。');
  if(duration!=null&&(!finite(duration)||duration<0||duration>86400))throw new Error('簡譜長度無效。');
  if(typeof includeRests!=='boolean')throw new Error('休止顯示設定無效。');
  const endLimit=duration??Infinity;
  const pitched=notes.map((note,noteIndex)=>({...note,noteIndex})).filter(validNote).filter(note=>note.start<endLimit).map(note=>({...note,duration:Math.min(note.duration,endLimit-note.start)})).filter(note=>note.duration>0).sort((a,b)=>a.start-b.start||a.noteIndex-b.noteIndex);
  if(!pitched.length)return [];
  const result=[];let cursor=0,previousPhrase;
  const rest=(start,length,phrase)=>({start,duration:length,midi:null,degree:0,accidental:'',octave:0,text:'0',letter:'休止',cents:null,beats:length*bpm/60,isRest:true,...(phrase!=null?{phrase}:{})});
  for(const note of pitched){
    if(note.start<cursor-1e-6)throw new Error('旋律包含重疊音符，請選擇單一人聲旋律。');
    const gap=note.start-cursor;if(includeRests&&gap>=.15-1e-9)result.push(rest(cursor,gap,previousPhrase??note.phrase));
    const pitch=midiToJianpu(note.midi,tonic),phrase=typeof note.phrase==='string'||finite(note.phrase)?note.phrase:undefined;
    result.push({...pitch,start:note.start,duration:note.duration,midi:note.midi,beats:note.duration*bpm/60,isRest:false,noteIndex:note.noteIndex,...(phrase!=null?{phrase}:{}),...(typeof note.lyric==='string'?{lyric:note.lyric.slice(0,3000)}:{})});
    cursor=note.start+note.duration;previousPhrase=phrase;
  }
  if(includeRests&&finite(endLimit)&&endLimit-cursor>=.15-1e-9)result.push(rest(cursor,endLimit-cursor,previousPhrase));
  return result;
}

/** Copyable pitch sequence. Original timing remains on the tokens; this plain
 * text is not advertised as a rhythm-perfect transcription of a mixed song. */
export function jianpuText(tokens){
  if(!Array.isArray(tokens))return '';
  const result=[];let phrase;
  for(const token of tokens){if(!token||typeof token.text!=='string')continue;if(phrase!=null&&token.phrase!=null&&String(phrase)!==String(token.phrase))result.push('|');result.push(token.text);if(token.phrase!=null)phrase=token.phrase;}
  return result.join(' ');
}

/** Shared accessible markup; only the tag and action below are supported.
 * All imported text/attributes are escaped. The caller can delegate clicks on
 * .numbered-token[data-index] and synchronise .active using the actual times. */
export function renderJianpuToken(token,{active=false,index,className='',tag='span',action}={}){
  if(!token||(!token.isRest&&!finite(token.degree)))return '';
  const element=tag==='button'?'button':'span',rest=!!token.isRest||token.degree===0;
  const degree=rest?0:clamp(Math.round(token.degree),1,7),octave=rest?0:clamp(Math.round(token.octave||0),-10,10),accidental=rest?'':token.accidental==='♯'?'♯':'';
  const start=finite(token.start)&&token.start>=0?token.start:0,length=finite(token.duration)&&token.duration>0?token.duration:0;
  const underlines=!rest&&finite(token.beats)?token.beats<.2?3:token.beats<.4?2:token.beats<.8?1:0:0;
  const extra=String(className).split(/\s+/).filter(value=>/^[a-zA-Z0-9_-]+$/.test(value)).join(' ');
  const classes=`numbered-token${active?' active':''}${rest?' rest':''}${extra?' '+extra:''}`;
  const title=`${rest?'休止':'簡譜 '+(accidental?'升':'')+degree}${octave>0?'，高 '+octave+' 個八度':octave<0?'，低 '+(-octave)+' 個八度':''}${token.letter?'，'+token.letter:''}${length?'，'+start.toFixed(2)+' 秒起，持續 '+length.toFixed(2)+' 秒':''}`;
  const attrs=`class="${classes}" data-start="${start}" data-end="${start+length}" data-underlines="${underlines}"${Number.isInteger(index)&&index>=0?` data-index="${index}"`:''}${finite(token.midi)?` data-midi="${token.midi}"`:''}${typeof action==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(action)?` data-maction="${action}"`:''} aria-label="${escape(title)}" title="${escape(title)}"`;
  return `<${element}${element==='button'?' type="button"':''} ${attrs}><span class="degree-pitch"><span class="octave-dots top" aria-hidden="true">${octave>0?'•'.repeat(octave):''}</span><span class="degree-line"><span class="degree-accidental">${accidental}</span><span class="degree-value${underlines?' underlined':''}${underlines>=2?' double-underlined':''}${underlines>=3?' triple-underlined':''}">${degree}</span></span><span class="octave-dots bottom" aria-hidden="true">${octave<0?'•'.repeat(-octave):''}</span></span><span class="numbered-letter">${escape(token.letter||'')}</span></${element}>`;
}
