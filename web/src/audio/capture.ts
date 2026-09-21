import { encodeWav, resampleMono, rms, SPEECH_MAX_SECONDS } from "./pcm";

export interface Recording { blob: Blob; seconds: number }
export interface Capture { finish(): Promise<Recording>; cancel(): void }

export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限未开启。请在浏览器地址栏的权限设置中允许麦克风，再重试。";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "没有找到麦克风，请连接设备后重试。";
  if (name === "NotReadableError" || name === "TrackStartError") return "麦克风无法使用，可能被其他程序占用，请检查设备后重试。";
  if (name === "AbortError") return "录音已取消。";
  return error instanceof Error ? error.message : "语音输入失败，请重试。";
}

export async function captureMicrophone(options: {
  signal: AbortSignal;
  onProgress: (seconds: number, level: number) => void;
  onLimit: () => void;
  onLost: () => void;
}): Promise<Capture> {
  if (!window.isSecureContext) throw new Error("语音输入需要安全连接。请使用本机 localhost 地址，或通过 HTTPS 打开 UNO。");
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) throw new Error("当前浏览器不支持录音，请使用新版 Edge、Chrome 或 Safari。");
  options.signal.throwIfAborted();
  const context = new AudioContext();
  let stream: MediaStream | undefined, source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined, gain: GainNode | undefined;
  let closed = false, stopping = false, limitReported = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let finishFlush: (() => void) | undefined;
  const chunks: Float32Array[] = [];
  let frames = 0, recentLevel = 0;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    source?.disconnect(); node?.disconnect(); gain?.disconnect();
    if (node) { node.port.onmessage = null; node.port.close(); }
    finishFlush?.();
    options.signal.removeEventListener("abort", cleanup);
    void context.close().catch(() => undefined);
  };
  options.signal.addEventListener("abort", cleanup, { once: true });
  try {
    // Resume in the click handler before awaiting permission (required by Safari).
    // Permission can settle after cancellation; attach rejection handling immediately.
    const resumed = context.resume().then(() => null, error => error as unknown);
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (closed || options.signal.aborted) {
      stream.getTracks().forEach(track => track.stop());
      throw new DOMException("录音已取消", "AbortError");
    }
    const resumeError = await resumed;
    if (resumeError) throw resumeError;
    await context.audioWorklet.addModule("/audio/uno-pcm-worklet.js");
    options.signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "uno-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    gain = context.createGain(); gain.gain.value = 0;
    source.connect(node); node.connect(gain); gain.connect(context.destination);
    const maxFrames = Math.floor(context.sampleRate * SPEECH_MAX_SECONDS);
    const reportLimit = () => {
      if (!limitReported && !closed && !stopping) { limitReported = true; options.onLimit(); }
    };
    node.port.onmessage = ({ data }) => {
      if (data?.type === "stopped") { finishFlush?.(); return; }
      if (closed || data?.type !== "samples" || !(data.samples instanceof Float32Array)) return;
      const samples = data.samples.subarray(0, Math.max(0, maxFrames - frames));
      if (samples.length) { chunks.push(samples); frames += samples.length; recentLevel = rms(samples); }
      if (frames >= maxFrames) reportLimit();
    };
    stream.getAudioTracks().forEach(track => { track.onended = () => { if (!closed && !stopping) { cleanup(); options.onLost(); } }; });
    const started = performance.now();
    timer = setInterval(() => {
      options.onProgress(frames / context.sampleRate, Math.min(1, recentLevel * 6));
      if (performance.now() - started >= SPEECH_MAX_SECONDS * 1000) reportLimit();
    }, 200);
    return {
      cancel: cleanup,
      async finish() {
        if (closed || stopping) throw new DOMException("录音已取消", "AbortError");
        stopping = true;
        try {
          // Flush the partial worklet chunk before closing the microphone.
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { finishFlush = undefined; reject(new Error("录音处理未完成，请重新录音。")); }, 1000);
            finishFlush = () => { clearTimeout(timeout); resolve(); };
            node!.port.postMessage({ type: "stop" });
          });
          options.signal.throwIfAborted();
          const joined = new Float32Array(frames);
          let offset = 0;
          for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
          const seconds = frames / context.sampleRate;
          if (seconds < 0.4) throw new Error("录音太短，请说完一句话后再停止。");
          if (rms(joined) < 0.0008) throw new Error("没有录到清晰声音，请检查麦克风并靠近一点再试。");
          return { blob: encodeWav(resampleMono(joined, context.sampleRate)), seconds };
        } finally { cleanup(); chunks.length = 0; }
      },
    };
  } catch (error) { cleanup(); throw error; }
}
