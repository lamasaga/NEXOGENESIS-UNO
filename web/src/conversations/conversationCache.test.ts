import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationWindow } from "../api/client";
import { clearConversationCache, readConversationCache, removeConversationCache, updateConversationCache, writeConversationCache } from "./conversationCache";

const page = (id: string, seqs: number[], history: Partial<ConversationWindow["history"]> = {}): ConversationWindow => ({
  id, project_id: "p", title: id, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  messages: seqs.map(seq => ({ id: `${id}:${seq}`, seq, role: seq % 2 ? "user" : "assistant", content: String(seq) })),
  history: { oldest_seq: seqs[0] ?? null, newest_seq: seqs.at(-1) ?? null, has_older: false, reset_required: false, ...history },
});

describe("conversation cache", () => {
  beforeEach(() => clearConversationCache());

  it("isolates identical conversation ids by knowledge instance", () => {
    writeConversationCache("a", page("same", [1]));
    writeConversationCache("b", page("same", [2]));
    expect(readConversationCache("a", "same")?.messages[0].seq).toBe(1);
    expect(readConversationCache("b", "same")?.messages[0].seq).toBe(2);
  });

  it("merges deltas without replacing unchanged message objects", () => {
    const first = writeConversationCache("a", page("chat", [1, 2]));
    const stable = first.messages[1];
    const next = writeConversationCache("a", page("chat", [2, 3], { oldest_seq: 2, newest_seq: 3 }), "delta");
    expect(next.messages.map(message => message.seq)).toEqual([1, 2, 3]);
    expect(next.messages[1]).toBe(stable);
  });

  it("prepends older pages and follows the server reset boundary", () => {
    writeConversationCache("a", page("chat", [5, 6], { has_older: true }));
    const older = writeConversationCache("a", page("chat", [3, 4], { has_older: false }), "older");
    expect(older.messages.map(message => message.seq)).toEqual([3, 4, 5, 6]);
    expect(older.history.has_older).toBe(false);
    const reset = writeConversationCache("a", page("chat", [20], { reset_required: true }), "delta");
    expect(reset.messages.map(message => message.seq)).toEqual([20]);
  });

  it("orders messages from different internal sessions by time instead of unrelated sequence counters",()=>{
    const first=page('owner',[100]);first.messages[0].ts='2026-01-01T00:00:02.000Z';
    writeConversationCache('a',first);
    const internal=page('owner',[]);internal.messages=[{id:'reviewer:2',seq:2,role:'assistant',content:'review',ts:'2026-01-01T00:00:03.000Z'}];
    const merged=writeConversationCache('a',internal,'delta');
    expect(merged.messages.map(message=>message.id)).toEqual(['owner:100','reviewer:2']);
  });

  it("keeps cached metadata aligned with rename, pin, and delete operations", () => {
    writeConversationCache("a", page("chat", [1]));
    updateConversationCache("a", "chat", { title: "改名", pinned: true });
    expect(readConversationCache("a", "chat")).toMatchObject({ title: "改名", pinned: true });
    removeConversationCache("a", "chat");
    expect(readConversationCache("a", "chat")).toBeNull();
  });
});
