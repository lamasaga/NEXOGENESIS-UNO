import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLocalRequestTokenForTests, fetchSpeechStatus, transcribeSpeech } from "./client";

beforeEach(() => __resetLocalRequestTokenForTests());
afterEach(() => vi.unstubAllGlobals());

describe("speech requests", () => {
  it("sends WAV to the local endpoint with the existing security token", async () => {
    const requests = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/security/session") return Response.json({ token: "local-test-token" });
      expect(url).toBe("/api/speech/transcribe");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-Nexogenesis-CSRF")).toBe("local-test-token");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("audio/wav");
      expect(init?.body).toBe(audio);
      return Response.json({ text: "通胀的影响", duration_seconds: 2, processing_ms: 120, engine: "local" });
    });
    vi.stubGlobal("fetch", requests);
    const audio = new Blob([new Uint8Array(44)], { type: "audio/wav" });
    expect((await transcribeSpeech(audio)).text).toBe("通胀的影响");
    expect(requests).toHaveBeenCalledTimes(2);
  });
  it("cancels promptly even if the shared security-token request never returns", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const controller = new AbortController();
    const pending = transcribeSpeech(new Blob(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not start any network request for an already cancelled recording", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    const controller = new AbortController(); controller.abort();
    await expect(transcribeSpeech(new Blob(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps readiness errors actionable and checks status without sending audio", async () => {
    const request = vi.fn(async (url: string) => {
      expect(url).toBe("/api/speech/status");
      return Response.json({ ready: false, detail: "请先设置本地语音模型", engine: "local", maxSeconds: 60 });
    });
    vi.stubGlobal("fetch", request);
    expect((await fetchSpeechStatus()).detail).toContain("本地语音模型");
    expect(request).toHaveBeenCalledOnce();
  });
});
