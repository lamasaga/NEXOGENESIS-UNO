/** Local speech input: one bounded request and one lazily loaded worker per host. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { HttpError, json } from "./rpc.js";

export const MAX_SPEECH_SECONDS = 60;
export const MAX_SPEECH_BYTES = 2 * 1024 * 1024;
const ENGINE = "faster-whisper-small";
const MAX_WORKER_LINE_BYTES = 64 * 1024;
const MODEL_FILES = ["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"];

const failure = (status, detail) => new HttpError(status, detail);
const cancelled = () => failure(499, "语音识别已取消。");

/** Validate complete RIFF boundaries, including padding and unique fmt/data chunks. */
export function validateSpeechWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44) throw failure(400, "录音内容无效，请重新录音。");
  if (audio.length > MAX_SPEECH_BYTES) throw failure(413, "录音文件过大，单次最多 60 秒。");
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE"
    || audio.readUInt32LE(4) !== audio.length - 8) throw failure(400, "需要完整的 WAV 录音。");
  let format = null;
  let dataBytes = null;
  let offset = 12;
  while (offset < audio.length) {
    if (offset + 8 > audio.length) throw failure(400, "WAV 数据块不完整。");
    const kind = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size & 1);
    if (end > audio.length || paddedEnd > audio.length) throw failure(400, "WAV 数据块长度无效。");
    if (kind === "fmt ") {
      if (format || size !== 16) throw failure(400, "需要标准 PCM WAV 录音。");
      format = {
        encoding: audio.readUInt16LE(start), channels: audio.readUInt16LE(start + 2),
        sampleRate: audio.readUInt32LE(start + 4), byteRate: audio.readUInt32LE(start + 8),
        blockAlign: audio.readUInt16LE(start + 12), bits: audio.readUInt16LE(start + 14),
      };
    } else if (kind === "data") {
      if (!format || dataBytes !== null) throw failure(400, "WAV 数据块顺序或数量无效。");
      dataBytes = size;
    }
    offset = paddedEnd;
  }
  if (!format || dataBytes === null || format.encoding !== 1 || format.channels !== 1
    || format.sampleRate !== 16000 || format.bits !== 16 || format.byteRate !== 32000
    || format.blockAlign !== 2 || dataBytes % 2 !== 0) {
    throw failure(400, "需要 16 kHz、单声道、16 位 PCM WAV 录音。");
  }
  const durationSeconds = dataBytes / 32000;
  if (durationSeconds < 0.4) throw failure(400, "录音太短，请说完后再停止。");
  if (durationSeconds > MAX_SPEECH_SECONDS) throw failure(413, "单次语音输入最多 60 秒。");
  return { durationSeconds, sampleRate: 16000, channels: 1, dataBytes };
}

async function installedConfig(appRoot) {
  try {
    const configPath = join(appRoot, ".nexogenesis", "speech", "config.json");
    if ((await stat(configPath)).size > 8192) return null;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof config.pythonPath !== "string" || !isAbsolute(config.pythonPath)
      || typeof config.modelPath !== "string" || !isAbsolute(config.modelPath)) return null;
    const workerPath = join(appRoot, "tools", "speech", "worker.py");
    const paths = [config.pythonPath, workerPath, ...MODEL_FILES.map((file) => join(config.modelPath, file))];
    const checks = await Promise.all(paths.map((path) => stat(path)));
    if (checks.some((item) => !item.isFile() || item.size === 0)) return null;
    return { pythonPath: config.pythonPath, modelPath: config.modelPath, workerPath };
  } catch { return null; }
}

/** Options are injectable solely for deterministic worker lifecycle tests. */
export function createSpeechService(appRoot, {
  spawnImpl = spawn, loadTimeoutMs = 60_000, transcribeTimeoutMs = 45_000, idleTimeoutMs = 300_000,
} = {}) {
  let worker = null;
  let active = null;
  let disposed = false;

  function stopWorker(entry, error = failure(503, "本地语音服务已结束，请重试。")) {
    if (!entry || entry.stopped) return;
    entry.stopped = true;
    if (worker === entry) worker = null;
    clearTimeout(entry.loadTimer);
    clearTimeout(entry.idleTimer);
    entry.rejectReady(error);
    entry.pending?.reject(error);
    entry.pending = null;
    try { entry.child.stdin.destroy(); } catch {}
    try { entry.child.kill(); } catch {}
  }

  async function ensureWorker(operation) {
    const config = await installedConfig(appRoot);
    if (operation.signal?.aborted || active !== operation) throw cancelled();
    if (!config) throw failure(503, "本地语音组件尚未就绪，请运行语音安装程序后重试。");
    const signature = JSON.stringify(config);
    if (worker && worker.signature !== signature) stopWorker(worker);
    if (!worker) {
      let child;
      try {
        child = spawnImpl(config.pythonPath, ["-u", config.workerPath, "--model", config.modelPath], {
          windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PYTHONUTF8: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
        });
      } catch { throw failure(503, "无法启动本地语音服务，请检查语音安装后重试。"); }
      const entry = { child, signature, loaded: false, stopped: false, pending: null, text: "", decoder: new StringDecoder("utf8") };
      entry.ready = new Promise((resolve, reject) => { entry.resolveReady = resolve; entry.rejectReady = reject; });
      // A cancellation can arrive before ensureWorker awaits this promise.
      entry.ready.catch(() => {});
      worker = entry;
      entry.loadTimer = setTimeout(() => stopWorker(entry, failure(504, "语音模型加载超时，请重试。")), loadTimeoutMs);
      child.on("error", () => stopWorker(entry, failure(503, "无法启动本地语音服务，请重试。")));
      child.on("exit", () => stopWorker(entry, failure(503, "本地语音服务意外退出，请重试。")));
      child.stdin.on("error", () => stopWorker(entry, failure(503, "本地语音服务连接中断，请重试。")));
      // Never include recognizer diagnostics, audio, paths or transcripts in host logs.
      child.stderr.on("data", () => {});
      child.stdout.on("data", (chunk) => {
        if (entry.stopped || worker !== entry) return;
        entry.text += entry.decoder.write(chunk);
        if (Buffer.byteLength(entry.text, "utf8") > MAX_WORKER_LINE_BYTES) {
          stopWorker(entry, failure(502, "语音服务返回内容过长，请重试。")); return;
        }
        let newline;
        while ((newline = entry.text.indexOf("\n")) !== -1) {
          const line = entry.text.slice(0, newline).trim();
          entry.text = entry.text.slice(newline + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch {
            stopWorker(entry, failure(502, "语音服务返回格式无效，请重试。")); return;
          }
          if (message?.type === "ready" && message.engine === ENGINE && !entry.loaded) {
            entry.loaded = true;
            clearTimeout(entry.loadTimer);
            entry.resolveReady();
          } else if (entry.pending && message?.id === entry.pending.id) {
            const pending = entry.pending;
            entry.pending = null;
            if (message.error) pending.reject(failure(422, "这段录音未能识别，请靠近麦克风后重试。"));
            else if (typeof message.text !== "string" || message.text.length > 16000
              || !Number.isFinite(message.processing_ms) || message.processing_ms < 0
              || !Number.isFinite(message.duration_seconds) || message.duration_seconds <= 0
              || message.duration_seconds > MAX_SPEECH_SECONDS) {
              pending.reject(failure(502, "语音服务返回结果无效，请重试。"));
              stopWorker(entry);
            } else pending.resolve({
              text: message.text.trim(), duration_seconds: pending.durationSeconds,
              processing_ms: message.processing_ms, engine: ENGINE,
            });
          } else {
            stopWorker(entry, failure(502, "语音服务响应与当前录音不匹配，请重试。")); return;
          }
        }
      });
    }
    operation.worker = worker;
    await worker.ready;
    if (operation.signal?.aborted || active !== operation) throw cancelled();
    return operation.worker;
  }

  return {
    async status() {
      const ready = !disposed && Boolean(await installedConfig(appRoot));
      return {
        ready, loaded: ready && Boolean(worker?.loaded), busy: Boolean(active), engine: ENGINE,
        maxSeconds: MAX_SPEECH_SECONDS,
        detail: ready ? "本地识别，录音不会发送到外部模型。" : "本地语音组件尚未就绪，请运行语音安装程序。",
      };
    },
    async transcribe(audioOrReader, { signal } = {}) {
      if (disposed) throw failure(503, "语音服务已关闭。");
      if (active) throw failure(429, "已有一段语音正在识别，请稍后重试。");
      if (signal?.aborted) throw cancelled();
      const operation = { id: randomUUID(), signal, worker: null, timer: null };
      active = operation;
      clearTimeout(worker?.idleTimer);
      let rejectCancellation;
      const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
      operation.cancel = (error = cancelled()) => {
        if (active !== operation) return;
        stopWorker(operation.worker, error);
        rejectCancellation(error);
      };
      const onAbort = () => operation.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await Promise.race([(async () => {
          const audio = typeof audioOrReader === "function" ? await audioOrReader() : audioOrReader;
          const wav = validateSpeechWav(audio);
          if (signal?.aborted || active !== operation) throw cancelled();
          const entry = await ensureWorker(operation);
          operation.timer = setTimeout(() => operation.cancel(failure(504, "语音识别超时，请缩短录音后重试。")), transcribeTimeoutMs);
          return new Promise((resolve, reject) => {
            entry.pending = { id: operation.id, durationSeconds: wav.durationSeconds, resolve, reject };
            try {
              entry.child.stdin.write(`${JSON.stringify({ id: operation.id, audio: audio.toString("base64") })}\n`, (error) => {
                if (error) stopWorker(entry, failure(503, "无法提交录音，请重试。"));
              });
            } catch { stopWorker(entry, failure(503, "无法提交录音，请重试。")); }
          });
        })(), cancellation]);
      } finally {
        clearTimeout(operation.timer);
        signal?.removeEventListener("abort", onAbort);
        if (active === operation) active = null;
        if (!active && worker?.loaded) {
          const entry = worker;
          entry.idleTimer = setTimeout(() => {
            if (worker === entry && !active) stopWorker(entry);
          }, idleTimeoutMs);
          entry.idleTimer.unref?.();
        }
      }
    },
    dispose() {
      disposed = true;
      active?.cancel(failure(503, "语音服务已关闭。"));
      stopWorker(worker);
    },
  };
}

async function readWavBody(req, signal) {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !/^audio\/wav(?:\s*;|$)/i.test(contentType)) throw failure(415, "需要 audio/wav 录音。");
  const declaredLength = req.headers["content-length"];
  if (declaredLength !== undefined && (!/^\d+$/.test(String(declaredLength)) || Number(declaredLength) > MAX_SPEECH_BYTES)) {
    throw failure(413, "录音文件过大，单次最多 60 秒。");
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.off("data", onData); req.off("end", onEnd); req.off("error", onError);
      signal.removeEventListener("abort", onAbort); clearTimeout(timer);
    };
    const fail = (error) => { cleanup(); req.resume(); reject(error); };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_SPEECH_BYTES) { fail(failure(413, "录音文件过大，单次最多 60 秒。")); return; }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)); };
    const onError = () => fail(failure(400, "录音上传中断，请重试。"));
    const onAbort = () => fail(cancelled());
    const timer = setTimeout(() => fail(failure(408, "录音上传超时，请重试。")), 15_000);
    req.on("data", onData); req.once("end", onEnd); req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Trust and CSRF are enforced by the host guard before this route executes. */
export async function handleSpeechApi(service, req, res) {
  const path = new URL(req.url ?? "/", "http://local").pathname;
  res.setHeader("cache-control", "no-store");
  if (path === "/api/speech/status") {
    if (req.method !== "GET") throw failure(405, "method not allowed");
    return json(res, 200, await service.status());
  }
  if (path !== "/api/speech/transcribe") throw failure(404, "not found");
  if (req.method !== "POST") throw failure(405, "method not allowed");
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  req.once("aborted", disconnected);
  res.once("close", disconnected);
  if (req.aborted || res.destroyed) controller.abort();
  try {
    const result = await service.transcribe(() => readWavBody(req, controller.signal), { signal: controller.signal });
    if (!controller.signal.aborted && !res.destroyed) json(res, 200, result);
  } finally {
    req.off("aborted", disconnected);
    res.off("close", disconnected);
  }
}
