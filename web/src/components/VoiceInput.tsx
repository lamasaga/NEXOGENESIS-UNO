import { useEffect, useId, useRef, useState } from "react";
import { fetchSpeechStatus, transcribeSpeech, type SpeechStatus } from "../api/client";
import { captureMicrophone, microphoneError, type Capture } from "../audio/capture";
import { SPEECH_MAX_SECONDS } from "../audio/pcm";
import "./VoiceInput.css";

interface Props { disabled: boolean; onText: (text: string) => void; onBusy: (busy: boolean) => void }
type Phase = "idle" | "preparing" | "recording" | "transcribing";

export function VoiceInput({ disabled, onText, onBusy }: Props) {
  const statusId = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true), generation = useRef(0), phaseRef = useRef<Phase>("idle");
  const capture = useRef<Capture | null>(null), controller = useRef<AbortController | null>(null);
  const statusController = useRef<AbortController | null>(null);
  const transcriptionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callbacks = useRef({ onText, onBusy }); callbacks.current = { onText, onBusy };
  const stopRef = useRef<() => void>(() => undefined);

  const changePhase = (next: Phase) => {
    phaseRef.current = next;
    if (mounted.current) { setPhase(next); callbacks.current.onBusy(next !== "idle"); }
  };
  const release = () => {
    controller.current?.abort(); controller.current = null;
    capture.current?.cancel(); capture.current = null;
    if (transcriptionTimer.current) clearTimeout(transcriptionTimer.current);
    transcriptionTimer.current = undefined;
  };
  const cancel = (announce = true) => {
    generation.current++;
    release(); changePhase("idle");
    if (mounted.current) { setLevel(0); setError(""); setMessage(announce ? "已取消，输入框内容保持不变。" : ""); }
  };
  const checkStatus = async () => {
    statusController.current?.abort();
    const request = new AbortController(); statusController.current = request;
    setStatusLoading(true); setError("");
    const timeout = setTimeout(() => request.abort(), 10000);
    try {
      const next = await fetchSpeechStatus(request.signal);
      if (mounted.current && statusController.current === request) { setStatus(next); setMessage(""); }
    } catch (reason) {
      if (mounted.current && statusController.current === request) {
        setStatus(null); setError(request.signal.aborted ? "连接语音服务超时，请重试。" : microphoneError(reason));
      }
    } finally {
      clearTimeout(timeout);
      if (mounted.current && statusController.current === request) setStatusLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void checkStatus();
    return () => {
      mounted.current = false; generation.current++;
      statusController.current?.abort(); statusController.current = null;
      release(); callbacks.current.onBusy(false);
    };
  }, []);
  useEffect(() => { if (disabled && phaseRef.current !== "idle") cancel(false); }, [disabled]);

  const stop = async () => {
    if (phaseRef.current !== "recording" || !capture.current) return;
    const ownGeneration = generation.current;
    const request = controller.current!;
    changePhase("transcribing"); setLevel(0); setMessage("");
    let timedOut = false;
    transcriptionTimer.current = setTimeout(() => { timedOut = true; request.abort(); }, 150000);
    try {
      const recorded = await capture.current.finish(); capture.current = null;
      const result = await transcribeSpeech(recorded.blob, request.signal);
      if (!mounted.current || ownGeneration !== generation.current) return;
      if (!result.text?.trim()) throw new Error("未识别到有效语音，请靠近麦克风、清楚说话后重试。");
      callbacks.current.onText(result.text.trim());
      setMessage("已填入输入框，请检查后发送。"); setError("");
    } catch (reason) {
      if (mounted.current && ownGeneration === generation.current) setError(timedOut ? "转写超时，输入框内容已保留，请稍后重试。" : microphoneError(reason));
    } finally {
      if (mounted.current && ownGeneration === generation.current) { release(); changePhase("idle"); }
    }
  };
  stopRef.current = () => { void stop(); };

  const start = async () => {
    if (disabled || phaseRef.current !== "idle" || !status?.ready) return;
    const ownGeneration = ++generation.current;
    const request = new AbortController(); controller.current = request;
    setError(""); setMessage(""); setSeconds(0); setLevel(0); changePhase("preparing");
    try {
      const next = await captureMicrophone({
        signal: request.signal,
        onProgress: (elapsed, volume) => { if (mounted.current && ownGeneration === generation.current && phaseRef.current === "recording") { setSeconds(elapsed); setLevel(volume); } },
        onLimit: () => { if (mounted.current && ownGeneration === generation.current) stopRef.current(); },
        onLost: () => {
          if (mounted.current && ownGeneration === generation.current) {
            generation.current++; release(); changePhase("idle"); setLevel(0);
            setError("麦克风已断开，本次录音未提交；请重新连接后再试。");
          }
        },
      });
      if (!mounted.current || ownGeneration !== generation.current || request.signal.aborted) { next.cancel(); return; }
      capture.current = next; changePhase("recording");
    } catch (reason) {
      if (mounted.current && ownGeneration === generation.current) { release(); changePhase("idle"); setError(microphoneError(reason)); }
    }
  };
  const busy = phase !== "idle";
  const statusText = phase === "preparing" ? "正在打开麦克风，请允许录音…"
    : phase === "recording" ? "正在录音"
      : phase === "transcribing" ? "正在转写，请稍候…" : statusLoading ? "正在检查语音服务…"
        : error || message || (!status?.ready ? status?.detail || "语音服务暂不可用。" : "识别后可编辑，确认后再发送");
  const buttonLabel = phase === "recording" ? "停止并转写"
    : phase === "preparing" ? "正在打开麦克风"
      : phase === "transcribing" ? "正在转写"
        : !statusLoading && !status?.ready ? "重新检查语音服务" : "语音输入";

  return <div className={`voice-input${busy ? " is-active" : ""}${error ? " has-error" : ""}`}>
    <div className="voice-input__row">
      {phase === "preparing" && <span className="voice-input__progress">准备录音…</span>}
      {phase === "transcribing" && <span className="voice-input__progress">转写中…</span>}
      {phase === "recording" && <>
        <meter className="voice-input__level" min={0} max={1} value={level} aria-label="麦克风音量" />
        <span className="voice-input__time" aria-label={`录音时长 ${Math.floor(seconds)} 秒`} title={`最长 ${SPEECH_MAX_SECONDS} 秒`}>{Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, "0")}</span>
      </>}
      <button type="button" className={`voice-input__start${phase === "recording" ? " is-recording" : ""}`}
        disabled={disabled || statusLoading || phase === "preparing" || phase === "transcribing"}
        aria-label={buttonLabel} aria-describedby={statusId}
        onClick={() => { if (phase === "recording") void stop(); else if (status?.ready) void start(); else void checkStatus(); }}
        title={busy ? buttonLabel : statusLoading ? "正在检查语音服务" : status?.ready ? "语音输入 · 录音转成文字后可编辑，不会自动发送" : `${error || status?.detail || "语音服务暂不可用"} · 点击重新检查`}>
        {phase === "recording"
          ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>}
      </button>
      {busy && <button type="button" className="voice-input__cancel" onClick={() => cancel()} aria-label="取消语音输入" title="取消语音输入">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>}
    </div>
    <span id={statusId} className="voice-input__announcement" role={error ? undefined : "status"}>{statusText}</span>
    {error && <div className="voice-input__error" role="alert">
      <span>{error}</span>
      <button type="button" onClick={() => setError("")} aria-label="关闭语音提示" title="关闭提示">×</button>
    </div>}
  </div>;
}
