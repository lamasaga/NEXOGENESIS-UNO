import type { ChatMessage, ConversationWindow } from "../api/client";

export type ConversationMergeMode = "tail" | "delta" | "older";

interface CacheEntry {
  value: ConversationWindow;
  touchedAt: number;
}

const MAX_ENTRIES = 10;
const MAX_MESSAGES_PER_ENTRY = 500;
const entries = new Map<string, CacheEntry>();

export const conversationCacheKey = (instanceId: string, conversationId: string) => `${instanceId}:${conversationId}`;

export function readConversationCache(instanceId: string, conversationId: string): ConversationWindow | null {
  const key = conversationCacheKey(instanceId, conversationId);
  const entry = entries.get(key);
  if (!entry) return null;
  entry.touchedAt = Date.now();
  return entry.value;
}

export function writeConversationCache(instanceId: string, page: ConversationWindow, mode: ConversationMergeMode = "tail"): ConversationWindow {
  const key = conversationCacheKey(instanceId, page.id);
  const previous = entries.get(key)?.value;
  const replace = !previous || page.history.reset_required;
  const messages = (replace ? page.messages : mergeMessages(previous.messages,page.messages)).slice(-MAX_MESSAGES_PER_ENTRY);
  const history = replace ? page.history : mergeHistory(previous, page, mode);
  const value: ConversationWindow = { ...previous, ...page, messages, history: { ...history, reset_required: false } };
  entries.set(key, { value, touchedAt: Date.now() });
  evict(key);
  return value;
}

export function updateConversationCache(instanceId: string, conversationId: string, update: { title?: string; pinned?: boolean }): void {
  const key = conversationCacheKey(instanceId, conversationId);
  const entry = entries.get(key);
  if (!entry) return;
  entry.value = { ...entry.value, ...update };
  entry.touchedAt = Date.now();
}

export function removeConversationCache(instanceId: string, conversationId: string): void {
  entries.delete(conversationCacheKey(instanceId, conversationId));
}

export function clearConversationCache(instanceId?: string): void {
  if (!instanceId) { entries.clear(); return; }
  const prefix = `${instanceId}:`;
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byKey = new Map<string, ChatMessage>();
  for (const message of current) byKey.set(messageKey(message), message);
  for (const message of incoming) {
    const key = messageKey(message);
    if (!byKey.has(key)) byKey.set(key, message);
  }
  return [...byKey.values()].sort((a, b) => {
    const aSession=messageSession(a),bSession=messageSession(b);
    if(aSession&&aSession===bSession&&a.seq!==undefined&&b.seq!==undefined)return a.seq-b.seq;
    return String(a.ts??'').localeCompare(String(b.ts??''))||String(a.id??'').localeCompare(String(b.id??''));
  });
}

function messageSession(message:ChatMessage):string|null{
  if(!message.id||message.seq===undefined)return null;
  const suffix=`:${message.seq}`;
  return message.id.endsWith(suffix)?message.id.slice(0,-suffix.length):null;
}

function mergeHistory(previous: ConversationWindow, page: ConversationWindow, mode: ConversationMergeMode) {
  if (mode === "older") return {
    oldest_seq: minimum(previous.history.oldest_seq, page.history.oldest_seq),
    newest_seq: maximum(previous.history.newest_seq, page.history.newest_seq),
    has_older: page.history.has_older,
    reset_required: false,
  };
  return {
    oldest_seq: previous.history.oldest_seq ?? page.history.oldest_seq,
    newest_seq: maximum(previous.history.newest_seq, page.history.newest_seq),
    has_older: previous.history.has_older,
    reset_required: false,
  };
}

function messageKey(message: ChatMessage): string {
  return message.id ?? `${message.role}:${message.ts ?? ""}:${message.content}`;
}

function minimum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maximum(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function evict(protectedKey: string): void {
  while (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.entries()]
      .filter(([key]) => key !== protectedKey)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]?.[0];
    if (!oldest) return;
    entries.delete(oldest);
  }
}
