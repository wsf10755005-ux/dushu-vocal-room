import { extractMelody } from './reference.js';

let generation = 0;
self.onmessage = async ({ data }) => {
  const current = ++generation;
  try {
    const samples = data.samples instanceof ArrayBuffer ? new Float32Array(data.samples) : data.samples;
    const result = await extractMelody(samples, data.sampleRate, {
      onProgress: progress => { if (current === generation) self.postMessage({ type: 'progress', progress }); },
    });
    if (current === generation) self.postMessage({ type: 'done', ...result });
  } catch (error) {
    if (current === generation) self.postMessage({ type: 'error', error: error.message || '旋律辨識失敗，請改用旋律譜。' });
  }
};
