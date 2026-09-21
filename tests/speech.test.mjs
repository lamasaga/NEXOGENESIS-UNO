import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeechService, handleSpeechApi, validateSpeechWav, MAX_SPEECH_BYTES } from "../packages/nexogenesis-web-host/lib/speech.js";
import { assertTrustedRequest } from "../packages/nexogenesis-web-host/lib/rpc.js";

function wav(seconds = 1) {
  const bytes = Math.round(seconds * 32000);
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(bytes, 40);
  return b;
}

function chunk(kind, data) {
  const result = Buffer.alloc(8 + data.length + (data.length & 1));
  result.write(kind); result.writeUInt32LE(data.length, 4); data.copy(result, 8);
  return result;
}

function riff(chunks) {
  const b = Buffer.concat([Buffer.from("RIFF0000WAVE"), ...chunks]);
  b.writeUInt32LE(b.length - 8, 4); return b;
}

function mockWorkers(onRequest = (child, request) => child.reply({ id: request.id, text: "测试语音。", duration_seconds: 1, processing_ms: 12 }), { autoReady = true } = {}) {
  const children = [];
  const calls = [];
  const spawnImpl = (...args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.reply = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stdin = new Writable({ write(data, _encoding, done) {
      const request = JSON.parse(data.toString());
      calls.push(request); onRequest(child, request); done();
    } });
    child.kill = () => { child.killed = true; child.emit("exit", null, "SIGTERM"); return true; };
    child.args = args; children.push(child);
    if (autoReady) setImmediate(() => child.reply({ type: "ready", engine: "faster-whisper-small" }));
    return child;
  };
  return { spawnImpl, children, calls };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "uno-speech-test-"));
  await mkdir(join(root, ".nexogenesis", "speech"), { recursive: true });
  await mkdir(join(root, "tools", "speech"), { recursive: true });
  const modelPath = join(root, "model"); await mkdir(modelPath);
  const pythonPath = join(root, "python.exe");
  for (const path of [pythonPath, join(root, "tools", "speech", "worker.py"), ...["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"].map((file) => join(modelPath, file))]) await writeFile(path, "test fixture");
  const configPath = join(root, ".nexogenesis", "speech", "config.json");
  await writeFile(configPath, JSON.stringify({ pythonPath, modelPath }));
  const service = createSpeechService(root, options);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, service, configPath, pythonPath, modelPath };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("expected worker event");
}

test("WAV accepts exactly 60 seconds with validated sample count", () => {
  assert.equal(validateSpeechWav(wav(60)).durationSeconds, 60);
  assert.throws(() => validateSpeechWav(wav(60.01)), { status: 413 });
  assert.throws(() => validateSpeechWav(wav(0.1)), { status: 400 });
  assert.equal(validateSpeechWav(wav(0.4)).durationSeconds, 0.4);
  assert.throws(() => validateSpeechWav(wav(0.399)), { status: 400 });
});

test("WAV rejects declared length spoofing, compression, wrong format and oversized payloads", () => {
  for (const [offset, value, width] of [[4, 1, 4], [20, 3, 2], [22, 2, 2], [24, 48000, 4], [28, 1, 4], [32, 4, 2], [34, 8, 2], [40, 0xffffffff, 4]]) {
    const b = wav(); width === 2 ? b.writeUInt16LE(value, offset) : b.writeUInt32LE(value, offset);
    assert.throws(() => validateSpeechWav(b), { status: 400 });
  }
  assert.throws(() => validateSpeechWav(Buffer.alloc(MAX_SPEECH_BYTES + 1)), { status: 413 });
  assert.throws(() => validateSpeechWav(Buffer.concat([wav(), Buffer.from("tail")])), { status: 400 });
});

test("WAV walks RIFF chunks and padding, rejects duplicate or out-of-order audio and truncated headers", () => {
  const b = wav(); const fmt = b.subarray(12, 36); const data = b.subarray(36);
  assert.equal(validateSpeechWav(riff([chunk("JUNK", Buffer.from("x")), fmt, data])).durationSeconds, 1);
  for (const chunks of [[fmt, fmt, data], [data, fmt], [fmt, data, data], [fmt, Buffer.from("data")], [fmt, chunk("data", Buffer.alloc(8001))], [chunk("fmt ", Buffer.alloc(18)), data]]) {
    assert.throws(() => validateSpeechWav(riff(chunks)), { status: 400 });
  }
});

test("status verifies installation without starting worker or writing files", async (t) => {
  const mock = mockWorkers(); const { root, service, configPath } = await fixture(t, mock);
  const before = await readFile(configPath, "utf8");
  const status = await service.status();
  assert.equal(status.ready, true); assert.equal(status.loaded, false); assert.equal(status.busy, false);
  assert.equal(status.maxSeconds, 60); assert.equal(mock.children.length, 0);
  assert.equal(JSON.stringify(status).includes(root), false);
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.deepEqual(await readdir(join(root, ".nexogenesis", "speech")), ["config.json"]);
  await rm(join(root, "model", "model.bin"));
  assert.equal((await service.status()).ready, false);
});

test("missing and malformed config produces sanitized unavailable status", async (t) => {
  const mock = mockWorkers(); const { service, configPath, root } = await fixture(t, mock);
  await writeFile(configPath, "bad json");
  assert.equal((await service.status()).ready, false);
  await assert.rejects(service.transcribe(wav()), { status: 503 });
  assert.equal(mock.children.length, 0);
  await writeFile(configPath, JSON.stringify({ pythonPath: "relative.exe", modelPath: root }));
  assert.equal((await service.status()).ready, false);
});

test("one lazy worker handles successive recordings without touching knowledge or logging audio", async (t) => {
  const mock = mockWorkers(); const { service, root, pythonPath, modelPath } = await fixture(t, mock);
  assert.equal((await service.transcribe(wav())).text, "测试语音。");
  assert.equal((await service.transcribe(wav())).text, "测试语音。");
  assert.equal(mock.children.length, 1); assert.equal(mock.calls.length, 2);
  assert.notEqual(mock.calls[0].id, mock.calls[1].id);
  assert.deepEqual(Buffer.from(mock.calls[0].audio, "base64"), wav());
  assert.equal((await service.status()).loaded, true);
  assert.equal(mock.children[0].args[0], pythonPath);
  assert.deepEqual(mock.children[0].args[1], ["-u", join(root, "tools", "speech", "worker.py"), "--model", modelPath]);
  assert.equal(mock.children[0].args[2].windowsHide, true);
  assert.equal(mock.children[0].args[2].env.HF_HUB_OFFLINE, "1");
  assert.deepEqual((await readdir(root)).sort(), [".nexogenesis", "model", "python.exe", "tools"]);
});

test("invalid WAV is rejected before any worker load", async (t) => {
  const mock = mockWorkers(); const { service } = await fixture(t, mock);
  await assert.rejects(service.transcribe(Buffer.from("bad")), { status: 400 });
  assert.equal(mock.children.length, 0);
});

test("concurrent uploads receive busy before their request body is read", async (t) => {
  const mock = mockWorkers(() => {}); const { service } = await fixture(t, mock);
  const controller = new AbortController();
  const first = service.transcribe(wav(), { signal: controller.signal });
  const rejected = assert.rejects(first, { status: 499 });
  let secondRead = false;
  await assert.rejects(service.transcribe(() => { secondRead = true; return wav(); }), { status: 429 });
  assert.equal(secondRead, false); assert.equal((await service.status()).busy, true);
  controller.abort(); await rejected;
});

test("cancel during load kills that worker; late ready/exit cannot affect the next generation", async (t) => {
  const mock = mockWorkers(undefined, { autoReady: false }); const { service } = await fixture(t, mock);
  const controller = new AbortController();
  const first = service.transcribe(wav(), { signal: controller.signal });
  const rejected = assert.rejects(first, { status: 499 });
  await waitFor(() => mock.children.length === 1);
  controller.abort(); await rejected;
  assert.equal(mock.children[0].killed, true);
  const next = service.transcribe(wav());
  await waitFor(() => mock.children.length === 2);
  mock.children[0].reply({ type: "ready", engine: "faster-whisper-small" });
  mock.children[0].emit("exit", 1); controller.abort();
  mock.children[1].reply({ type: "ready", engine: "faster-whisper-small" });
  assert.equal((await next).text, "测试语音。"); assert.equal(mock.children[1].killed, false);
});

test("cancel during transcription kills compute and permits retry", async (t) => {
  const mock = mockWorkers((child, request) => { if (mock.calls.length > 1) child.reply({ id: request.id, text: "重试成功", duration_seconds: 1, processing_ms: 1 }); });
  const { service } = await fixture(t, mock); const controller = new AbortController();
  const first = service.transcribe(wav(), { signal: controller.signal }); const rejected = assert.rejects(first, { status: 499 });
  await waitFor(() => mock.calls.length === 1); controller.abort(); await rejected;
  assert.equal(mock.children[0].killed, true);
  assert.equal((await service.transcribe(wav())).text, "重试成功");
});

test("load timeout does not poison later startup", async (t) => {
  const mock = mockWorkers(undefined, { autoReady: false });
  const { service } = await fixture(t, { ...mock, loadTimeoutMs: 25 });
  await assert.rejects(service.transcribe(wav()), { status: 504 });
  assert.equal(mock.children[0].killed, true);
  const next = service.transcribe(wav()); await waitFor(() => mock.children.length === 2);
  mock.children[1].reply({ type: "ready", engine: "faster-whisper-small" });
  assert.equal((await next).text, "测试语音。");
});

test("transcription timeout releases busy and kills stalled worker before retry", async (t) => {
  const mock = mockWorkers((child, request) => { if (mock.calls.length > 1) child.reply({ id: request.id, text: "恢复", duration_seconds: 1, processing_ms: 1 }); });
  const { service } = await fixture(t, { ...mock, transcribeTimeoutMs: 25 });
  await assert.rejects(service.transcribe(wav()), { status: 504 });
  assert.equal(mock.children[0].killed, true); assert.equal((await service.status()).busy, false);
  assert.equal((await service.transcribe(wav())).text, "恢复");
});

test("spawn error and exit release the request and allow a new worker", async (t) => {
  const mock = mockWorkers(undefined, { autoReady: false }); const { service } = await fixture(t, mock);
  for (const event of ["error", "exit"]) {
    const request = service.transcribe(wav()); const rejected = assert.rejects(request, { status: 503 });
    const count = mock.children.length; await waitFor(() => mock.children.length > count);
    mock.children.at(-1).emit(event, event === "error" ? new Error("private path") : 1);
    await rejected;
  }
  assert.equal((await service.status()).busy, false);
});

test("worker protocol and output limits fail safely without echoing private diagnostics", async (t) => {
  const mock = mockWorkers(() => {}); const { service } = await fixture(t, mock);
  for (const output of ["not json\n", `${"a".repeat(65537)}\n`, '{"id":"wrong","text":"private"}\n']) {
    const count = mock.calls.length;
    const request = service.transcribe(wav()); const rejected = assert.rejects(request, (error) => error.status === 502 && !error.message.includes("private"));
    await waitFor(() => mock.calls.length > count); mock.children.at(-1).stdout.write(output); await rejected;
    assert.equal(mock.children.at(-1).killed, true);
  }
});

test("worker error is sanitized and permits a clean next request on the warm worker", async (t) => {
  const mock = mockWorkers((child, request) => child.reply(mock.calls.length === 1 ? { id: request.id, error: "private C:/model/path" } : { id: request.id, text: "好了", duration_seconds: 1, processing_ms: 1 }));
  const { service } = await fixture(t, mock);
  await assert.rejects(service.transcribe(wav()), (error) => error.status === 422 && !error.message.includes("private"));
  assert.equal((await service.transcribe(wav())).text, "好了"); assert.equal(mock.children.length, 1);
});

test("dispose interrupts the active request and blocks new work", async (t) => {
  const mock = mockWorkers(() => {}); const { service } = await fixture(t, mock);
  const request = service.transcribe(wav()); const rejected = assert.rejects(request, { status: 503 });
  await waitFor(() => mock.calls.length === 1); service.dispose(); await rejected;
  assert.equal(mock.children[0].killed, true); assert.equal((await service.status()).ready, false);
  await assert.rejects(service.transcribe(wav()), { status: 503 });
});

test("idle model unloads and reloads on demand, without terminating active recognition", async (t) => {
  const mock = mockWorkers((child, request) => {
    if (mock.calls.length !== 2) child.reply({ id: request.id, text: "结果", duration_seconds: 1, processing_ms: 1 });
  });
  const { service } = await fixture(t, { ...mock, idleTimeoutMs: 25 });
  await service.transcribe(wav());
  const second = service.transcribe(wav());
  await waitFor(() => mock.calls.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(mock.children[0].killed, false);
  mock.children[0].reply({ id: mock.calls[1].id, text: "继续", duration_seconds: 1, processing_ms: 1 });
  await second;
  await waitFor(() => mock.children[0].killed);
  assert.equal((await service.status()).loaded, false); assert.equal((await service.status()).ready, true);
  assert.equal((await service.transcribe(wav())).text, "结果");
  assert.equal(mock.children.length, 2);
});

function httpPair(url = "/api/speech/transcribe", method = "POST") {
  const req = new PassThrough(); req.url = url; req.method = method; req.headers = { "content-type": "audio/wav" };
  const res = new EventEmitter(); res.headers = {}; res.writableEnded = false; res.destroyed = false;
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.writeHead = (status) => { res.status = status; };
  res.end = (body) => { res.body = JSON.parse(body); res.writableEnded = true; };
  return { req, res };
}

test("HTTP handler accepts raw WAV, no-store status and rejects wrong content types", async (t) => {
  const mock = mockWorkers(); const { service } = await fixture(t, mock);
  const pair = httpPair(); const handling = handleSpeechApi(service, pair.req, pair.res); pair.req.end(wav()); await handling;
  assert.equal(pair.res.status, 200); assert.equal(pair.res.body.text, "测试语音。");
  const status = httpPair("/api/speech/status", "GET"); await handleSpeechApi(service, status.req, status.res);
  assert.equal(status.res.headers["cache-control"], "no-store");
  const invalid = httpPair(); invalid.req.headers["content-type"] = "application/json";
  await assert.rejects(handleSpeechApi(service, invalid.req, invalid.res), { status: 415 });
  const huge = httpPair(); huge.req.headers["content-length"] = String(MAX_SPEECH_BYTES + 1);
  await assert.rejects(handleSpeechApi(service, huge.req, huge.res), { status: 413 });
});

test("HTTP disconnect cancels transcription and does not write a result", async (t) => {
  const mock = mockWorkers(() => {}); const { service } = await fixture(t, mock); const { req, res } = httpPair();
  const handling = handleSpeechApi(service, req, res); const rejected = assert.rejects(handling, { status: 499 }); req.end(wav());
  await waitFor(() => mock.calls.length === 1); res.emit("close"); await rejected;
  assert.equal(mock.children[0].killed, true); assert.equal(res.body, undefined);
  const alreadyClosed = httpPair(); alreadyClosed.res.destroyed = true;
  await assert.rejects(handleSpeechApi(service, alreadyClosed.req, alreadyClosed.res), { status: 499 });
  assert.equal(mock.children.length, 1);
});

test("speech preserves CSRF and host protection with exact audio content-type exception", () => {
  const req = { url: "/api/speech/transcribe", method: "POST", headers: { host: "127.0.0.1:3093", origin: "http://127.0.0.1:3093", "content-type": "audio/wav", "x-nexogenesis-csrf": "valid" } };
  assert.doesNotThrow(() => assertTrustedRequest(req, [], { csrfToken: "valid" }));
  for (const headers of [{ ...req.headers, "x-nexogenesis-csrf": "wrong" }, { ...req.headers, host: "malicious.example" }, { ...req.headers, origin: "https://malicious.example" }]) {
    assert.throws(() => assertTrustedRequest({ ...req, headers }, [], { csrfToken: "valid" }), { status: 403 });
  }
  assert.throws(() => assertTrustedRequest({ ...req, url: "/api/settings" }, [], { csrfToken: "valid" }), { status: 415 });
  assert.throws(() => assertTrustedRequest({ ...req, url: "/api/speech/transcribe/other" }, [], { csrfToken: "valid" }), { status: 415 });
});
