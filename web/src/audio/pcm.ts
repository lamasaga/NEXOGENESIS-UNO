export const SPEECH_SAMPLE_RATE = 16000;
export const SPEECH_MAX_SECONDS = 60;

/** Low-pass windowed-sinc resampling prevents high-frequency aliases in speech. */
export function resampleMono(input: Float32Array, fromRate: number, toRate = SPEECH_SAMPLE_RATE): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate < 8000 || !Number.isFinite(toRate) || toRate < 8000) throw new Error("无效的录音采样率");
  if (fromRate === toRate) return input.slice();
  const output = new Float32Array(Math.round(input.length * toRate / fromRate));
  const ratio = fromRate / toRate;
  const cutoff = Math.min(1, toRate / fromRate) * 0.94;
  const half = 32;
  const gcd = (a: number, b: number): number => { while (b) { const remainder = a % b; a = b; b = remainder; } return a; };
  // Common device rates need only 1 (48k) or 160 (44.1k) fractional phases.
  // Cache the trigonometry per phase instead of repeating it for every output sample.
  const phaseCount = Number.isInteger(fromRate) && Number.isInteger(toRate) ? Math.min(2048, toRate / gcd(fromRate, toRate)) : 1024;
  const kernels = Array.from({ length: phaseCount }, (_, phase) => {
    const kernel = new Float32Array(half * 2);
    for (let tap = 0; tap < kernel.length; tap++) {
      const distance = tap - half + 1 - phase / phaseCount;
      const x = Math.PI * cutoff * distance;
      const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x;
      kernel[tap] = cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / half));
    }
    return kernel;
  });
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    let center = Math.floor(position);
    let phase = Math.round((position - center) * phaseCount);
    if (phase === phaseCount) { phase = 0; center++; }
    const kernel = kernels[phase];
    let sum = 0, weights = 0;
    for (let tap = 0; tap < kernel.length; tap++) {
      const j = center - half + 1 + tap;
      if (j < 0 || j >= input.length) continue;
      const weight = kernel[tap];
      sum += input[j] * weight;
      weights += weight;
    }
    output[i] = weights ? sum / weights : 0;
  }
  return output;
}

export function encodeWav(samples: Float32Array, sampleRate = SPEECH_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function rms(samples: Float32Array): number {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return samples.length ? Math.sqrt(energy / samples.length) : 0;
}

export function appendTranscript(draft: string, text: string): string {
  const transcript = text.trim();
  if (!transcript) return draft;
  return draft ? draft + (/\s$/.test(draft) ? "" : "\n") + transcript : transcript;
}
