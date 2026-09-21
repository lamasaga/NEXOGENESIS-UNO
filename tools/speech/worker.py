"""Offline Mandarin-first dictation. JSON lines in/out; audio stays in memory."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import sys
import time
import wave

# Never download a model or send telemetry during recording/transcription.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def decode_wav(encoded):
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("音频超过大小限制")
    with wave.open(io.BytesIO(raw), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("需要单声道 16kHz PCM16 WAV")
        count = wav.getnframes()
        if not 6400 <= count <= 960000:
            raise ValueError("录音须为 0.4 至 60 秒")
        data = wav.readframes(count)
        if len(data) != count * 2:
            raise ValueError("音频数据不完整")
    return data, count / 16000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    model_path = Path(args.model).resolve(strict=True)
    if not (model_path / "model.bin").is_file():
        raise ValueError("本地语音模型不完整")
    import numpy as np
    from faster_whisper import WhisperModel
    from opencc import OpenCC

    # Four CPU threads leave capacity for UNO's UI and knowledge jobs.
    model = WhisperModel(str(model_path), device="cpu", compute_type="int8",
                         cpu_threads=min(4, os.cpu_count() or 1), num_workers=1,
                         local_files_only=True)
    simplified = OpenCC("t2s")
    emit({"type": "ready", "engine": "faster-whisper-small"})
    if args.check:
        return
    while True:
        line = sys.stdin.readline(2900000)
        if not line:
            break
        if not line.endswith("\n"):
            raise ValueError("语音请求超过协议限制")
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            started = time.perf_counter()
            data, duration = decode_wav(request["audio"])
            audio = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
            text = ""
            if np.sqrt(np.mean(audio * audio)) >= 0.001:
                segments, _ = model.transcribe(
                    audio, language="zh", task="transcribe", beam_size=5,
                    temperature=0.0, condition_on_previous_text=False,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
                    hallucination_silence_threshold=2.0,
                )
                text = simplified.convert("".join(segment.text for segment in segments).strip())
            emit({"id": request_id, "text": text, "duration_seconds": duration,
                  "processing_ms": round((time.perf_counter() - started) * 1000)})
        except Exception:
            # Do not expose raw input, paths, stack traces, or model internals.
            emit({"id": request_id, "error": "本地转写失败，请重新录音；若持续失败，请检查语音环境。"})


if __name__ == "__main__":
    main()
