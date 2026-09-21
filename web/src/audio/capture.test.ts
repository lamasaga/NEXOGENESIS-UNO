import { afterEach, describe, expect, it, vi } from "vitest";
import { captureMicrophone, microphoneError } from "./capture";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function audioEnvironment(getUserMedia: () => Promise<MediaStream>) {
  const stopped = vi.fn();
  const track = { stop: stopped, onended: null as (() => void) | null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const close = vi.fn().mockResolvedValue(undefined);
  class FakeContext {
    sampleRate = 48000;
    destination = {};
    resume = vi.fn().mockResolvedValue(undefined);
    close = close;
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
  }
  let node: { port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } };
  class FakeNode {
    port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn(() => queueMicrotask(() => this.port.onmessage?.({ data: { type: "stopped" } }))), close: vi.fn() };
    connect = vi.fn(); disconnect = vi.fn();
    constructor() { node = this; }
  }
  vi.stubGlobal("window", { isSecureContext: true, AudioContext: FakeContext, AudioWorkletNode: FakeNode });
  vi.stubGlobal("AudioContext", FakeContext); vi.stubGlobal("AudioWorkletNode", FakeNode);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { stream, stopped, track, close, loseFlushAck: () => node.port.postMessage.mockImplementation(() => undefined), samples: (samples: Float32Array) => node.port.onmessage?.({ data: { type: "samples", samples } }) };
}

const options = (controller: AbortController) => ({ signal: controller.signal, onProgress: vi.fn(), onLimit: vi.fn(), onLost: vi.fn() });

describe("microphone lifetime", () => {
  it("closes the microphone even when permission resolves after cancellation", async () => {
    let allow!: (stream: MediaStream) => void;
    const environment = audioEnvironment(() => new Promise(resolve => { allow = resolve; }));
    const controller = new AbortController();
    const pending = captureMicrophone(options(controller));
    controller.abort(); allow(environment.stream);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(environment.stopped).toHaveBeenCalledOnce(); expect(environment.close).toHaveBeenCalledOnce();
  });
  it("releases tracks and context on cancellation without submitting audio", async () => {
    const environment = audioEnvironment(async () => environment.stream);
    const controller = new AbortController();
    const recording = await captureMicrophone(options(controller));
    controller.abort(); recording.cancel();
    await expect(recording.finish()).rejects.toMatchObject({ name: "AbortError" });
    expect(environment.stopped).toHaveBeenCalledOnce(); expect(environment.close).toHaveBeenCalledOnce();
  });
  it("refuses silent audio and still releases resources", async () => {
    const environment = audioEnvironment(async () => environment.stream);
    const recording = await captureMicrophone(options(new AbortController()));
    environment.samples(new Float32Array(48000));
    await expect(recording.finish()).rejects.toThrow("没有录到清晰声音");
    expect(environment.stopped).toHaveBeenCalledOnce(); expect(environment.close).toHaveBeenCalledOnce();
  });
  it("reports device loss once and closes the remaining resources", async () => {
    const environment = audioEnvironment(async () => environment.stream);
    const handlers = options(new AbortController());
    await captureMicrophone(handlers);
    environment.track.onended?.();
    expect(handlers.onLost).toHaveBeenCalledOnce(); expect(environment.close).toHaveBeenCalledOnce();
  });
  it("refuses partial audio if the worklet cannot acknowledge its final samples", async () => {
    vi.useFakeTimers();
    const environment = audioEnvironment(async () => environment.stream);
    const recording = await captureMicrophone(options(new AbortController()));
    environment.loseFlushAck();
    const rejected = expect(recording.finish()).rejects.toThrow("录音处理未完成");
    await vi.advanceTimersByTimeAsync(1001); await rejected;
    expect(environment.stopped).toHaveBeenCalledOnce(); expect(environment.close).toHaveBeenCalledOnce();
  });
  it("explains permission errors without raw browser exception text", () => {
    expect(microphoneError(new DOMException("Permission denied", "NotAllowedError"))).toContain("地址栏");
  });
});
