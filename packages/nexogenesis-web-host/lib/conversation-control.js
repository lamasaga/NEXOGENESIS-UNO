import { unoConversationJob, isUnoJobRunning, unoJobEnded } from "./uno-jobs.js";
import { isQuickThinkingRunning } from "./quick-thinking.js";
import { HttpError, json, readJsonBody, rpcCall } from "./rpc.js";
import { assertOwnedConversation } from "./projects.js";
import { conversationExt, patchConversationExt } from "./meta.js";
import { getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { suspendInbox } from "./resume-inbox.js";
import { listProposalsForSession } from "../../nexogenesis-tools/lib/pending.js";

const admissions = new Set();
export async function withConversationAdmission(id, action) {
  if (admissions.has(id)) throw new HttpError(409, "另一条对话指令正在处理，请稍后重试。");
  admissions.add(id);
  try { return await action(); } finally { admissions.delete(id); }
}

export function assertCurrentRun(runtime, state) {
	if (state && conversationExt(state.run.session_id).execution_control) throw new HttpError(409, "正在停止当前执行，请稍后操作。");
  if (!state || runtime.current(state.run.session_id)?.run.run_id !== state.run.run_id
    || runtime.discussionTask(state.run.session_id)?.run.run_id === state.run.run_id) {
    throw new HttpError(409, "这项操作属于暂停的旧运行，请先返回原任务。");
  }
}

/** Finish the already-authorized transition after turn/end, even if the browser closes. */
export function completeRequestedDiscussion(runtime, sessionId) {
  const requested = conversationExt(sessionId).discussion_requested;
  if (!requested) return false;
  if (runtime.discussionTask(sessionId, { summary: true })) {
    patchConversationExt(sessionId, { discussion_requested: null });
    return true;
  }
  const state = runtime.current(sessionId, { summary: true });
  if (state?.run.run_id !== requested || !["compile", "theme_compile", "digest", "construct"].includes(state.run.mode)) {
    patchConversationExt(sessionId, { discussion_requested: null });
    return false;
  }
  if (state.run.status !== "completed") runtime.setStatus(requested, "paused", "原工作已暂停；保留已提交结果、待办与累计预算，进入只读讨论。");
  runtime.beginDiscussion(sessionId);
  patchConversationExt(sessionId, { discussion_requested: null });
  return true;
}

/** Explicit pause/discuss/restore; never changes scope, budget or a pending decision. */
export async function handleConversationControl(ctx, req, res, _hosts, root, sessionId) {
  assertOwnedConversation(sessionId);
  const body = await readJsonBody(req);
  return withConversationAdmission(sessionId, async () => {
    const job=unoConversationJob(root,sessionId);
    if(job){
      if(job.id!==body.run_id)throw new HttpError(409,'工作运行已变化，请刷新后重试。');
      if(sessionId!==(job.owner_session_id??job.session_id))throw new HttpError(409,'请回到主会话控制工作。');
      if(isUnoJobRunning(sessionId)||isQuickThinkingRunning(sessionId))throw new HttpError(409,'请先暂停执行，再讨论或恢复。');
      if(body.action!=='discuss')throw new HttpError(400,'请使用继续工作入口恢复原任务。');
      patchConversationExt(sessionId,{uno_discussing:true});
      return json(res,200,{ready:true,ended:unoJobEnded(job)});
    }
    const runtime = getCognitiveRuntime(root);
    const session = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === sessionId);
    let current = runtime.current(sessionId);
    if (conversationExt(sessionId).execution_control) throw new HttpError(409, "正在停止执行，请稍后操作。");
    if (body.action === "discuss") {
      if (runtime.discussionTask(sessionId)) return json(res, 200, { ready: true });
      if (!["compile", "theme_compile", "digest", "construct"].includes(current?.run.mode) || current.run.run_id !== body.run_id) throw new HttpError(409, "工作运行已变化，请刷新后重试。");
      if (session?.running) {
        const requested = conversationExt(sessionId).discussion_requested === body.run_id;
        patchConversationExt(sessionId, { discussion_requested: body.run_id, suspend_requested: true });
        runtime.requestPauseAfterBoundary(body.run_id);
        if (!requested) {
          try {
            // Cancellation is the same supported pause mechanism used by WorkCenter.
            // Wait for the host to report idle before switching the current Run.
            await suspendInbox(ctx, sessionId, body.run_id, "pause");
            await rpcCall(ctx, "session.cancel", { sessionId });
          } catch (error) {
            patchConversationExt(sessionId, { discussion_requested: null });
            throw error;
          }
        }
        return json(res, 202, { ready: false });
      }
      await suspendInbox(ctx, sessionId, body.run_id, "pause");
      if (current.run.status !== "completed") runtime.setStatus(body.run_id, "paused", "用户暂停工作并进入只读讨论；恢复时先核对已提交与未完成的操作。");
      runtime.beginDiscussion(sessionId);
      patchConversationExt(sessionId, { discussion_requested: null });
      return json(res, 200, { ready: true });
    }
    if (body.action !== "restore") throw new HttpError(400, "未知对话操作。");
    if (session?.running) throw new HttpError(409, "当前讨论尚未结束，请稍后恢复。");
    const task = runtime.discussionTask(sessionId);
    if (!task || task.run.run_id !== body.run_id) throw new HttpError(409, "恢复目标已变化。");
    if (runtime.currentInteraction(sessionId)?.status === "pending") throw new HttpError(409, "请先处理当前讨论的问题。");
    // An unused lightweight discussion Run is allowed to close; analysis never auto-passes its gate.
    if (current?.run.status === "running") runtime.setStatus(current.run.run_id, "blocked", "用户结束讨论并返回原工作；未通过的分析保持未完成。");
    runtime.restoreDiscussionTask(sessionId, body.run_id);
    const waiting = Boolean(runtime.currentInteraction(sessionId)?.status === "pending"
      || listProposalsForSession(sessionId).length || conversationExt(sessionId).native_question);
    if (waiting) runtime.setStatus(body.run_id, "waiting_user", "已返回原工作，请处理此前保留的待办。");
    patchConversationExt(sessionId, { discussion_requested: null });
    json(res, 200, { ready: true, waiting });
  });
}
