import { detectPitch } from './audio.js';

const NOTICE = '此功能只辨識清楚的單音旋律，不會分離原唱、人聲或吉他和弦；請先核對辨識結果再練習。';

/** Convert a solo vocal / solo instrument recording into an approximate melody.
 * No network, model downloads, or source separation. samples is mono Float32Array.
 * The caller should run this module in reference-worker.js to avoid UI blocking.
 * Notes retain source timestamps, are snapped to equal-tempered semitones, and
 * require >=120 ms of consistent evidence. Silence never produces a melody.
 */
export async function extractMelody(samples, sampleRate, { onProgress } = {}) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 192000) {
    throw new Error('無效的音訊資料，請匯入瀏覽器可解碼的音檔。');
  }
  const duration = samples.length / sampleRate;
  if (duration > 480.01) throw new Error('單音旋律辨識最多 8 分鐘，請先裁切音檔。');
  onProgress?.(0);
  const warnings = [NOTICE, '音符與分句為自動估計；裝飾音、滑音、快速音群可能需要改用旋律譜。'];
  if (duration < 0.12) return { notes: [], duration, warnings: [...warnings, '音檔太短，未辨識到持續音。'] };

  const rate = Math.min(16000, sampleRate);
  const ratio = sampleRate / rate;
  const count = Math.floor(samples.length / ratio);
  const mono = new Float32Array(count);
  if (ratio === 1) mono.set(samples.subarray(0, count));
  else {
    // Average each source interval before decimation, reducing high-frequency
    // aliasing and avoiding a dependency or large intermediate decoded buffers.
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * ratio), end = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      mono[i] = sum / Math.max(1, end - start);
    }
  }
  const frameLength = Math.max(1024, Math.round(rate * 0.128));
  const hop = Math.round(rate * 0.04), hopSeconds = hop / rate;
  const observations = [];
  const window = new Float32Array(frameLength);
  let voicedCount = 0;
  for (let start = 0, index = 0; start + frameLength <= mono.length; start += hop, index++) {
    window.set(mono.subarray(start, start + frameLength));
    const pitch = detectPitch(window, rate);
    const midi = pitch && pitch.confidence >= 0.9 ? Math.round(pitch.midi) : null;
    if (midi != null) voicedCount++;
    observations.push({ time: (start + frameLength / 2) / rate, midi, confidence: pitch?.confidence ?? 0 });
    if (index % 64 === 0) {
      onProgress?.(Math.min(0.98, (start + frameLength) / mono.length));
      // Allows Worker progress messages and cancellation / a newer job to run.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  // Remove one-frame pitch spikes without filling a genuine unvoiced gap.
  const smoothed = observations.map((observation, i) => {
    if (observation.midi == null || i === 0 || i === observations.length - 1) return observation;
    const left = observations[i - 1].midi, right = observations[i + 1].midi;
    return left != null && left === right ? { ...observation, midi: left } : observation;
  });
  const segments = [];
  let segment = null;
  for (let i = 0; i < smoothed.length; i++) {
    const observation = smoothed[i];
    const start = i === 0 ? 0 : Math.max(0, observation.time - hopSeconds / 2);
    const end = i === smoothed.length - 1 ? duration : Math.min(duration, observation.time + hopSeconds / 2);
    if (observation.midi == null) { if (segment) segments.push(segment); segment = null; continue; }
    if (segment && segment.midi === observation.midi) {
      segment.end = end;
      segment.evidence++;
    } else {
      if (segment) segments.push(segment);
      segment = { start, end, midi: observation.midi, evidence: 1 };
    }
  }
  if (segment) segments.push(segment);
  const notes = [];
  let phrase = 0, phraseStart = 0;
  for (const item of segments) {
    if (item.end - item.start < 0.119 || item.evidence < 3) continue;
    const previous = notes.at(-1);
    if (previous && (item.start - previous.start - previous.duration >= 0.35 || item.start - phraseStart >= 10)) {
      phrase++;
      phraseStart = item.start;
    }
    notes.push({ start: Math.max(0, item.start), duration: item.end - item.start, midi: item.midi, phrase, lyric: '' });
  }
  if (!notes.length) warnings.push('未辨識到足夠清楚的持續音；請使用無伴奏人聲或單音樂器錄音，或直接匯入旋律譜。');
  else if (voicedCount / Math.max(1, observations.length) < 0.25) warnings.push('只有少部分音訊辨識成功，請核對時間與音符，或改用旋律譜取得完整旋律。');
  onProgress?.(1);
  return { notes, duration, warnings };
}
