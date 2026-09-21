import { isConversationAnalysis } from "../../nexogenesis-tools/lib/cognition/conversation-analysis.js";
import { reasonOf } from "./turn-state.js";

/** Read only committed visible message events, never chunks/reasoning or a tool's finish claim. */
export function deliveryFromHistory(state, history, end) {
  const turn = String(state.run.host_turn_id ?? "");
  if (!turn || String(end.data?.turn) !== turn || !Number.isInteger(end.seq)) return null;
  const events = (history.events ?? []).map(entry => entry.event ?? entry);
  if (!events.some(event => event.type === "turn/end" && event.seq === end.seq && String(event.data?.turn) === turn)) return null;
  const owned = events.filter(event => String(event.data?.turn) === turn && event.seq < end.seq);
  const lastMessage = owned.filter(event => event.type === "assistant/message").at(-1);
  const content = lastMessage?.data?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(item => item.type === "text").map(item => item.text).join("") : "";
  const { kind } = reasonOf(end.data?.reason);
  if (kind !== "completed") return { state: owned.some(event => event.type === "assistant/chunk") || text.trim() ? "interrupted" : state.run.delivery?.state ?? "none", message_ref: null };
  if (!text.trim() || !Number.isInteger(lastMessage?.seq) || (Array.isArray(content) && content.some(item => item.type === "tool-call"))
    || owned.some(event => event.seq > lastMessage.seq && ["tool/call", "tool/result", "agent/inbox/spliced", "user/message"].includes(event.type))) return null;
  if (state.run.delivery?.state === "prepared" && new Date(lastMessage.time).getTime() < Date.parse(state.run.delivery.prepared_at)) return null;
  return { state: "delivered", message_ref: `${state.run.session_id}:${lastMessage.seq}`, turn_id: turn };
}

/** Called on live end and on read-side recovery; failure never invents delivery or re-prompts the model. */
export async function reconcileAnalysisDelivery(ctx, runtime, state, liveEnd) {
  if (!isConversationAnalysis(state)) return false;
  if (state.run.delivery?.state === "delivered" && state.run.status === "closed") return true;
  let end = liveEnd ?? state.run.delivery_end;
  if (end && state.run.host_turn_id != null && String(end.data?.turn) !== String(state.run.host_turn_id)) return true;
  let history = { events: [] };
  try {
    const sessions = ctx.get?.("sessions") ?? ctx.sessions;
    const persistence = ctx.get?.("sessionPersistence") ?? ctx.sessionPersistence;
    const session = sessions?.get(state.run.session_id);
    // session.history/inspect may return memory or synthetic recovery events. Only
    // readFrom is a physical suffix read; live sessions first pass the fsync barrier.
    const hasEnd = session?.events.some(event => event.type === "turn/end" && (!end || event.seq === end.seq)
      && (state.run.host_turn_id == null || String(event.data?.turn) === state.run.host_turn_id));
    if (persistence?.readFrom && (!session || (hasEnd && await sessions.flush(session) === true))) {
      history = await persistence.readFrom(state.run.session_id, state.run.host_turn_seq ?? 0);
    }
  } catch { /* No durability claim. Read-side recovery retries without generating an answer. */ }
  if (state.run.host_turn_id == null && runtime.conversationTurn(state.run.session_id)?.id === state.run.host_admission_id) {
    const start = (history.events ?? []).map(entry => entry.event ?? entry).find(event => event.type === "turn/start"
      && new Date(event.time).getTime() >= Date.parse(runtime.conversationTurn(state.run.session_id).admitted_at));
    if (start) { runtime.bindConversationTurn(state.run.session_id, start); state = runtime.get(state.run.run_id); }
  }
  if (!end) end = (history.events ?? []).map(entry => entry.event ?? entry).find(event => event.type === "turn/end" && String(event.data?.turn) === String(state.run.host_turn_id));
  if (!end || state.run.host_turn_id == null) return true;
  const { kind, detail } = reasonOf(end.data?.reason);
  const fresh = runtime.get(state.run.run_id);
  if (!fresh || fresh.run.host_admission_id !== state.run.host_admission_id) return true;
  runtime.settleAnalysisDelivery(state.run.run_id, { end, kind, detail, delivery: deliveryFromHistory(fresh, history, end) });
  return true;
}
