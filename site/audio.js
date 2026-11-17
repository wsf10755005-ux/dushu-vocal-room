/** Local, monophonic singing analysis. No network or recording is used here.
 * Pitch frames use continuous MIDI numbers. Engine frame.time is a monotonic
 * performance timestamp in seconds at the analysis window's midpoint; subtract
 * the practice start before scoring. This removes the known FFT window delay.
 * Metrics are evidence-based: missing / unvoiced observations never earn points.
 */
const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const DEFAULT_MIN_RMS = 0.00001;
export const midiToFrequency = midi => 440 * 2 ** ((midi - 69) / 12);
export const frequencyToMidi = frequency => 69 + 12 * Math.log2(frequency / 440);
export const noteName = midi => {
  if (!Number.isFinite(midi)) return '—';
  const rounded = Math.round(midi);
  return `${PITCH_CLASSES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
};
export const rmsToDb = rms => rms > 0 ? 20 * Math.log10(rms) : -100;

/** YIN cumulative mean normalized difference, with parabolic period refinement.
 * Averages adjacent samples when decimating; keeps >=16kHz for high-note precision.
 * Designed for one voice, not for extracting vocals from polyphonic audio.
 * The quiet-signal floor is independent of YIN's periodicity confidence: a
 * quieter voice is accepted without amplifying input or accepting random noise.
 */
export function detectPitch(input, sampleRate, { minRms = DEFAULT_MIN_RMS } = {}) {
  if (!input || input.length < 256 || !(sampleRate > 0) || !Number.isFinite(minRms) || minRms < 0) return null;
  let mean = 0;
  for (let i = 0; i < input.length; i++) mean += input[i];
  mean /= input.length;
  let energy = 0;
  for (let i = 0; i < input.length; i++) energy += (input[i] - mean) ** 2;
  const rms = Math.sqrt(energy / input.length);
  if (!Number.isFinite(rms) || rms < minRms) return null;
  const factor = Math.max(1, Math.floor(sampleRate / 16000));
  const rate = sampleRate / factor;
  const count = Math.floor(input.length / factor);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += input[i * factor + k] - mean;
    samples[i] = sum / factor;
  }
  const maxTau = Math.min(Math.ceil(rate / 60), Math.floor(count / 2) - 1);
  const minTau = Math.max(2, Math.floor(rate / 1500));
  if (maxTau <= minTau + 2) return null;
  const windowSize = count - maxTau;
  const difference = new Float64Array(maxTau + 1);
  const normalized = new Float64Array(maxTau + 1);
  normalized[0] = 1;
  let cumulative = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) {
      const delta = samples[i] - samples[i + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
    cumulative += sum;
    normalized[tau] = cumulative > 0 ? sum * tau / cumulative : 1;
  }
  let best = -1;
  for (let tau = minTau; tau < maxTau - 1; tau++) {
    if (normalized[tau] < 0.13) {
      while (tau + 1 <= maxTau && normalized[tau + 1] < normalized[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0 || 1 - normalized[best] < 0.87) return null;
  // Interpolation on the difference curve avoids CMND's period-dependent bias.
  const a = difference[best - 1], b = difference[best], c = difference[best + 1];
  const denominator = a - 2 * b + c;
  const shift = denominator ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denominator))) : 0;
  const frequency = rate / (best + shift);
  if (!(frequency >= 60 && frequency <= 1500)) return null;
  const midi = frequencyToMidi(frequency);
  return { frequency, midi, cents: (midi - Math.round(midi)) * 100,
    note: noteName(midi), rms, confidence: Math.max(0, Math.min(1, 1 - normalized[best])) };
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const stdev = values => {
  if (values.length < 2) return null;
  const m = average(values);
  return Math.sqrt(average(values.map(v => (v - m) ** 2)));
};
const finiteMidi = frame => Number.isFinite(frame.midi) && (frame.confidence == null || frame.confidence >= 0.87);

/** Score pitch against the supplied melody on a shared timeline.
 * coverage is voiced duration / score duration; accuracy is in-tune voiced
 * duration / score duration (0..100), so silence cannot inflate the score.
 * Notes are monophonic. A frame covers at most 80 ms, preventing long gaps from
 * turning into held notes. stability removes each note's median pitch bias.
 * Rhythm is approximate: detected voiced attacks / pitch changes / amplitude
 * re-attacks are matched one-to-one, within 350 ms, to score note starts. A
 * continuous identical note supplies no evidence of a repeated note's attack.
 * Positive rhythmMs means late, negative means early. latencyMs is subtracted.
 */
export function analyseSession({ frames = [], notes = [], duration = 0, latencyMs = 0, toleranceCents = 25 } = {}) {
  const ordered = frames.filter(f => Number.isFinite(f.time)).map(f => ({ ...f, time: f.time - latencyMs / 1000 })).sort((a, b) => a.time - b.time);
  const score = notes.filter(n => Number.isFinite(n.start) && n.duration > 0 && Number.isFinite(n.midi)).sort((a, b) => a.start - b.start);
  const validDuration = Math.max(0, Number(duration) || 0);
  const expectedDuration = score.reduce((s, n) => s + n.duration, 0);
  const pitches = score.map(() => []);
  const noteWeights = score.map(() => ({ voiced: 0, accurate: 0, absCents: 0 }));
  let voicedSeconds = 0;
  const attacks = [];
  let previousVoiced = null;
  let previousFrame = null;
  let lastAttack = -Infinity;
  for (let i = 0; i < ordered.length; i++) {
    const frame = ordered[i];
    if (frame.time < -0.4 || frame.time > validDuration + 0.4) continue;
    if (finiteMidi(frame)) {
      const previousGap = previousVoiced ? frame.time - previousVoiced.time : Infinity;
      const previousSilent = previousFrame && !finiteMidi(previousFrame);
      const pitchChanged = previousVoiced && Math.abs(frame.midi - previousVoiced.midi) > 0.65;
      const reattack = previousFrame && Number.isFinite(frame.rms) && Number.isFinite(previousFrame.rms)
        && frame.rms > DEFAULT_MIN_RMS && previousFrame.rms > 0 && frame.rms / previousFrame.rms > 2.3;
      if ((!previousVoiced || previousGap > 0.12 || previousSilent || pitchChanged || reattack) && frame.time - lastAttack > 0.09) {
        attacks.push({ time: frame.time, midi: frame.midi });
        lastAttack = frame.time;
      }
      const next = ordered[i + 1];
      const dt = Math.min(0.08, Math.max(0, (next ? next.time : frame.time + 1 / 30) - frame.time));
      const a = Math.max(0, frame.time), b = Math.min(validDuration, frame.time + dt);
      if (b > a) voicedSeconds += b - a;
      for (let j = 0; j < score.length; j++) {
        const note = score[j];
        if (note.start >= frame.time + dt) break;
        const overlap = Math.max(0, Math.min(note.start + note.duration, frame.time + dt, validDuration) - Math.max(note.start, frame.time, 0));
        if (!overlap) continue;
        const cents = (frame.midi - note.midi) * 100;
        noteWeights[j].voiced += overlap;
        noteWeights[j].absCents += Math.abs(cents) * overlap;
        if (Math.abs(cents) <= toleranceCents) noteWeights[j].accurate += overlap;
        pitches[j].push(cents);
      }
      previousVoiced = frame;
    }
    previousFrame = frame;
  }
  // Match closest pairs globally. A note missed earlier in a short repeated
  // passage must not steal the attack that belongs to the following note.
  const candidates = [];
  for (let noteIndex = 0; noteIndex < score.length; noteIndex++) {
    const note = score[noteIndex];
    for (let attackIndex = 0; attackIndex < attacks.length; attackIndex++) {
      const attack = attacks[attackIndex];
      if (attack.time < note.start - 0.35) continue;
      if (attack.time > note.start + 0.35) break;
      const pitchDistance = Math.abs(attack.midi - note.midi);
      if (pitchDistance > 0.6) continue;
      candidates.push({ noteIndex, attackIndex, cost: Math.abs(attack.time - note.start) + pitchDistance * 0.04 });
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);
  const rhythms = score.map(() => null), usedAttacks = new Set(), usedNotes = new Set();
  for (const candidate of candidates) {
    if (usedNotes.has(candidate.noteIndex) || usedAttacks.has(candidate.attackIndex)) continue;
    usedNotes.add(candidate.noteIndex); usedAttacks.add(candidate.attackIndex);
    rhythms[candidate.noteIndex] = (attacks[candidate.attackIndex].time - score[candidate.noteIndex].start) * 1000;
  }
  const aggregate = indices => {
    const expected = indices.reduce((sum, i) => sum + score[i].duration, 0);
    const voiced = indices.reduce((sum, i) => sum + noteWeights[i].voiced, 0);
    const accurate = indices.reduce((sum, i) => sum + noteWeights[i].accurate, 0);
    const weightedError = indices.reduce((sum, i) => sum + noteWeights[i].absCents, 0);
    const centered = [];
    for (const i of indices) {
      const center = median(pitches[i]);
      if (center != null) centered.push(...pitches[i].map(v => v - center));
    }
    const timing = indices.map(i => rhythms[i]).filter(Number.isFinite);
    return { voicedSeconds: voiced, coverage: expected > 0 ? Math.min(100, voiced / expected * 100) : null,
      accuracy: voiced > 0 && expected > 0 ? Math.min(100, accurate / expected * 100) : null,
      meanAbsCents: voiced > 0 ? weightedError / voiced : null, stabilityCents: stdev(centered),
      rhythmMs: median(timing), meanAbsRhythmMs: timing.length ? average(timing.map(Math.abs)) : null,
      earlyCount: timing.filter(v => v < -60).length, lateCount: timing.filter(v => v > 60).length,
      onsetCount: timing.length, noteCount: indices.length };
  };
  const groups = new Map();
  score.forEach((note, index) => {
    const id = note.phrase ?? Math.floor(note.start / 8);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(index);
  });
  const phrases = [...groups].map(([id, indices]) => ({
    id, label: indices.map(i => score[i].lyric || '').filter(Boolean).join('') || `第 ${[...groups.keys()].indexOf(id) + 1} 句`,
    start: Math.min(...indices.map(i => score[i].start)),
    end: Math.max(...indices.map(i => score[i].start + score[i].duration)), ...aggregate(indices),
  }));
  const result = aggregate(score.map((_, i) => i));
  const dynamicFrames = ordered.filter(f => f.time >= 0 && f.time <= validDuration && finiteMidi(f) && f.rms > 0);
  const levels = dynamicFrames.map(f => rmsToDb(f.rms));
  return { ...result, voicedSeconds: Math.min(validDuration, voicedSeconds), duration: validDuration,
    expectedSeconds: expectedDuration, phrases, toleranceCents,
    minMidi: dynamicFrames.length ? Math.min(...dynamicFrames.map(f => f.midi)) : null,
    maxMidi: dynamicFrames.length ? Math.max(...dynamicFrames.map(f => f.midi)) : null,
    dynamicRangeDb: levels.length >= 2 ? Math.max(...levels) - Math.min(...levels) : null,
    dynamicsDb: levels.length ? average(levels) : null,
    hasEvidence: result.meanAbsCents != null,
  };
}

/** Web Audio engine. `when` is a delay in seconds from now, not context time.
 * start(onFrame) yields ~30 frames/sec including silence (midi:null). frame.time
 * estimates capture time at the buffer midpoint, not the later callback time.
 * stop() ends microphone access and active tones, but retains the audio context
 * for later user-gesture reuse. destroy() additionally closes the context.
 */
export class AudioEngine {
  constructor() {
    this.context = null; this.stream = null; this.source = null; this.analyser = null;
    this.nodes = new Set(); this.running = false; this.timer = null; this.startToken = 0;
    this.setInputThresholdDb(-100);
  }
  setInputThresholdDb(db) {
    const value = Number(db);
    if (!Number.isFinite(value)) throw new TypeError('麥克風偵測門檻必須是有限數字。');
    this.inputThresholdDb = Math.max(-100, Math.min(-20, value));
    this.minRms = 10 ** (this.inputThresholdDb / 20);
    return this.inputThresholdDb;
  }
  async ensureContext() {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('這個瀏覽器不支援 Web Audio，請使用 Safari 或 Chrome。');
    if (!this.context || this.context.state === 'closed') this.context = new Context({ latencyHint: 'interactive' });
    if (this.context.state === 'suspended' || this.context.state === 'interrupted') await this.context.resume();
    return this.context;
  }
  async start(onFrame) {
    this.stop();
    const token = ++this.startToken;
    let stream;
    try {
      const context = await this.ensureContext();
      if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('麥克風需要 HTTPS 網址或本機 localhost，請改用安全網址。');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (token !== this.startToken) { stream.getTracks().forEach(t => t.stop()); return; }
      // Some mobile browsers suspend the audio context during the permission UI.
      if (context.state === 'suspended' || context.state === 'interrupted') await context.resume();
      if (token !== this.startToken) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      this.source = context.createMediaStreamSource(stream);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 8192;
      this.analyser.smoothingTimeConstant = 0;
      this.source.connect(this.analyser);
      // An analyser need not connect to destination: no microphone feedback.
      const samples = new Float32Array(this.analyser.fftSize);
      this.running = true;
      const tick = () => {
        if (!this.running || !this.analyser) return;
        this.analyser.getFloatTimeDomainData(samples);
        const pitch = detectPitch(samples, context.sampleRate, { minRms: this.minRms });
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] ** 2;
        const observedAt = performance.now() / 1000;
        const time = observedAt - samples.length / (2 * context.sampleRate);
        onFrame({ time, observedAt, ...(pitch || { frequency: null, midi: null, cents: null, note: '—', confidence: 0 }), rms: Math.sqrt(sum / samples.length) });
        this.timer = globalThis.setTimeout(tick, 33);
      };
      tick();
    } catch (error) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (token === this.startToken) this.stop();
      throw error;
    }
  }
  tone(midi, duration = 0.5, when = 0, volume = 0.16, type = 'sine') {
    const context = this.context;
    if (!context || context.state !== 'running' || !Number.isFinite(midi) || !Number.isFinite(duration) || duration <= 0) return;
    const oscillator = context.createOscillator(), gain = context.createGain();
    const start = context.currentTime + Math.max(0, when);
    const end = start + duration;
    oscillator.type = type;
    oscillator.frequency.value = midiToFrequency(midi);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(0.4, volume)), start + Math.min(0.02, duration / 4));
    gain.gain.setValueAtTime(Math.max(0, Math.min(0.4, volume)), Math.max(start + duration / 2, end - 0.04));
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain); gain.connect(context.destination);
    this.nodes.add(oscillator);
    oscillator.onended = () => { this.nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start); oscillator.stop(end + 0.01);
  }
  click(accent = false, when = 0) { this.tone(accent ? 96 : 91, 0.045, when, accent ? 0.12 : 0.07, 'square'); }
  stopTones() {
    for (const oscillator of this.nodes) { try { oscillator.stop(); } catch {} try { oscillator.disconnect(); } catch {} }
    this.nodes.clear();
  }
  stop() {
    this.startToken++;
    this.running = false;
    if (this.timer != null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    if (this.source) { try { this.source.disconnect(); } catch {} }
    if (this.analyser) { try { this.analyser.disconnect(); } catch {} }
    if (this.stream) this.stream.getTracks().forEach(track => track.stop());
    this.stream = null; this.source = null; this.analyser = null;
    this.stopTones();
  }
  async destroy() { this.stop(); if (this.context && this.context.state !== 'closed') await this.context.close(); this.context = null; }
}
