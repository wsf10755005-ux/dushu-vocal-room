// Private, device-local recordings. Kept separate from the score/settings DB so
// older open pages do not block a schema upgrade. No network calls are made.
const DB_NAME='vocal-lab-recordings',STORE='recordings';
const MAX_AUDIO=50*1024*1024,MAX_JSON=75*1024*1024,MAX_FRAMES=250000,MAX_DURATION=3600;
let opening,persistent=false,failed=false,warning='';
const memory=new Map();
const clone=value=>structuredClone(value);
const finite=Number.isFinite;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const newId=()=>`recording-${globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
function fallback(){failed=true;persistent=false;warning='錄音儲存暫時無法使用，資料只留在此頁。請先下載音檔或匯出練習檔。';}
export function getRecordingStorageStatus(){return {persistent,warning};}
async function openDb(){
  if(failed)return null;
  if(opening)return opening;
  opening=new Promise(resolve=>{
    let request;
    try{if(!globalThis.indexedDB){fallback();resolve(null);return;}request=indexedDB.open(DB_NAME,1);}catch{fallback();resolve(null);return;}
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'id'});};
    request.onsuccess=()=>{if(failed){request.result.close();resolve(null);return;}persistent=true;warning='';const db=request.result;db.onversionchange=()=>{db.close();fallback();};resolve(db);};
    request.onerror=request.onblocked=()=>{fallback();resolve(null);};
  });return opening;
}
async function readOne(id){const db=await openDb();if(!db)return memory.has(id)?clone(memory.get(id)):null;try{const row=await new Promise((resolve,reject)=>{const req=db.transaction(STORE).objectStore(STORE).get(id);req.onsuccess=()=>resolve(req.result??null);req.onerror=()=>reject(req.error);});if(row)memory.set(id,clone(row));return row??null;}catch{fallback();return memory.has(id)?clone(memory.get(id)):null;}}
async function readAll(){const db=await openDb();if(!db)return [...memory.values()].map(clone);try{const rows=await new Promise((resolve,reject)=>{const req=db.transaction(STORE).objectStore(STORE).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});for(const row of rows)memory.set(row.id,clone(row));return rows;}catch{fallback();return [...memory.values()].map(clone);}}
async function write(row){memory.set(row.id,clone(row));const db=await openDb();if(!db)return;try{await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(row);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});}catch{fallback();}}
function string(value,name,max,defaultValue=''){if(value==null)return defaultValue;if(typeof value!=='string'||value.length>max||/[\u0000]/.test(value))throw new Error(`${name}格式無效。`);return value;}
function safeJson(value,depth=0){if(depth>12)throw new Error('歌詞資料層級過深。');if(value===null||['string','boolean'].includes(typeof value))return;if(typeof value==='number'){if(!finite(value))throw new Error('歌詞數值無效。');return;}if(Array.isArray(value)){if(value.length>30000)throw new Error('歌詞資料過多。');for(const item of value)safeJson(item,depth+1);return;}if(object(value)){for(const [key,item]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('歌詞欄位無效。');safeJson(item,depth+1);}return;}throw new Error('歌詞資料無效。');}
function validateLyrics(lyrics){if(lyrics==null)return null;safeJson(lyrics);const lines=Array.isArray(lyrics)?lyrics:lyrics.lines;if(!Array.isArray(lines)||lines.length>30000)throw new Error('歌詞時間軸格式無效。');for(const line of lines){if(!object(line)||!finite(line.time)||line.time<0||line.time>MAX_DURATION+3600||typeof line.text!=='string'||line.text.length>10000)throw new Error('歌詞時間或文字格式無效。');}if(!Array.isArray(lyrics)&&lyrics.offsetMs!=null&&(!finite(lyrics.offsetMs)||Math.abs(lyrics.offsetMs)>3600000))throw new Error('歌詞偏移無效。');if(JSON.stringify(lyrics).length>4*1024*1024)throw new Error('歌詞資料過大。');return clone(lyrics);}
function normalize(input,{existing=null}={}){
  if(!object(input))throw new Error('錄音資料格式無效。');
  const id=string(input.id,'錄音識別碼',300,newId());if(!id)throw new Error('錄音識別碼不可為空。');
  const title=string(input.title,'錄音名稱',160,'我的錄音').trim()||'我的錄音';
  const folder=string(input.folder,'資料夾',256).trim().replace(/\\/g,'/');
  if(folder.split('/').some(part=>part==='.'||part==='..'))throw new Error('資料夾名稱無效。');
  if(!finite(input.duration)||input.duration<0||input.duration>MAX_DURATION)throw new Error('錄音長度須在一小時以內。');
  if(!Array.isArray(input.frames)||input.frames.length>MAX_FRAMES)throw new Error('音高曲線格式無效或過大。');
  const frames=input.frames.map(f=>{
    if(!object(f)||!finite(f.time)||f.time<0||f.time>input.duration+.5||(f.midi!=null&&(!finite(f.midi)||f.midi<0||f.midi>127)))throw new Error('音高曲線包含無效時間或音高。');
    if(f.rms!=null&&(!finite(f.rms)||f.rms<0||f.rms>2))throw new Error('音量資料無效。');
    if(f.confidence!=null&&(!finite(f.confidence)||f.confidence<0||f.confidence>1))throw new Error('音高清晰度無效。');
    return {time:f.time,midi:f.midi??null,...(f.rms!=null?{rms:f.rms}:{}),...(f.confidence!=null?{confidence:f.confidence}:{})};
  }).sort((a,b)=>a.time-b.time);
  const source=input.source??'microphone';if(!['microphone','import'].includes(source))throw new Error('錄音來源無效。');
  const createdAt=existing?.createdAt??input.createdAt??new Date().toISOString();if(typeof createdAt!=='string'||Number.isNaN(new Date(createdAt).getTime()))throw new Error('錄音日期無效。');
  const blob=input.blob??null;if(blob!=null&&(!(blob instanceof Blob)||blob.size>MAX_AUDIO))throw new Error('音檔須為 50 MB 以內。');
  const mimeType=string(input.mimeType??blob?.type,'音檔類型',150);
  if(mimeType&&!/^audio\/[a-z0-9.+-]+(?:\s*;[^\r\n]*)?$/i.test(mimeType)&&mimeType!=='application/octet-stream')throw new Error('音檔類型無效。');
  const lyrics=validateLyrics(input.lyrics);
  return {id,title,folder,createdAt,updatedAt:new Date().toISOString(),duration:input.duration,frames,blob,mimeType,source,lyrics};
}
export async function saveRecording(input){const row=normalize(input);const existing=await readOne(row.id);if(existing)row.createdAt=existing.createdAt;await write(row);return row.id;}
export async function listRecordings(){return (await readAll()).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(({id,title,folder,createdAt,updatedAt,duration,blob,mimeType,source,frames,lyrics})=>({id,title,folder,createdAt,updatedAt,duration,mimeType,source,hasAudio:!!blob?.size,frameCount:frames.length,hasLyrics:!!lyrics}));}
export async function loadRecording(id){if(typeof id!=='string'||id.length>300)throw new Error('錄音識別碼無效。');return readOne(id);}
export async function deleteRecording(id){if(typeof id!=='string'||id.length>300)throw new Error('錄音識別碼無效。');memory.delete(id);const db=await openDb();if(!db)return;try{await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});}catch{fallback();}}
export async function renameRecording(id,title,folder){const row=await readOne(id);if(!row)throw new Error('找不到這份錄音。');return saveRecording({...row,title,folder:folder??row.folder});}
function encodeBase64(bytes){let result='';for(let i=0;i<bytes.length;i+=24576){let chunk='';for(const byte of bytes.subarray(i,i+24576))chunk+=String.fromCharCode(byte);result+=btoa(chunk);}return result;}
function decodeBase64(value){if(typeof value!=='string'||value.length>Math.ceil(MAX_AUDIO/3)*4||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('練習檔音訊資料無效或超過 50 MB。');let binary;try{binary=atob(value);}catch{throw new Error('練習檔音訊無法解碼。');}if(binary.length>MAX_AUDIO)throw new Error('音訊超過 50 MB。');return Uint8Array.from(binary,c=>c.charCodeAt(0));}
export async function exportRecording(id){const row=await readOne(id);if(!row)throw new Error('找不到這份錄音。');const {blob,...recording}=row;const audio=blob?{mimeType:row.mimeType||blob.type||'audio/webm',base64:encodeBase64(new Uint8Array(await blob.arrayBuffer()))}:null;const result={schema:'vocal-lab-recording',version:1,recording,audio};if(JSON.stringify(result).length>MAX_JSON)throw new Error('練習檔過大，請改為分開下載音檔與 MIDI。');return result;}
export async function importRecording(data){
  if(typeof data==='string'){if(data.length>MAX_JSON)throw new Error('練習檔過大。');try{data=JSON.parse(data);}catch{throw new Error('練習檔不是有效 JSON。');}}
  if(!object(data)||data.schema!=='vocal-lab-recording'||data.version!==1||!object(data.recording))throw new Error('不支援這種練習檔格式。');
  if(JSON.stringify(data).length>MAX_JSON)throw new Error('練習檔過大。');
  let blob=null;
  if(data.audio!=null){if(!object(data.audio))throw new Error('練習檔音訊格式無效。');const mime=string(data.audio.mimeType,'音訊類型',150,'audio/webm');const bytes=decodeBase64(data.audio.base64);blob=new Blob([bytes],{type:mime});}
  // Validate the complete payload before changing even the in-memory store.
  const row=normalize({...data.recording,blob,mimeType:data.audio?.mimeType??data.recording.mimeType});
  const existing=await readOne(row.id);if(existing)row.createdAt=existing.createdAt;await write(row);return row.id;
}
