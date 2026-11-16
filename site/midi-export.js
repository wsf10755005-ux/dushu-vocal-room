// A Standard MIDI file contains discrete note events; continuous cents remain in
// the recording session. Timing here follows the original performance in seconds.
const finite = Number.isFinite;
const median = values => { const a=[...values].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : .033; };

/** Convert a monophonic pitch trace into sustained, nearest-semitone notes.
 * Silence longer than 70 ms splits repeated notes. Isolated <80 ms pitch blips
 * between equal pitches are bridged, so detector jitter does not export ornaments.
 */
export function framesToNotes(frames, {minDuration=.12,noiseGateDb=-45}={}) {
  if(!Array.isArray(frames))throw new Error('音高資料必須是陣列。');
  if(!finite(minDuration)||minDuration<=0||minDuration>5||!finite(noiseGateDb)||noiseGateDb< -120||noiseGateDb>0)throw new Error('旋律轉換設定無效。');
  if(frames.length>250000)throw new Error('音高資料過大，請先裁切練習。');
  const ordered=frames.filter(f=>f&&finite(f.time)&&f.time>=0).sort((a,b)=>a.time-b.time);
  const deltas=ordered.slice(1).map((f,i)=>f.time-ordered[i].time).filter(d=>d>.004&&d<.16);
  const hop=Math.max(.01,Math.min(.08,median(deltas)));
  const threshold=10**(noiseGateDb/20);
  const segments=[];
  for(let i=0;i<ordered.length;i++) {
    const f=ordered[i],next=ordered[i+1];
    const midi=finite(f.midi)&&f.midi>=0&&f.midi<=127&&(f.confidence==null||f.confidence>=.75)&&(f.rms==null||f.rms>=threshold)?Math.round(f.midi):null;
    const duration=next&&next.time-f.time<=.16?Math.max(0,next.time-f.time):hop;
    if(!duration)continue;
    const previous=segments.at(-1);
    if(previous&&previous.midi===midi&&f.time-previous.end<=.001)previous.end=f.time+duration;
    else segments.push({midi,start:f.time,end:f.time+duration});
  }
  // Merge short excursions only when the surrounding pitch agrees. Do not infer
  // a new note from an unvoiced gap, nor bridge a real rearticulation.
  for(let i=1;i<segments.length-1;i++) {
    const previous=segments[i-1],current=segments[i],next=segments[i+1];
    const limit=current.midi==null?.07:.08;
    if(previous.midi!=null&&previous.midi===next.midi&&current.end-current.start<=limit&&current.start-previous.end<=.001&&next.start-current.end<=.001) {
      previous.end=next.end;segments.splice(i,2);i=Math.max(0,i-2);
    }
  }
  return segments.filter(s=>s.midi!=null&&s.end-s.start>=minDuration).map((s,i)=>({start:s.start,duration:s.end-s.start,midi:s.midi,phrase:Math.floor(s.start/8)+1,lyric:''}));
}

function vlq(value) {
  if(!Number.isInteger(value)||value<0||value>0x0fffffff)throw new Error('MIDI 時間長度超過支援範圍。');
  const bytes=[value&127];while(value>>>=7)bytes.unshift((value&127)|128);return bytes;
}
const be16 = value => [(value>>>8)&255,value&255];
const be32 = value => [(value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255];
const ascii = value => Array.from(value,c=>c.charCodeAt(0));

/** Create MIDI type 0 with a fixed tempo and PPQ 480, preserving second timing. */
export function createMidi({notes,bpm=120,title='人聲旋律'}={}) {
  if(!Array.isArray(notes)||notes.length>30000)throw new Error('MIDI 音符資料無效或過多。');
  if(!finite(bpm)||bpm<20||bpm>300)throw new Error('MIDI 速度必須介於 20 至 300 BPM。');
  if(typeof title!=='string'||title.length>1000)throw new Error('MIDI 名稱無效。');
  const ppq=480,tempo=Math.round(60000000/bpm),ticksPerSecond=ppq*1000000/tempo;
  const events=[];
  for(const note of notes) {
    if(!note||!finite(note.start)||note.start<0||!finite(note.duration)||note.duration<=0||note.start+note.duration>3600||!finite(note.midi)||note.midi<0||note.midi>127)throw new Error('MIDI 包含無效音符。');
    const midi=Math.round(note.midi),start=Math.round(note.start*ticksPerSecond),end=Math.max(start+1,Math.round((note.start+note.duration)*ticksPerSecond));
    events.push({tick:start,order:1,midi,bytes:[0x90,midi,96]},{tick:end,order:0,midi,bytes:[0x80,midi,0]});
  }
  events.sort((a,b)=>a.tick-b.tick||a.order-b.order||a.midi-b.midi);
  const name=new TextEncoder().encode(title);
  const track=[0,0xff,3,...vlq(name.length),...name,0,0xff,0x51,3,(tempo>>>16)&255,(tempo>>>8)&255,tempo&255];
  let tick=0;
  for(const event of events){track.push(...vlq(event.tick-tick),...event.bytes);tick=event.tick;}
  track.push(0,0xff,0x2f,0);
  return new Uint8Array([...ascii('MThd'),...be32(6),...be16(0),...be16(1),...be16(ppq),...ascii('MTrk'),...be32(track.length),...track]);
}
