import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationHistoryWindow } from "../packages/nexogenesis-web-host/lib/projects.js";
import { patchConversationExt } from "../packages/nexogenesis-web-host/lib/meta.js";

function historyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nexo-conversation-window-"));
  const oldHome = process.env.DSH_HOME;
  const oldFetch = globalThis.fetch;
  const calls = [];
  process.env.DSH_HOME = root;
  patchConversationExt("chat-window", { project_id: "p", title: "窗口会话" });
  globalThis.fetch = async (_url, init) => {
    const call = JSON.parse(init.body);
    calls.push(call);
    const events = [
      { event: { seq: 10, type: "user/message", time: 1000, data: { source: { kind: "user" }, content: [{ type: "text", text: "问题" }] } } },
      { event: { seq: 11, type: "assistant/message", time: 2000, data: { message: { content: [{ type: "text", text: "回答" }] } } } },
    ];
    return { json: async () => ({ type: "server-response", result: { ok: true, value: { events, hasMore: true } } }) };
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, calls, ctx: { webServer: { port: 9999 } } };
}

test("对话历史窗口按序号增量返回，并保留稳定消息标识", async t => {
  const f = historyFixture(t);
  const page = await conversationHistoryWindow(f.ctx, "chat-window", f.root, { afterSeq: 10, limit: 30 });
  assert.equal(f.calls[0].method, "session.history");
  assert.equal(f.calls[0].payload.maxMessages, 30);
  assert.equal(f.calls[0].payload.beforeSeq, undefined);
  assert.deepEqual(page.messages.map(message => [message.id, message.seq, message.content]), [["chat-window:11", 11, "回答"]]);
  assert.deepEqual(page.history, { oldest_seq: 11, newest_seq: 11, has_older: true, reset_required: false });
});

test("更早页使用 beforeSeq，增量游标落后窗口时要求替换", async t => {
  const f = historyFixture(t);
  await conversationHistoryWindow(f.ctx, "chat-window", f.root, { beforeSeq: 10, limit: 20 });
  assert.equal(f.calls[0].payload.beforeSeq, 10);
  const reset = await conversationHistoryWindow(f.ctx, "chat-window", f.root, { afterSeq: 1, limit: 20 });
  assert.equal(reset.history.reset_required, true);
  assert.equal(reset.messages.length, 2);
});

test("自定义快速消息即使不计入原生 maxMessages，也在接口层严格分页", async t => {
  const f = historyFixture(t);
  const page = await conversationHistoryWindow(f.ctx, "chat-window", f.root, { limit: 1 });
  assert.deepEqual(page.messages.map(message => message.seq), [11]);
  assert.deepEqual(page.history, { oldest_seq: 11, newest_seq: 11, has_older: true, reset_required: false });
});
