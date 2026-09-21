import { describe, expect, it } from "vitest";
import { appendTranscript, encodeWav, resampleMono, rms } from "./pcm";

const tone = (frequency: number, rate = 48000) => Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * i / rate));

describe("speech PCM transport", () => {
  it("encodes clipped signed PCM16 with a valid mono 16k WAV header", async () => {
    const blob = encodeWav(new Float32Array([-2, -1, 0, 1, 2, NaN]));
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.type).toBe("audio/wav"); expect(blob.size).toBe(56);
    expect(view.getUint16(22, true)).toBe(1); expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); expect(view.getUint32(40, true)).toBe(12);
    expect([0, 1, 2, 3, 4, 5].map(i => view.getInt16(44 + i * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767, 0]);
  });
  it("preserves duration and voice-band energy at common microphone rates", () => {
    for (const rate of [44100, 48000, 96000]) {
      const converted = resampleMono(tone(1000, rate), rate);
      expect(converted).toHaveLength(16000);
      expect(rms(converted)).toBeCloseTo(Math.sqrt(0.125), 2);
    }
  });
  it("filters energy above the target Nyquist frequency instead of aliasing it into speech", () => {
    const converted = resampleMono(tone(12000), 48000);
    expect(rms(converted.subarray(100, converted.length - 100))).toBeLessThan(0.001);
  });
  it("preserves silence and rejects invalid source rates", () => {
    expect(rms(resampleMono(new Float32Array(4800), 48000))).toBe(0);
    expect(() => resampleMono(new Float32Array(1), 0)).toThrow("采样率");
  });
});

describe("voice draft insertion", () => {
  it("preserves the latest typed draft and appends recognized words", () => {
    expect(appendTranscript("刚刚补充的条件", "  通胀如何影响股票？  ")).toBe("刚刚补充的条件\n通胀如何影响股票？");
    expect(appendTranscript("已有内容\n", "继续")).toBe("已有内容\n继续");
    expect(appendTranscript("", "  新问题  ")).toBe("新问题");
  });
  it("never inserts an empty recognition or changes an existing draft on silence", () => {
    expect(appendTranscript("草稿保持原样  ", "  \n ")).toBe("草稿保持原样  ");
  });
});
