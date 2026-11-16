// All score parsing happens on the device. Times are seconds; pitches are MIDI numbers.
const STEPS = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const children = (el, name) => Array.from(el?.children || []).filter(e => e.localName === name);
const child = (el, name) => children(el, name)[0];
const val = (el, name, fallback = '') => child(el,name)?.textContent?.trim() ?? fallback;

function timeline(events, fallbackBpm = 80) {
  const sorted = [{beat:0,bpm:fallbackBpm}, ...events].filter(e => e.beat >= 0 && e.bpm > 0 && Number.isFinite(e.beat) && Number.isFinite(e.bpm)).sort((a,b) => a.beat-b.beat);
  const map=[];
  for (const e of sorted) {
    if (map.length && map.at(-1).beat === e.beat) map[map.length-1] = {...e};
    else map.push({...e});
  }
  let elapsed=0;
  map.forEach((e,i) => {
    if (i) elapsed += (e.beat-map[i-1].beat)*60/map[i-1].bpm;
    e.time=elapsed;
  });
  const seconds = beat => {
    let lo=0,hi=map.length-1;
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);if(map[mid].beat<=beat)lo=mid;else hi=mid-1;}
    const e=map[lo];
    return e.time + (beat-e.beat)*60/e.bpm;
  };
  return {seconds, bpm:map[0].bpm, changes:map.length};
}

function finish(score) {
  score.notes = score.notes.filter(n => Number.isFinite(n.midi) && n.midi >= 0 && n.midi <= 127 && Number.isFinite(n.start) && n.start >= 0 && Number.isFinite(n.duration) && n.duration > 0).sort((a,b)=>a.start-b.start || a.midi-b.midi);
  if (!score.notes.length) throw new Error('找不到可練唱的旋律音符，請選擇有人聲旋律的聲部或 MIDI 音軌。');
  if (score.notes.length > 30000) throw new Error('音符數過多，請先匯出單一旋律聲部。');
  score.duration = Math.max(...score.notes.map(n => n.start+n.duration));
  score.warnings = [...new Set(score.warnings || [])];
  score.parts ||= [];
  score.tracks ||= [];
  return score;
}

/** Parse uncompressed, score-partwise MusicXML. Repeats remain in written order. */
export function parseMusicXML(text, partId, voice) {
  if (typeof DOMParser === 'undefined') throw new Error('MusicXML 需要瀏覽器的 XML 解析器。');
  if (text.length > 12*1024*1024) throw new Error('樂譜過大，請匯出單一聲部（12 MB 以下）。');
  if (/<!ENTITY\s/i.test(text)) throw new Error('不支援含自訂 XML 實體的樂譜，請重新匯出 MusicXML。');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('MusicXML 格式無法讀取，請重新從製譜軟體匯出。');
  const root=doc.documentElement;
  if (root.localName !== 'score-partwise') throw new Error('目前支援 score-partwise MusicXML；請轉存為一般 MusicXML，或匯出 MIDI。');
  const partEls=children(root,'part');
  const partNames=new Map(children(child(root,'part-list'),'score-part').map(p=>[p.getAttribute('id'),val(p,'part-name','未命名聲部')]));
  const parts=partEls.map(p=>({id:p.getAttribute('id'),name:partNames.get(p.getAttribute('id')) || p.getAttribute('id'),voices:[...new Set(Array.from(p.getElementsByTagName('note')).filter(n=>child(n,'pitch')).map(n=>val(n,'voice','1')))]}));
  const selected = partId ? partEls.find(p=>p.getAttribute('id') === partId) : partEls.find(p=>p.getElementsByTagName('pitch').length);
  if (!selected) throw new Error('此聲部不存在或沒有旋律音符。');
  const selectedPart=selected.getAttribute('id');
  const selectedVoice=String(voice ?? parts.find(p=>p.id===selectedPart)?.voices[0] ?? '1');
  const warnings=[];
  if (doc.querySelector('repeat, ending')) warnings.push('反覆記號與跳房按書寫順序演奏；有反覆的歌曲請匯出已展開反覆的 MIDI。');
  if (doc.querySelector('grace')) warnings.push('裝飾音未列入評分。');
  if (parts.find(p=>p.id===selectedPart)?.voices.length > 1) warnings.push(`此聲部含多個聲音，目前採用 voice ${selectedVoice}；可切換聲音後重新匯入。`);
  const beatNotes=[], tempos=[];
  let divisions=1, absolute=0, transpose=0, meter=4;
  const activeTies=new Map();
  const measures=children(selected,'measure');
  measures.forEach((measure, measureIndex)=>{
    let cursor=0,maxCursor=0,previousStart=0;
    for (const el of Array.from(measure.children)) {
      if (el.localName === 'attributes') {
        const d=finite(val(el,'divisions'),divisions); if(d>0) divisions=d;
        const time=child(el,'time');
        if (time) {const beats=finite(val(time,'beats'),4),type=finite(val(time,'beat-type'),4);meter=beats*4/type;}
        const trans=child(el,'transpose');
        if (trans) transpose=finite(val(trans,'chromatic')) + 12*finite(val(trans,'octave-change'));
      } else if (el.localName === 'backup') {
        cursor=Math.max(0,cursor-finite(val(el,'duration'))/divisions);
      } else if (el.localName === 'forward') {
        cursor+=finite(val(el,'duration'))/divisions;maxCursor=Math.max(maxCursor,cursor);
      } else if (el.localName === 'direction') {
        const offset=finite(val(el,'offset'))/divisions;
        const sound=child(el,'sound');
        let bpm=finite(sound?.getAttribute('tempo'));
        if(!bpm) {
          const metronome=child(child(el,'direction-type'),'metronome');
          const units={whole:4,half:2,quarter:1,eighth:.5,'16th':.25};
          if(metronome) bpm=finite(val(metronome,'per-minute'))*(units[val(metronome,'beat-unit')] || 1)*(children(metronome,'beat-unit-dot').length ? 1.5:1);
        }
        if(bpm>0) tempos.push({beat:Math.max(0,absolute+cursor+offset),bpm});
      } else if (el.localName === 'sound') {
        const bpm=finite(el.getAttribute('tempo')); if(bpm>0) tempos.push({beat:absolute+cursor,bpm});
      } else if (el.localName === 'note') {
        if (child(el,'grace')) continue;
        const duration=finite(val(el,'duration'))/divisions;
        const isChord=!!child(el,'chord');
        const start=isChord ? previousStart : cursor;
        if(!isChord) {previousStart=cursor;cursor+=duration;}
        maxCursor=Math.max(maxCursor,start+duration,cursor);
        const p=child(el,'pitch');
        if (!p || val(el,'voice','1') !== selectedVoice || duration <= 0) continue;
        if(isChord) {warnings.push('和弦只採用每組的第一個音；練唱請使用單音旋律譜。');continue;}
        const step=val(p,'step'),octave=finite(val(p,'octave'),NaN),alter=finite(val(p,'alter'));
        if (!(step in STEPS) || !Number.isFinite(octave)) continue;
        const midi=(octave+1)*12+STEPS[step]+alter+transpose;
        const lyricEls=children(el,'lyric');
        const lyric=lyricEls.length ? children(lyricEls[0],'text').map(l=>l.textContent).join('') : '';
        const ties=children(el,'tie').map(t=>t.getAttribute('type'));
        const key=`${selectedVoice}:${midi}`;
        const old=activeTies.get(key);
        if(ties.includes('stop') && old && Math.abs(old.beat+old.beats-(absolute+start)) < .001) {
          old.beats+=duration;
          if(!ties.includes('start')) activeTies.delete(key);
        } else {
          const note={beat:absolute+start,beats:duration,midi,phrase:Math.floor(measureIndex/2)+1,lyric};
          beatNotes.push(note);
          if(ties.includes('start')) activeTies.set(key,note);
          else activeTies.delete(key);
        }
      }
    }
    absolute+=maxCursor || meter;
  });
  // Many exporters put tempo directions only on the first score part.
  if(!tempos.length && selected !== partEls[0]) {
    let beat=0,d=1;
    for(const measure of children(partEls[0],'measure')) {
      let cursor=0,max=0;
      for(const el of Array.from(measure.children)) {
        if(el.localName==='attributes') {const n=finite(val(el,'divisions'),d);if(n>0)d=n;}
        if(el.localName==='direction') {const bpm=finite(child(el,'sound')?.getAttribute('tempo'));if(bpm>0)tempos.push({beat:beat+cursor+finite(val(el,'offset'))/d,bpm});}
        if(el.localName==='backup')cursor=Math.max(0,cursor-finite(val(el,'duration'))/d);
        if(el.localName==='forward'||(el.localName==='note'&&!child(el,'chord')&&!child(el,'grace')))cursor+=finite(val(el,'duration'))/d;
        max=Math.max(max,cursor);
      }
      beat+=max || meter;
    }
  }
  const time=timeline(tempos,80);
  if(!tempos.length)warnings.push('樂譜未標速度，暫用每分鐘 80 拍；請在練習前調整速度。');
  const title=val(child(root,'work'),'work-title') || val(root,'movement-title') || '匯入的樂譜';
  return finish({title,notes:beatNotes.map(n=>({start:time.seconds(n.beat),duration:time.seconds(n.beat+n.beats)-time.seconds(n.beat),midi:n.midi,phrase:n.phrase,lyric:n.lyric})),bpm:time.bpm,warnings,parts,tracks:[],selectedPart,selectedVoice,format:'musicxml'});
}

/** Standard MIDI type 0 / 1 parser, with full-file tempo map and running status. */
export function parseMidi(arrayBuffer, trackIndex) {
  const data = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  if(data.byteLength > 12*1024*1024)throw new Error('MIDI 過大，請匯出單一旋律音軌（12 MB 以下）。');
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  let pos=0;
  const ensure=n=>{if(pos+n>data.length)throw new Error('MIDI 檔案不完整。');};
  const u8=()=>{ensure(1);return data[pos++];};
  const u16=()=>{ensure(2);const n=view.getUint16(pos);pos+=2;return n;};
  const u32=()=>{ensure(4);const n=view.getUint32(pos);pos+=4;return n;};
  const ascii=n=>{ensure(n);let s='';for(let i=0;i<n;i++)s+=String.fromCharCode(data[pos++]);return s;};
  const vlq=()=>{let n=0;for(let i=0;i<4;i++){const b=u8();n=n*128+(b&127);if(!(b&128))return n;}throw new Error('MIDI 的可變長度數值無效。');};
  if(ascii(4)!=='MThd')throw new Error('這不是有效的標準 MIDI 檔案。');
  const headerLength=u32();if(headerLength<6)throw new Error('MIDI 標頭無效。');
  const format=u16(),trackCount=u16(),division=u16();
  if(format>1)throw new Error('目前支援 MIDI type 0 與 1；請將 type 2 轉存為 type 1。');
  if(division&0x8000)throw new Error('不支援 SMPTE 時間格式；請匯出使用 PPQ 拍數的 MIDI。');
  if(!division||!trackCount||trackCount>1024)throw new Error('MIDI 時間或音軌設定無效。');
  ensure(headerLength-6);pos+=headerLength-6;
  const rawTracks=[],tempos=[],warnings=[];
  const decode=b=>{try{return new TextDecoder().decode(b).replace(/\0/g,'');}catch{return '';}};
  for(let index=0;index<trackCount;index++) {
    if(ascii(4)!=='MTrk')throw new Error('MIDI 音軌區塊無效。');
    const length=u32();ensure(length);const end=pos+length;
    let tick=0,running=0,name=`音軌 ${index+1}`;
    const notes=[],active=new Map();let eventCount=0;
    let percussion=false;
    while(pos<end) {
      if(++eventCount>200000)throw new Error('MIDI 事件過多，請匯出單一旋律音軌。');
      tick+=vlq();let status=u8();
      if(status<0x80) {if(!running)throw new Error('MIDI running status 無效。');pos--;status=running;}
      if(status===0xff) {
        running=0;const type=u8(),len=vlq();ensure(len);if(pos+len>end)throw new Error('MIDI meta event 超出音軌範圍。');
        if(type===0x51&&len===3) {const us=data[pos]*65536+data[pos+1]*256+data[pos+2];if(us>0)tempos.push({beat:tick/division,bpm:60000000/us});}
        if(type===3)name=decode(data.subarray(pos,pos+len)) || name;
        pos+=len;
        if(type===0x2f) {pos=end;break;}
      } else if(status===0xf0||status===0xf7) {
        running=0;const len=vlq();ensure(len);pos+=len;
      } else if(status>=0xf0) {
        running=0;const count=({0xf1:1,0xf2:2,0xf3:1,0xf6:0,0xf8:0,0xfa:0,0xfb:0,0xfc:0,0xfe:0})[status];
        if(count===undefined)throw new Error('MIDI 包含不支援的系統事件。');ensure(count);pos+=count;
      } else {
        running=status;const type=status>>4,channel=status&15;
        const a=u8(),b=(type===0xc||type===0xd)?0:u8();
        if(a>127||b>127)throw new Error('MIDI 音符資料無效。');
        if(channel===9) {if(type===9&&b>0)percussion=true;continue;}
        const key=`${channel}:${a}`;
        if(type===9&&b>0) {if(!active.has(key))active.set(key,[]);active.get(key).push({tick,midi:a,channel,velocity:b});}
        if(type===8||(type===9&&b===0)) {
          const start=active.get(key)?.shift();
          if(start&&tick>start.tick)notes.push({...start,ticks:tick-start.tick});
          if(notes.length>30000)throw new Error('音符數過多，請匯出單一旋律音軌。');
        }
      }
      if(pos>end)throw new Error('MIDI 事件超出音軌範圍。');
    }
    for(const queue of active.values())for(const start of queue)if(tick>start.tick){notes.push({...start,ticks:tick-start.tick});warnings.push('部分 MIDI 音符缺少結束事件，已在音軌結尾截斷。');}
    rawTracks.push({index,name,notes,percussion});
    pos=end;
  }
  const tracks=rawTracks.filter(t=>t.notes.length).map(t=>({index:t.index,name:t.name,noteCount:t.notes.length,low:Math.min(...t.notes.map(n=>n.midi)),high:Math.max(...t.notes.map(n=>n.midi))}));
  const selected=trackIndex===undefined?rawTracks.find(t=>t.notes.length):rawTracks.find(t=>t.index===Number(trackIndex));
  if(!selected?.notes.length)throw new Error('所選 MIDI 音軌沒有旋律音符。');
  const time=timeline(tempos,120);
  const ordered=selected.notes.sort((a,b)=>a.tick-b.tick||b.midi-a.midi);
  let previousEnd=-1;
  if(ordered.some(n=>{const overlap=n.tick<previousEnd;previousEnd=Math.max(previousEnd,n.tick+n.ticks);return overlap;}))warnings.push('這個音軌含有重疊音符；請選擇單音人聲旋律音軌，避免和弦影響評分。');
  if(!tempos.length)warnings.push('MIDI 未標速度，依標準採用每分鐘 120 拍。');
  if(rawTracks.some(t=>t.percussion))warnings.push('鼓組音符已略過。');
  return finish({title:selected.name,notes:ordered.map(n=>({start:time.seconds(n.tick/division),duration:time.seconds((n.tick+n.ticks)/division)-time.seconds(n.tick/division),midi:n.midi,phrase:Math.floor(n.tick/division/8)+1,lyric:''})),bpm:time.bpm,warnings,parts:[],tracks,selectedTrack:selected.index,format:'midi'});
}

export function parseJSONScore(text) {
  let obj;try{obj=JSON.parse(text);}catch{throw new Error('JSON 樂譜格式錯誤。');}
  if(!obj||!Array.isArray(obj.notes)||obj.notes.length>30000)throw new Error('JSON 必須包含 notes 音符陣列，且不超過 30,000 音。');
  const invalid=obj.notes.some(n=>!n||!Number.isFinite(n.start)||n.start<0||!Number.isFinite(n.duration)||n.duration<=0||!Number.isFinite(n.midi)||n.midi<0||n.midi>127);
  if(invalid)throw new Error('每個音符需有有效的 start、duration（秒）與 midi（0–127）。');
  const notes=obj.notes.map(n=>({start:n.start,duration:n.duration,midi:n.midi,phrase:typeof n.phrase==='number'||typeof n.phrase==='string'?n.phrase:Math.floor(n.start/6)+1,lyric:String(n.lyric||'').slice(0,120)}));
  return finish({title:String(obj.title||'自訂旋律').slice(0,160),notes,bpm:clamp(finite(obj.bpm,80),20,300),warnings:[],format:'json'});
}

export async function parseScore(file, {partId,voice,trackIndex}={}) {
  if(!file||file.size>12*1024*1024)throw new Error('請選擇 12 MB 以下的樂譜。');
  const ext=file.name.split('.').at(-1).toLowerCase();
  if(ext==='mid'||ext==='midi')return parseMidi(await file.arrayBuffer(),trackIndex);
  if(ext==='xml'||ext==='musicxml')return parseMusicXML(await file.text(),partId,voice);
  if(ext==='json')return parseJSONScore(await file.text());
  if(ext==='mxl')throw new Error('請先解壓縮 MXL，或從製譜軟體匯出未壓縮的 .musicxml 檔。');
  throw new Error('支援 MusicXML、MIDI 或 JSON 旋律譜。PDF／照片與吉他和弦譜需要先轉成旋律譜，無法直接精準比對人聲。');
}

/** Short, comfortable exercises. Root belongs to the caller, so the user can transpose. */
export function createExercise({kind='scale',root=60,bpm=80,vowel='ma',minutes=1}={}) {
  root=clamp(Math.round(finite(root,60)),36,84);bpm=clamp(finite(bpm,80),40,180);
  const patterns={scale:[0,2,4,5,7,5,4,2,0],warmup:[0,2,4,2,0],sustain:[0],dynamics:[0],rhythm:[0,0,2,2,4,4,2,0]};
  if(!(kind in patterns))kind='scale';
  const labels={scale:'母音與子音音階',warmup:'每日輕柔開嗓',sustain:'長音穩定度',dynamics:'漸強・漸弱',rhythm:'節奏與起音'};
  const notes=[];let beat=0,phrase=1;
  const totalBeats=clamp(finite(minutes,1),.25,10)*bpm;
  while(beat<totalBeats) {
    const shift=kind==='scale'?[0,1,2,1,0][(phrase-1)%5]:0;
    for(const [i,interval] of patterns[kind].entries()) {
      const length=(kind==='sustain'||kind==='dynamics')?8:kind==='rhythm'?(i%2?.5:1.5):1;
      const midi=root+interval+shift;
      notes.push({start:beat*60/bpm,duration:length*60/bpm*.9,midi,phrase,lyric:kind==='warmup'?'嗯 / 唇顫音':kind==='dynamics'?'輕 → 響 → 輕':String(vowel)});
      beat+=length;
    }
    beat+=kind==='warmup'?4:2;phrase++;
  }
  return finish({title:labels[kind],notes,bpm,warnings:[],parts:[],tracks:[],format:'exercise',kind,root,vowel:String(vowel)});
}

export function demoScores() {
  const make=(title,rows,bpm,lyrics,meta={})=>{
    let beat=0;const notes=rows.flatMap((row,p)=>row.map(([midi,beats],i)=>{const n={start:beat*60/bpm,duration:beats*60/bpm*.92,midi,phrase:p+1,lyric:lyrics[p]?.[i]||''};beat+=beats;return n;}));
    return finish({title,notes,bpm,warnings:[],parts:[],tracks:[],format:'demo',...meta});
  };
  const twinkle=[[60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2]];
  const answer=[[65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2]];
  return [
    make('小星星', [twinkle,answer,[[67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2]],[[67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2]],twinkle,answer], 88, ['一閃一閃亮晶晶','滿天都是小星星','掛在天空放光明','好像許多小眼睛','一閃一閃亮晶晶','滿天都是小星星'], {id:'twinkle',description:'公有領域旋律 · C4–A4',license:'Traditional public-domain melody; generated reference notes only.'}),
    make('晚風練習曲', [[[60,1],[62,1],[64,2],[67,1],[64,1],[62,2]],[[60,1],[64,1],[65,2],[64,1],[62,1],[60,2]],[[64,1],[65,1],[67,2],[69,1],[67,1],[64,2]],[[65,1],[64,1],[62,2],[64,1],[62,1],[60,2]]], 76, ['晚風吹過了窗邊','讓我輕輕唱一遍','星光落在你肩邊','把這旋律留心間'], {id:'evening',description:'原創練習旋律 · C4–A4',license:'Original practice melody; free to use and modify.'}),
    make('歡樂頌', [
      [[64,1],[64,1],[65,1],[67,1],[67,1],[65,1],[64,1],[62,1]],
      [[60,1],[60,1],[62,1],[64,1],[64,1.5],[62,.5],[62,2]],
      [[64,1],[64,1],[65,1],[67,1],[67,1],[65,1],[64,1],[62,1]],
      [[60,1],[60,1],[62,1],[64,1],[62,1.5],[60,.5],[60,2]]
    ], 80, Array.from({length:4},()=>Array(8).fill('la')), {id:'ode-to-joy',description:'貝多芬公有領域旋律 · C4–G4',license:'Ludwig van Beethoven, public-domain melody from Ode to Joy (1824); newly synthesized reference notes only, no commercial recording or copyrighted lyrics.'}),
    make('奇異恩典', [
      [[55,1],[60,2],[64,.5],[60,.5],[64,2],[62,1],[60,2],[57,1],[55,2]],
      [[55,1],[60,2],[64,.5],[60,.5],[64,2],[62,1],[67,5]],
      [[64,1],[67,2],[64,.5],[60,.5],[64,2],[62,1],[60,2],[57,1],[55,2]],
      [[55,1],[57,1],[60,2],[60,1],[57,1],[55,2],[60,4]]
    ], 76, Array.from({length:4},()=>Array(10).fill('la')), {id:'amazing-grace',description:'傳統公有領域旋律 · G3–G4',license:'Traditional public-domain NEW BRITAIN melody; newly synthesized reference notes only, no commercial recording or copyrighted lyrics.'})
  ];
}
