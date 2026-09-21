import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { QUICK_MESSAGE_EVENT, registerUnoSessionEvents } from "../packages/nexogenesis-web-host/lib/session-events.js";

// Opt in against the same installed native host used by the application. A local
// copy of dsh-session would not prove that the host persistence catalog changed.
const nativeEntry = process.env.UNO_DSH_ENTRY;

test("native zstd sessions restore UNO messages, continue durably, and still reject unknown events", {
  skip: nativeEntry ? false : "Set UNO_DSH_ENTRY to the installed DSH CLI entrypoint for native persistence validation",
}, async t => {
  const requireHost = createRequire(resolve(nativeEntry));
  const importHost = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const native = await importHost("@deepseek-ai/dsh-session");
  const { Context } = await importHost("@deepseek-ai/cordis");
  const { JsonlSessionPersistence } = await importHost("@deepseek-ai/dsh-session-persistence-jsonl");
  const root = await mkdtemp(join(tmpdir(), "uno-native-session-events-"));
  const contexts = new Set();
  const alreadyKnown = native.KNOWN_SESSION_EVENT_TYPES.has(QUICK_MESSAGE_EVENT);
  // This test file has its own Node test process. Reproduce the unregistered
  // legacy reader even if another test in this file registers it in the future.
  native.KNOWN_SESSION_EVENT_TYPES.delete(QUICK_MESSAGE_EVENT);
  t.after(async () => {
    for (const ctx of [...contexts].reverse()) await ctx.fiber.dispose();
    if (alreadyKnown) native.KNOWN_SESSION_EVENT_TYPES.add(QUICK_MESSAGE_EVENT);
    else native.KNOWN_SESSION_EVENT_TYPES.delete(QUICK_MESSAGE_EVENT);
    await rm(root, { recursive: true, force: true });
  });

  const host = () => {
    const ctx = new Context();
    contexts.add(ctx);
    const sessions = new native.SessionStore(ctx);
    const persistence = new JsonlSessionPersistence(ctx, { root, compression: "zstd" });
    return { ctx, sessions, persistence };
  };
  const close = async instance => {
    await instance.ctx.fiber.dispose();
    contexts.delete(instance.ctx);
  };
  const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
  const quickData = events => events.filter(event => event.type === QUICK_MESSAGE_EVENT).map(event => event.data);
  const initialMessages = [
    { role: "user", content: "合成测试问题", receipt_id: "synthetic-receipt-1" },
    {
      role: "assistant", content: "合成测试回答", receipt_id: "synthetic-receipt-1", status: "completed",
      intent: { route: "direct" }, thinking_route: "direct", model_calls: 1,
      sources: [{ id: "synthetic-source", title: "合成资料", path: "synthetic/source.md" }],
    },
  ];

  const writer = host();
  const legacy = writer.sessions.create("session-legacy-quick", { meta: { cwd: root } });
  for (const message of initialMessages) legacy.append(QUICK_MESSAGE_EVENT, message);
  await writer.sessions.flush(legacy);
  assert.ok(legacy.events.every(event => event.ignorable === undefined), "reproduce legacy logs without an ignorable marker");
  const legacyPath = writer.persistence.locate(legacy.header).path;
  assert.ok(legacyPath.endsWith(".zstd"));
  const legacyHash = await hash(legacyPath);

  const unknown = writer.sessions.create("session-unknown-plugin", { meta: { cwd: root } });
  unknown.append("unrelated/future-event", { content: "must remain unsupported" });
  await writer.sessions.flush(unknown);
  const unknownPath = writer.persistence.locate(unknown.header).path;
  const unknownHash = await hash(unknownPath);
  await close(writer);

  const reader = host();
  assert.equal(reader.sessions.get(legacy.id), undefined);
  await assert.rejects(reader.persistence.load(legacy.id), error =>
    error.name === "SessionFormatUnsupportedError" && error.message.includes(QUICK_MESSAGE_EVENT));
  assert.equal(await hash(legacyPath), legacyHash, "refused reads do not rewrite the legacy artifact");

  await registerUnoSessionEvents(reader.ctx, nativeEntry);
  const loaded = await reader.persistence.load(legacy.id);
  assert.deepEqual(quickData(loaded.events), initialMessages);
  assert.equal(await hash(legacyPath), legacyHash, "registered reads preserve the original compressed bytes");
  assert.equal(reader.sessions.get(legacy.id), undefined, "cold inspection did not reuse a live writer");
  await assert.rejects(reader.persistence.load(unknown.id), error =>
    error.name === "SessionFormatUnsupportedError" && error.message.includes("unrelated/future-event"));
  assert.equal(await hash(unknownPath), unknownHash);

  // The loader path must import through the active native entry's own tree,
  // even when the fallback CLI entrypoint is unavailable.
  let loaderImports = 0;
  await registerUnoSessionEvents({
    get(name) {
      if (name === "loader") return {
        *entries() {
          yield {
            options: { name: "@deepseek-ai/dsh-session" },
            parent: { tree: { async import(specifier) {
              assert.equal(specifier, "@deepseek-ai/dsh-session");
              loaderImports += 1;
              return native;
            } } },
          };
        },
      };
      return reader.ctx.get(name);
    },
  }, undefined);
  assert.equal(loaderImports, 1);

  const preparation = await reader.persistence.prepare(legacy.id);
  const restored = preparation.session;
  const detach = reader.sessions.enter(restored);
  reader.ctx.effect(() => detach);
  reader.sessions.announce(restored);
  preparation[Symbol.dispose]();
  const continuation = [
    { role: "user", content: "合成追问", receipt_id: "synthetic-receipt-2" },
    { role: "assistant", content: "合成追问答复", receipt_id: "synthetic-receipt-2", status: "cancelled", detail: "synthetic cancellation" },
  ];
  for (const message of continuation) restored.append(QUICK_MESSAGE_EVENT, message);
  await reader.sessions.flush(restored);
  await close(reader);

  const nextReader = host();
  const continuedHash = await hash(legacyPath);
  const continued = await nextReader.persistence.load(legacy.id);
  assert.deepEqual(quickData(continued.events), [...initialMessages, ...continuation]);
  assert.deepEqual(continued.events.map(event => event.seq), continued.events.map((_, index) => index));
  assert.equal(await hash(legacyPath), continuedHash, "a second cold read leaves continued history unchanged");
  assert.equal(nextReader.sessions.get(legacy.id), undefined);
});
