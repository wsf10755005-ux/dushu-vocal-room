/** LRC timestamps are raw audio seconds. Positive offset advances lyrics:
 * effective line onset = line.time - offsetMs/1000. No network dependency. */
const stamp=/\[((?:\d{1,3}:)?\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;
const MAX_LINES=30000;
export function parseLRC(input){
  if(typeof input!=='string'||new TextEncoder().encode(input).length>2*1024*1024)throw new Error('LRC 檔請小於 2 MB。');
  const metadata={},lines=[],warnings=[];let offsetMs=0;
  for(const raw of input.replace(/^\uFEFF/,'').split(/\r?\n/)){
    const row=raw.trim();if(!row)continue;
    const meta=row.match(/^\[([a-z]+):([^\]]*)\]$/i);
    if(meta&&!/^\d/.test(meta[1])){const key=meta[1].toLowerCase(),value=meta[2].trim().slice(0,1000);if(key==='offset'){const n=Number(value);if(!Number.isFinite(n)||Math.abs(n)>3600000)throw new Error('LRC 的 offset 必須為有效毫秒數。');offsetMs=n;}else metadata[key]=value;continue;}
    const times=[];let match;stamp.lastIndex=0;
    while((match=stamp.exec(row))){const prefix=match[1].split(':').map(Number),minutes=prefix.at(-1),hours=prefix.length===2?prefix[0]:0;const time=hours*3600+minutes*60+Number(match[2])+Number('0.'+(match[3]||'0'));if(time>86400)throw new Error('LRC 時間超過 24 小時。');times.push(time);}
    if(!times.length){if(/\[\d/.test(row))warnings.push('有無法解析的時間標記，已略過該行。');continue;}
    const text=row.replace(stamp,'').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g,'').trim().slice(0,3000);
    for(const time of times)lines.push({time,text});if(lines.length>MAX_LINES)throw new Error('歌詞行數過多。');
  }
  lines.sort((a,b)=>a.time-b.time);
  const merged=[];for(const line of lines){if(merged.at(-1)?.time===line.time){if(line.text&&merged.at(-1).text!==line.text)merged.at(-1).text+=(merged.at(-1).text?'\n':'')+line.text;}else merged.push({...line});}
  if(!merged.length)throw new Error('沒有讀到 LRC 時間標記，請使用例如 [00:12.50]歌詞 的格式。');
  return {lines:merged,offsetMs,metadata,warnings:[...new Set(warnings)]};
}
export function validateLyrics(lyrics){
  if(!lyrics||typeof lyrics!=='object'||!Array.isArray(lyrics.lines)||lyrics.lines.length>MAX_LINES)throw new Error('歌詞資料格式不正確。');
  if(lyrics.offsetMs!=null&&(!Number.isFinite(lyrics.offsetMs)||Math.abs(lyrics.offsetMs)>3600000))throw new Error('歌詞偏移超出範圍。');
  let previous=-1;for(const l of lyrics.lines){if(!l||!Number.isFinite(l.time)||l.time<0||l.time>86400||l.time<previous||typeof l.text!=='string'||l.text.length>10000)throw new Error('歌詞時間或文字格式不正確。');previous=l.time;}
  return true;
}
export function getLyricAt(lines,time,offsetMs=0){
  if(!Array.isArray(lines)||!lines.length||!Number.isFinite(time))return null;
  const adjusted=time+(Number.isFinite(offsetMs)?offsetMs:0)/1000;let lo=0,hi=lines.length-1,index=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(lines[mid].time<=adjusted){index=mid;lo=mid+1}else hi=mid-1;}
  if(index<0)return null;const line=lines[index],nextTime=lines[index+1]?.time;
  return {...line,index,nextTime,progress:nextTime>line.time?Math.max(0,Math.min(1,(adjusted-line.time)/(nextTime-line.time))):0};
}
export async function readLRCFile(file){if(!file||file.size>2*1024*1024)throw new Error('LRC 檔請小於 2 MB。');const bytes=await file.arrayBuffer(),view=new Uint8Array(bytes);let text;if(view[0]===255&&view[1]===254)text=new TextDecoder('utf-16le').decode(bytes);else if(view[0]===254&&view[1]===255)text=new TextDecoder('utf-16be').decode(bytes);else{text=new TextDecoder('utf-8').decode(bytes);if(text.includes('\uFFFD')){try{text=new TextDecoder('big5').decode(bytes)}catch{}}}return {...parseLRC(text),filename:file.name};}
