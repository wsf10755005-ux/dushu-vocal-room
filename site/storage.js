// IndexedDB persistence with explicit, visible in-memory fallback.
import {validateLyrics} from './lrc.js';
const DB_NAME = 'vocal-lab-local';
const DB_VERSION = 1;
const stores = ['sessions', 'scores', 'settings', 'audio'];
const memory = Object.fromEntries(stores.map(name => [name, new Map()]));
let dbPromise;
let persistent = false;
let storageFailed = false;
let warning = '正在準備本機儲存。';
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 24 * 60 * 60;
const EXERCISE_KINDS = ['warmup', 'scale', 'sustain', 'rhythm', 'dynamics'];

function fallback() {
  storageFailed = true;
  persistent = false;
  warning = '本機儲存無法使用，資料暫存在此頁；關閉可能遺失，請匯出備份。';
}
export function getStorageStatus() { return { persistent, warning }; }

async function openDb() {
  if (storageFailed) return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let request;
    try {
      if (!globalThis.indexedDB) { fallback(); resolve(null); return; }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    }
    catch { fallback(); resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of stores) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'settings' || name === 'audio' ? 'key' : 'id' });
    };
    request.onsuccess = () => {
      if (storageFailed) { request.result.close(); resolve(null); return; }
      persistent = true; warning = '';
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = undefined; fallback(); };
      resolve(db);
    };
    request.onerror = () => { fallback(); resolve(null); };
    request.onblocked = () => { fallback(); resolve(null); };
  });
  return dbPromise;
}

async function readAll(name) {
  const db = await openDb();
  if (!db) return Array.from(memory[name].values()).map(clone);
  try {
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction(name, 'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const row of rows) memory[name].set(row.id ?? row.key, clone(row));
    return Array.from(memory[name].values()).map(clone);
  } catch { fallback(); return Array.from(memory[name].values()).map(clone); }
}
async function readOne(name, key) {
  const db = await openDb();
  if (!db) return memory[name].has(key) ? clone(memory[name].get(key)) : null;
  try {
    const row = await new Promise((resolve, reject) => {
      const request = db.transaction(name, 'readonly').objectStore(name).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    if (row) memory[name].set(key, clone(row));
    return row ?? (memory[name].has(key) ? clone(memory[name].get(key)) : null);
  } catch { fallback(); return memory[name].has(key) ? clone(memory[name].get(key)) : null; }
}
async function put(name, row) {
  memory[name].set(row.id ?? row.key, clone(row));
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(name, 'readwrite');
      transaction.objectStore(name).put(row);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { fallback(); }
}
async function remove(name, key) {
  memory[name].delete(key);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(name, 'readwrite');
      transaction.objectStore(name).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { fallback(); }
}
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function optionalNumber(object, key, min = -Infinity, max = Infinity, integer = false) {
  const value = object[key];
  if (value == null) return;
  if (!finite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${key} 必須是範圍內的有效數字。`);
}
function optionalString(object, key, max = 1000) {
  if (object[key] != null && (typeof object[key] !== 'string' || object[key].length > max)) throw new Error(`${key} 文字格式不正確。`);
}
function optionalBoolean(object, key) {
  if (object[key] != null && typeof object[key] !== 'boolean') throw new Error(`${key} 必須是布林值。`);
}
function optionalDate(object, key) {
  const value = object[key];
  if (value != null && (!['string', 'number'].includes(typeof value) || Number.isNaN(new Date(value).getTime()))) throw new Error('日期格式不正確。');
}
function validateBounds(object) {
  optionalNumber(object, 'minMidi', 0, 127);
  optionalNumber(object, 'maxMidi', 0, 127);
  if (object.minMidi != null && object.maxMidi != null && object.minMidi > object.maxMidi) throw new Error('最低音不可高於最高音。');
}
function validateMetrics(object) {
  for (const key of ['duration', 'durationSeconds', 'voicedSeconds', 'expectedSeconds']) optionalNumber(object, key, 0, MAX_SECONDS);
  // Keep null observations null: silence is never converted into a zero score.
  for (const key of ['accuracy', 'coverage']) if (object[key] != null && (!finite(object[key]) || object[key] < 0 || object[key] > 100)) throw new Error('練習百分比必須介於 0 到 100。');
  for (const key of ['meanAbsCents', 'stabilityCents', 'meanAbsRhythmMs', 'dynamicsError', 'dynamicRangeDb']) optionalNumber(object, key, 0, 1000000);
  optionalNumber(object, 'rhythmMs', -60000, 60000);
  optionalNumber(object, 'dynamicsDb', -1000, 1000);
  optionalNumber(object, 'toleranceCents', 0, 100);
  for (const key of ['earlyCount', 'lateCount', 'onsetCount', 'noteCount']) optionalNumber(object, key, 0, 200000, true);
  validateBounds(object);
}
function validateSession(s) {
  if (!safeObject(s)) throw new Error('練習紀錄格式不正確。');
  if (s.id != null && (typeof s.id !== 'string' || !s.id || s.id.length > 300)) throw new Error('練習識別碼格式不正確。');
  validateMetrics(s);
  for (const key of ['title', 'kind', 'scoreId']) optionalString(s, key);
  optionalDate(s, 'createdAt');
  optionalBoolean(s, 'hasEvidence');
  optionalBoolean(s, 'partial');
  if (s.phrases != null) {
    if (!Array.isArray(s.phrases) || s.phrases.length > 30000) throw new Error('樂句紀錄必須是有效陣列。');
    for (const phrase of s.phrases) {
      if (!safeObject(phrase)) throw new Error('樂句紀錄格式不正確。');
      if (phrase.id != null && !(typeof phrase.id === 'string' && phrase.id.length <= 300) && !(finite(phrase.id))) throw new Error('樂句識別碼格式不正確。');
      optionalString(phrase, 'label', 10000);
      optionalNumber(phrase, 'start', 0, MAX_SECONDS);
      optionalNumber(phrase, 'end', 0, MAX_SECONDS);
      if (phrase.start != null && phrase.end != null && phrase.start > phrase.end) throw new Error('樂句起點不可晚於終點。');
      validateMetrics(phrase);
    }
  }
  if (s.exercise != null) {
    if (!safeObject(s.exercise) || !EXERCISE_KINDS.includes(s.exercise.kind)) throw new Error('練習項目格式不正確。');
    optionalNumber(s.exercise, 'root', 0, 127);
    optionalNumber(s.exercise, 'bpm', 20, 400);
    optionalNumber(s.exercise, 'minutes', .01, 120);
    optionalString(s.exercise, 'vowel', 100);
  }
  if (s.songSettings != null) {
    if (!safeObject(s.songSettings)) throw new Error('歌曲練習設定格式不正確。');
    optionalNumber(s.songSettings, 'transpose', -12, 12, true);
    optionalNumber(s.songSettings, 'speed', .5, 1.2);
    optionalNumber(s.songSettings, 'audioOffset', 0, 1800);
    if (s.songSettings.audioKind != null && !['synth', 'original', 'backing', 'guitar'].includes(s.songSettings.audioKind)) throw new Error('歌曲播放來源格式不正確。');
  }
}
function validateScore(score) {
  if(score?.lyrics!=null)validateLyrics(score.lyrics);
  if (!safeObject(score) || typeof score.title !== 'string' || score.title.length > 1000 || !Array.isArray(score.notes) || !score.notes.length || score.notes.length > 30000) throw new Error('歌譜必須包含名稱及有效音符。');
  if (score.id != null && (typeof score.id !== 'string' || !score.id || score.id.length > 300)) throw new Error('歌譜識別碼格式不正確。');
  let end = 0;
  for (const note of score.notes) {
    if (!safeObject(note) || !finite(note.start) || note.start < 0 || !finite(note.duration) || note.duration <= 0 || note.start + note.duration > MAX_SECONDS || !finite(note.midi) || note.midi < 0 || note.midi > 127) throw new Error('歌譜包含無效音符。');
    optionalString(note, 'lyric', 10000);
    if (note.phrase != null && !(typeof note.phrase === 'string' && note.phrase.length <= 300) && !finite(note.phrase)) throw new Error('音符樂句格式不正確。');
    end = Math.max(end, note.start + note.duration);
  }
  optionalNumber(score, 'bpm', 1, 1000);
  optionalNumber(score, 'duration', 0, MAX_SECONDS);
  if (score.duration != null && score.duration + .000001 < end) throw new Error('歌譜長度不可短於最後一個音符。');
  for (const key of ['format', 'description', 'license', 'selectedPart', 'selectedVoice', 'kind', 'vowel']) optionalString(score, key, key === 'description' || key === 'license' ? 10000 : 1000);
  optionalNumber(score, 'selectedTrack', 0, 10000, true);
  optionalNumber(score, 'root', 0, 127);
  optionalNumber(score, 'tonic', 12, 108, true);
  optionalNumber(score, 'numberedTonic', 12, 108, true);
  optionalNumber(score, 'audioOffset', 0, 1800);
  optionalDate(score, 'updatedAt');
  for (const key of ['warnings', 'parts', 'tracks']) if (score[key] != null && (!Array.isArray(score[key]) || score[key].length > 10000)) throw new Error(`${key} 必須是有效陣列。`);
  for (const warning of score.warnings ?? []) if (typeof warning !== 'string' || warning.length > 10000) throw new Error('歌譜提示文字格式不正確。');
  for (const part of score.parts ?? []) {
    if (!safeObject(part) || typeof part.id !== 'string' || !part.id || part.id.length > 300 || typeof part.name !== 'string' || part.name.length > 1000) throw new Error('聲部格式不正確。');
    if (part.voices != null && (!Array.isArray(part.voices) || part.voices.length > 1000 || part.voices.some(v => typeof v !== 'string' || v.length > 100))) throw new Error('聲部聲音格式不正確。');
  }
  for (const track of score.tracks ?? []) {
    if (!safeObject(track) || !Number.isInteger(track.index) || track.index < 0 || track.index > 10000 || typeof track.name !== 'string' || track.name.length > 1000) throw new Error('音軌格式不正確。');
    optionalNumber(track, 'noteCount', 0, 200000, true);
    optionalNumber(track, 'low', 0, 127); optionalNumber(track, 'high', 0, 127);
    if (track.low != null && track.high != null && track.low > track.high) throw new Error('音軌最低音不可高於最高音。');
  }
  if (score.audioNames != null) {
    if (!safeObject(score.audioNames)) throw new Error('音檔名稱格式不正確。');
    for (const name of Object.values(score.audioNames)) if (name != null && (typeof name !== 'string' || name.length > 1000)) throw new Error('音檔名稱格式不正確。');
  }
}
function validateSetting(key, value) {
  if (typeof key !== 'string' || !key || key.length > 300 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('設定名稱格式不正確。');
  if (key === 'preferences' && value != null) {
    if (!safeObject(value)) throw new Error('偏好設定格式不正確。');
    optionalNumber(value, 'tolerance', 1, 100);
    optionalNumber(value, 'latencyMs', -2000, 2000);
    optionalNumber(value, 'microphoneThresholdDb', -80, -20);
    optionalBoolean(value, 'guide'); optionalBoolean(value, 'metronome');
  }
  if (key === 'range' && value != null) {
    if (!safeObject(value) || !finite(value.minMidi) || !finite(value.maxMidi)) throw new Error('音域設定必須包含最低與最高音。');
    validateBounds(value); optionalDate(value, 'createdAt');
  }
}
// Bound recursive content before mutations. Unknown metadata remains compatible,
// but cannot smuggle executable values, prototype keys, cycles or deep structures.
function validateBackupJson(input) {
  let bytes = 0, nodes = 0;
  const seen = new WeakSet();
  const encoder = new TextEncoder();
  const walk = (value, depth) => {
    if (++nodes > 1000000 || depth > 32) throw new Error('備份結構過於複雜。');
    if (value == null || typeof value === 'boolean') bytes += 5;
    else if (typeof value === 'number') { if (!finite(value)) throw new Error('備份包含無效數字。'); bytes += 24; }
    else if (typeof value === 'string') bytes += encoder.encode(value).length + 2;
    else if (typeof value === 'object') {
      if (seen.has(value)) throw new Error('備份不可包含循環結構。');
      seen.add(value); bytes += 2;
      if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
      else {
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('備份包含不支援的物件。');
        for (const [key, child] of Object.entries(value)) {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('備份包含不支援的欄位名稱。');
          bytes += encoder.encode(key).length + 3;
          walk(child, depth + 1);
        }
      }
      seen.delete(value);
    } else throw new Error('備份包含非 JSON 格式的內容。');
    if (bytes > MAX_BACKUP_BYTES) throw new Error('備份檔請限制在 20 MB 以下。');
  };
  walk(input, 0);
}

export async function saveSession(summary) {
  validateSession(summary);
  const row = { ...clone(summary), id: summary.id || id('session'), createdAt: summary.createdAt ?? new Date().toISOString() };
  if (Array.isArray(row.phrases)) row.phrases = row.phrases.map((phrase, index) => ({ ...phrase, id: phrase.id ?? index + 1, label: phrase.label ?? `第 ${index + 1} 句` }));
  await put('sessions', row);
  return row.id;
}
export async function getSessions(limit = 100) {
  const rows = await readAll('sessions');
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, Math.max(0, limit));
}
export async function getSetting(key, defaultValue = null) { const row = await readOne('settings', key); return row ? row.value : defaultValue; }
export async function setSetting(key, value) {
  validateSetting(key, value);
  const next = key === 'preferences' && value != null ? Object.fromEntries(Object.entries(value).filter(([, v]) => v != null)) : value;
  await put('settings', { key, value: clone(next) });
}
export async function getScores() { return (await readAll('scores')).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()); }
export async function saveScore(score, audioFiles = null) {
  validateScore(score);
  const row = { ...clone(score), id: score.id || id('score'), updatedAt: new Date().toISOString() };
  row.duration ??= Math.max(...row.notes.map(note => note.start + note.duration));
  row.bpm ??= 80;
  row.warnings ??= []; row.parts ??= []; row.tracks ??= [];
  await put('scores', row);
  if (audioFiles && safeObject(audioFiles)) for (const [kind, file] of Object.entries(audioFiles)) if (file) await saveAudio(row.id, kind, file);
  return row.id;
}
export async function deleteScore(scoreId) {
  await remove('scores', scoreId);
  for (const row of await readAll('audio')) if (row.scoreId === scoreId) await remove('audio', row.key);
}
export async function saveAudio(scoreId, kind, file) {
  if (typeof scoreId !== 'string' || !scoreId || typeof kind !== 'string' || !kind) throw new Error('音檔關聯格式不正確。');
  if (!(file instanceof Blob)) throw new Error('請選擇有效的音檔。');
  await put('audio', { key: `${scoreId}:${kind}`, scoreId, kind, file, name: file.name ?? 'audio', updatedAt: new Date().toISOString() });
}
export async function getAudio(scoreId, kind) { const row = await readOne('audio', `${scoreId}:${kind}`); return row?.file ?? null; }

export async function exportData() {
  return {
    app: 'vocal-lab', version: 1, exportedAt: new Date().toISOString(),
    audioExcluded: true,
    note: '此 JSON 備份包含練習紀錄、歌譜與設定，不包含音檔。原唱、伴奏及吉他音檔請另外保存。',
    sessions: await getSessions(100000), scores: await getScores(), settings: await readAll('settings'),
  };
}
/** Validate the entire JSON before any mutation. Existing ids are merged. */
export async function importData(input) {
  if (typeof input === 'string' && new TextEncoder().encode(input).length > MAX_BACKUP_BYTES) throw new Error('備份檔請限制在 20 MB 以下。');
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  validateBackupJson(data);
  if (!safeObject(data) || data.app !== 'vocal-lab' || data.version !== 1 || !Array.isArray(data.sessions) || !Array.isArray(data.scores) || !Array.isArray(data.settings)) throw new Error('這不是支援的 Vocal Lab 備份檔。');
  if (data.sessions.length > 100000 || data.scores.length > 1000 || data.settings.length > 1000) throw new Error('備份檔超過可匯入的大小。');
  for (const s of data.sessions) validateSession(s);
  for (const s of data.scores) validateScore(s);
  for (const setting of data.settings) {
    if (!safeObject(setting)) throw new Error('備份中的設定格式不正確。');
    validateSetting(setting.key, setting.value);
  }
  for (const s of data.sessions) await saveSession(s);
  for (const s of data.scores) await saveScore(s);
  for (const setting of data.settings) await setSetting(setting.key, setting.value);
  return { sessions: data.sessions.length, scores: data.scores.length, audioIncluded: false, persistent: getStorageStatus().persistent };
}
