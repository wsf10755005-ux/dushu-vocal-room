// All recommendations are computed on this device. No cloud model or paid API.
const COACH_LABEL = '免費本機教練（依練習數據規則推薦，非雲端生成式 AI）';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const metric = (sessions, key) => mean(sessions.map(s => s[key]).filter(finite));
const durationSeconds = s => finite(s.duration) ? Math.max(0, s.duration) : finite(s.durationSeconds) ? Math.max(0, s.durationSeconds) : finite(s.voicedSeconds) ? Math.max(0, s.voicedSeconds) : 0;

function readRange(range) {
  if (!range) return null;
  const low = [range.minMidi, range.lowMidi, range.low, range.min, range.lowestMidi].find(finite);
  const high = [range.maxMidi, range.highMidi, range.high, range.max, range.highestMidi].find(finite);
  return finite(low) && finite(high) && high >= low && low >= 12 && high <= 120 ? { low: Math.ceil(low), high: Math.floor(high) } : null;
}

function recommendSongs(range) {
  const library = [
    { id: 'twinkle', title: '小星星', minMidi: 60, maxMidi: 69, root: 60, reason: '旋律規律，適合音程與拍點練習。' },
    { id: 'ode-to-joy', title: '歡樂頌', minMidi: 60, maxMidi: 67, root: 60, reason: '以級進為主，適合穩定音準。' },
    { id: 'amazing-grace', title: '奇異恩典', minMidi: 55, maxMidi: 67, root: 60, reason: '適合長音、連音及樂句氣息控制。' },
  ];
  const r = readRange(range);
  if (!r) return library.slice(0, 2).map(song => ({ ...song, transpose: 0, rangeVerified: false, reason: `${song.reason}尚未測得你的音域，開始前請先移到舒適調性。` }));
  // Reserve a semitone at each edge: measured extrema need not be comfortable.
  const comfortableLow = r.low + 1;
  const comfortableHigh = r.high - 1;
  const candidates = library.map(song => {
    const minShift = Math.ceil(comfortableLow - song.minMidi);
    const maxShift = Math.floor(comfortableHigh - song.maxMidi);
    if (minShift > maxShift) return null;
    const transpose = clamp(0, minShift, maxShift);
    return { ...song, transpose, root: song.root + transpose, minMidi: song.minMidi + transpose, maxMidi: song.maxMidi + transpose, rangeVerified: true, reason: `${song.reason}${transpose ? `建議${transpose > 0 ? '升' : '降'} ${Math.abs(transpose)} 個半音` : '可先用原示範調'}，已在測得音域兩端各保留 1 個半音。` };
  }).filter(Boolean);
  return candidates.length ? candidates : [{ id: 'range-first', title: '先練五聲音階', root: Math.round((r.low + r.high) / 2) - 2, transpose: 0, rangeVerified: false, reason: '目前測得的舒適音域不足以涵蓋這些完整旋律，先練短句，再重新測量音域。' }];
}

/** Sessions must contain real voiced evidence; null scores never become zeros. */
export function getCoachPlan({ sessions = [], range = null, goalMinutes = 12 } = {}) {
  const usable = sessions.filter(s => s && finite(s.voicedSeconds) && s.voicedSeconds >= 3 && (!finite(s.coverage) || s.coverage >= 15))
    .sort((a, b) => (new Date(b.createdAt ?? b.date ?? b.timestamp ?? 0).getTime() || 0) - (new Date(a.createdAt ?? a.date ?? a.timestamp ?? 0).getTime() || 0)).slice(0, 12);
  const r = readRange(range);
  const root = r ? clamp(Math.round((r.low + r.high) / 2) - 2, Math.max(36, r.low), Math.min(84, Math.max(r.low, r.high - 7))) : 60;
  const weaknesses = [];
  const exercises = [{ kind: 'warmup', title: '輕聲開嗓', minutes: 2, description: '先用輕柔哼鳴或唇顫音，保持在舒適音區；感到不適就停止。', vowel: 'mm', root, bpm: 70 }];
  const pitch = metric(usable, 'meanAbsCents');
  const stability = metric(usable, 'stabilityCents');
  const rhythm = mean(usable.map(s => s.rhythmMs).filter(finite).map(Math.abs));
  const dynamics = metric(usable, 'dynamicsError');
  if (pitch !== null && pitch > 25) {
    weaknesses.push({ key: 'pitch', label: '音準中心', detail: `近期平均偏差約 ${Math.round(pitch)} 音分，先放慢練習並聽清楚每個目標音。` });
    exercises.push({ kind: 'scale', title: '母音與輔音音階', minutes: 4, description: '用 ma、mi 或 mu 練五聲上下行，每個音先聽再唱，觀察偏高或偏低。', vowel: 'ma', root, bpm: 65 });
  }
  if (stability !== null && stability > 18) {
    weaknesses.push({ key: 'stability', label: '長音穩定度', detail: `近期音高波動約 ${Math.round(stability)} 音分，練習均勻呼氣與穩定長音。` });
    exercises.push({ kind: 'sustain', title: '穩定長音', minutes: 3, description: '舒適音量唱 u，每次持續數拍，維持連續的音高線。', vowel: 'u', root: root + 2, bpm: 65 });
  }
  if (rhythm !== null && rhythm > 110) {
    weaknesses.push({ key: 'rhythm', label: '拍點對齊', detail: `近期起音與目標拍點相差約 ${Math.round(rhythm)} 毫秒。先校正裝置延遲，再跟節拍器練起音。` });
    exercises.push({ kind: 'rhythm', title: '拍點與清楚起音', minutes: 3, description: '跟節拍唱短促的 da；每次清楚收音再起音，觀察搶拍或拖拍。', vowel: 'da', root, bpm: 70 });
  }
  if (dynamics !== null && dynamics > 4) {
    weaknesses.push({ key: 'dynamics', label: '漸強漸弱', detail: '音量包絡與目標仍有差距；保持音高，用平順氣息控制音量。' });
    exercises.push({ kind: 'dynamics', title: '長音漸強漸弱', minutes: 3, description: '以 u 唱長音，從輕聲慢慢漸強，再慢慢漸弱；不要靠擠壓喉嚨加大音量。', vowel: 'u', root: root + 2, bpm: 60 });
  }
  if (!usable.length) {
    exercises.push(
      { kind: 'scale', title: '母音與輔音音階', minutes: 3, description: '用 ma、mi、mu 練習舒適的五聲音階，建立第一筆音準紀錄。', vowel: 'ma', root, bpm: 75 },
      { kind: 'sustain', title: '穩定長音', minutes: 2, description: '用 u 輕鬆唱長音，觀察音高是否穩定。', vowel: 'u', root: root + 2, bpm: 65 },
      { kind: 'rhythm', title: '跟上拍點', minutes: 3, description: '以 da 跟節拍器練清楚起音；先慢後快。', vowel: 'da', root, bpm: 75 },
    );
  } else if (!weaknesses.length) {
    exercises.push(
      { kind: 'scale', title: '維持音準', minutes: 3, description: '輪替 ma、mi、mu，保持每個音的中心。', vowel: 'mi', root, bpm: 80 },
      { kind: 'dynamics', title: '音量表情', minutes: 3, description: '用舒適的 u 長音練平滑漸強漸弱，同時維持音準。', vowel: 'u', root: root + 2, bpm: 60 },
      { kind: 'rhythm', title: '拍點複習', minutes: 2, description: '用輕巧的 da 練習準時起音。', vowel: 'da', root, bpm: 85 },
    );
  }
  const target = clamp(Math.round(finite(goalMinutes) ? goalMinutes : 12), 5, 30);
  // First plan is intentionally gentle; later plans respect the chosen budget.
  const budget = usable.length ? target : Math.min(target, 10);
  while (exercises.reduce((sum, ex) => sum + ex.minutes, 0) > budget) {
    const reducible = [...exercises].reverse().find(ex => ex.minutes > 1);
    if (!reducible) break;
    reducible.minutes--;
  }
  const totalMinutes = exercises.reduce((sum, ex) => sum + ex.minutes, 0);
  if (r) {
    const low = r.low + (r.high - r.low >= 2 ? 1 : 0);
    const high = r.high - (r.high - r.low >= 2 ? 1 : 0);
    for (const exercise of exercises) {
      // The scale generator shifts its five-note pattern by up to two semitones.
      const span = exercise.kind === 'scale' ? 9 : ['warmup', 'rhythm'].includes(exercise.kind) ? 4 : 0;
      if (high - low < span) {
        exercise.kind = 'sustain';
        exercise.title = exercise.title === '輕聲開嗓' ? '舒適單音哼鳴' : '舒適音區單音練習';
        exercise.description = '目前測得音域較窄，先在中間舒適音區唱單音，放鬆後再重新測量；不要勉強追逐最高或最低音。';
        exercise.root = clamp(Math.round((low + high) / 2), 36, 84);
      } else exercise.root = clamp(Math.round((low + high - span) / 2), Math.max(36, low), Math.min(84, high - span));
    }
  }
  return {
    label: COACH_LABEL,
    headline: usable.length ? (weaknesses.length ? `今天先練${weaknesses[0].label}` : '保持穩定，加入音量表情') : '先建立你的聲音基準',
    reason: usable.length ? `依最近 ${usable.length} 次有效發聲紀錄安排 ${totalMinutes} 分鐘練習。` : `目前還沒有足夠的有效發聲紀錄，先完成 ${totalMinutes} 分鐘基礎練習。`,
    weaknesses, exercises, songs: recommendSongs(range), totalMinutes,
    disclaimer: `${COACH_LABEL}。推薦依音準、穩定度與節奏數據計算；尚不能判讀聲帶狀態、聲區或演唱風格。歌曲以公有領域旋律示例，調性仍以唱起來舒適為準。`,
  };
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function sessionDate(s) {
  const value = s.createdAt ?? s.date ?? s.timestamp;
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Daily history follows the user's device timezone. now is injectable for tests. */
export function getProgress(sessions = [], now = new Date()) {
  const dayMinutes = new Map();
  let totalSeconds = 0;
  let count = 0;
  for (const s of sessions) {
    if (!s || !finite(s.voicedSeconds) || s.voicedSeconds <= 0) continue;
    const d = sessionDate(s);
    const seconds = durationSeconds(s);
    if (!d || !seconds || d > now) continue;
    count++;
    totalSeconds += seconds;
    const key = localDateKey(d);
    dayMinutes.set(key, (dayMinutes.get(key) ?? 0) + seconds / 60);
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = [];
  for (let ago = 6; ago >= 0; ago--) {
    const date = new Date(today); date.setDate(date.getDate() - ago);
    const key = localDateKey(date);
    week.push({ date: key, minutes: Math.round((dayMinutes.get(key) ?? 0) * 10) / 10 });
  }
  let streak = 0;
  const cursor = new Date(today);
  if (!dayMinutes.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (dayMinutes.has(localDateKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return {
    streak,
    totalMinutes: Math.round(totalSeconds / 6) / 10,
    weeklyMinutes: Math.round(week.reduce((sum, d) => sum + d.minutes, 0) * 10) / 10,
    practicedDays: dayMinutes.size,
    todayMinutes: Math.round((dayMinutes.get(localDateKey(today)) ?? 0) * 10) / 10,
    count,
    week,
  };
}
