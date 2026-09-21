import { HttpError } from "./rpc.js";
import { conversationExt, patchConversationExt } from "./meta.js";
import { selectActiveModel } from "./settings.js";

const textOf = message => (message.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");

/** Remove executable inputs at a user stop. Archive first; pausing must never launch a queued turn. */
export async function suspendInbox(ctx, sessionId, runId, action) {
  const service = name => ctx.get ? ctx.get(name) : ctx[name];
  const agents = service("agents");
  if (agents && !agents.get(sessionId)) await selectActiveModel(ctx, sessionId); // Load persisted inbox, without prompting a model.
  const agent = agents?.get(sessionId);
  if (agents && !agent) throw new HttpError(503, "原会话未能加载，尚未清理执行队列，请重试。");
  if (!agent) return; // Test/transport-only contexts have no in-process agent service.
  const goals = service("goals");
  if (goals?.get(agent)?.activation === "armed") goals.disarm(agent);
  if (!agent.inbox) return;
  const messages = [...agent.inbox.nextStep, ...agent.inbox.nextTurn];
  if (!messages.length) return;
  const history = conversationExt(sessionId).inbox_recovery ?? [];
  patchConversationExt(sessionId, { inbox_recovery: [...history, { run_id: runId, at: new Date().toISOString(), reason: `user_${action}`, messages }] });
  for (const message of messages) agent.inbox.remove(message.id);
  await service("sessions")?.flush(agent.session);
}

export function heldPauseMessages(runtime, state) {
  if (!state) return [];
  const entries = (conversationExt(state.run.session_id).inbox_recovery ?? []).filter(r => r.run_id === state.run.run_id && r.reason === "user_pause" && !r.restored_at);
  if (!entries.length) return [];
  const automatic = new Set(runtime.continuations(state.run.run_id).filter(c => c.kind === "pipeline_auto_continue").map(c => c.content));
  const messages = entries.flatMap(r => r.messages).filter(m => m.source?.kind !== "goal" && !automatic.has(textOf(m)));
  return [...new Map(messages.map(m => [m.id, m])).values()];
}

/** Unwrap only the host's frozen compile envelope; never treat arbitrary prose as a command. */
export function originalCompileRequest(text) {
  if (!text.includes("[COMPILE_CONTEXT_V1]")) return text;
  const start = text.indexOf("原请求："), end = text.lastIndexOf("\n来源范围与版本已冻结；");
  return start >= 0 && end > start ? text.slice(start + "原请求：".length, end) : text;
}

/** At an explicit idle-task resume, stale continuations must not precede the latest user request.
 * Archive before changing durable inbox events. Preserve other pending inputs in the same next step.
 */
export async function prepareResumeInbox(ctx, runtime, state, request) {
  const service = name => ctx.get ? ctx.get(name) : ctx[name];
  const agent = service("agents")?.get(state.run.session_id);
  if (!agent?.inbox) throw new HttpError(503, "原会话尚未加载，无法安全核对待执行队列，请重试恢复。");
  if (agent.status !== "idle") throw new HttpError(409, "原会话仍在执行，不能重排恢复队列。");
  const queued = [...agent.inbox.nextStep, ...agent.inbox.nextTurn];
  const messages = [...new Map([...queued, ...heldPauseMessages(runtime, state)].map(m => [m.id, m])).values()];
  if (!messages.length) return { archived: 0, preserved: 0 };
  const automatic = new Set(runtime.continuations(state.run.run_id).filter(c => c.kind === "pipeline_auto_continue").map(c => c.content));
  const history = conversationExt(state.run.session_id).inbox_recovery ?? [];
  const archived = new Set(history.flatMap(r => r.messages.map(m => m.id)));
  const fresh = messages.filter(m => !archived.has(m.id));
  if (fresh.length) patchConversationExt(state.run.session_id, { inbox_recovery: [...history, {
    run_id: state.run.run_id, at: new Date().toISOString(), reason: "explicit_task_resume", messages: fresh
  }] });
  const unique = new Set(), preserved = [];
  for (const message of messages) {
    const text = textOf(message);
    if (message.source?.kind === "goal" || automatic.has(text)) continue;
    const plainText = (message.content ?? []).every(b => b.type === "text");
    const original = plainText ? originalCompileRequest(text) : text;
    if (plainText && original === request) continue; // an earlier undelivered attempt at this very resume
    const key = JSON.stringify(plainText ? original : message.content);
    if (unique.has(key)) continue;
    unique.add(key);
    preserved.push(plainText ? { ...message, content: [{ type: "text", text: original }] } : message);
  }
  // Public Inbox API records removals and insertions for native replay; never edit session logs.
  for (const message of queued) agent.inbox.remove(message.id);
  for (const message of preserved) agent.inbox.append("next-step", message);
  await service("sessions")?.flush(agent.session);
  patchConversationExt(state.run.session_id, { inbox_recovery: (conversationExt(state.run.session_id).inbox_recovery ?? []).map(r => r.run_id === state.run.run_id && r.reason === "user_pause" && !r.restored_at ? { ...r, restored_at: new Date().toISOString() } : r) });
  return { archived: fresh.length, preserved: preserved.length };
}
