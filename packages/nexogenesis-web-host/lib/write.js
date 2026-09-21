import { isRetiredIngestion, assertCurrentKnowledgeExecution, RETIRED_INGESTION_MESSAGE } from './knowledge-task-access.js';
/**
 * /api/write/confirm and /api/candidates/prepare compatibility handlers.
 *
 * confirm_write executes an approval-gated card write: takes the pending
 * proposal stored by the model's propose_write tool, re-validates every
 * operation, commits atomically into 01-Cards/ (staging then rename), and
 * appends a Journal entry. Nothing is written before the user confirms.
 */
import { HttpError, json, readJsonBody } from "./rpc.js";
import { getProposal, takeProposal } from "../../nexogenesis-tools/lib/pending.js";
import { HarnessGateway, HarnessRejected } from "../../nexogenesis-tools/lib/harness/gateway.js";
import { makeHarnessReceipt } from "../../nexogenesis-tools/lib/cognition/observations.js";
import { getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { queueCognitiveContinuation } from "./cognition.js";
import { broadcastCognitiveEvent } from "./events-bus.js";
import { projectCognitiveEvent } from "./cognitive-events.js";
import { assertOwnedConversation } from "./projects.js";
import { assertCurrentRun } from "./conversation-control.js";

async function returnReceiptToLoop(ctx, projectRoot, proposal, receipt) {
	try {
		if (proposal.run_id) {
			const runtime = getCognitiveRuntime(projectRoot);
			runtime.record(proposal.run_id, {
				action: { operator: "user_write_decision", mode: "runtime-write", proposal_id: proposal.proposal_id },
				observation: receipt
			});
			const state = runtime.get(proposal.run_id);
			assertCurrentKnowledgeExecution(state);
			runtime.setStatus(proposal.run_id, "running");
			if (proposal.session_id) {
				const state = runtime.get(proposal.run_id);
				if (state) broadcastCognitiveEvent(proposal.session_id, projectCognitiveEvent({
					sessionId: proposal.session_id,
					state,
					operator: "user_write_decision",
					phase: "observed",
					projectRoot
				}));
			}
		}
		if (!proposal.session_id) return true;
		const compact = JSON.stringify(receipt);
		if (!proposal.run_id) return false;
		return queueCognitiveContinuation(ctx, projectRoot, {
			runId: proposal.run_id,
			sessionId: proposal.session_id,
			kind: "harness_receipt",
			prompt: `[HARNESS_RECEIPT]\n这是系统对你刚才提案的结构化观察，不是新的用户任务。把它更新进当前 Workspace，并继续自主判断下一步；若被拒绝，应修复、换动作或缩小范围，不要机械结束。\n${compact}`
		});
	} catch (error) {
		console.error("nexogenesis: Harness 收据回流失败", error);
		return false;
	}
}

/** POST /api/write/confirm {proposal_id, decision} → {applied, ...} */
export async function handleWriteConfirm(ctx, req, res, _trustedHosts, projectRoot) {
	const body = await readJsonBody(req);
	const { proposal_id, decision } = body;
	if (typeof proposal_id !== "string" || proposal_id === "") throw new HttpError(400, "proposal_id 为必填");
	const proposal = getProposal(proposal_id);
	if (proposal === void 0) throw new HttpError(404, `提案不存在: ${proposal_id}`);
	if (proposal.session_id) assertOwnedConversation(proposal.session_id);
  if (proposal.run_id && isRetiredIngestion(getCognitiveRuntime(projectRoot).get(proposal.run_id))) {
    if (decision === 'confirm') throw new HttpError(409, RETIRED_INGESTION_MESSAGE);
    takeProposal(proposal_id);
    return json(res,200,{applied:false,detail:'旧流程提案已取消，历史任务不会恢复。'});
  }
	if (proposal.session_id && getCognitiveRuntime(projectRoot).discussionTask(proposal.session_id)) throw new HttpError(409, "当前是暂停后的只读讨论，请先返回原建构再处理提案。");
	if (proposal.run_id) assertCurrentRun(getCognitiveRuntime(projectRoot), getCognitiveRuntime(projectRoot).get(proposal.run_id));

	if (decision !== "confirm") {
		takeProposal(proposal_id);
		const receipt = makeHarnessReceipt({
			operator: "harness.user_decision", accepted: false,
			summary: "用户没有授权本次微变更，知识体保持不变。",
			reason_code: "user_rejected",
			alternatives: [
				{ action: "revise_proposal", description: "根据用户意图缩小或修订提案" },
				{ action: "continue_readonly", description: "继续只读审视并汇报发现" }
			]
		});
		await returnReceiptToLoop(ctx, projectRoot, proposal, receipt);
		json(res, 200, { applied: false, detail: "提案已取消，Agent 将继续判断", receipt });
		return;
	}

	try {
		const receipt = new HarnessGateway(projectRoot).commit(proposal);
		takeProposal(proposal_id);
		await returnReceiptToLoop(ctx, projectRoot, proposal, receipt);
		json(res, 200, {
			applied: true,
			created: receipt.data?.created ?? [], enriched: receipt.data?.enriched ?? [],
			warnings: proposal.warnings ?? [], receipt
		});
	} catch (error) {
		if (!(error instanceof HarnessRejected)) throw error;
		takeProposal(proposal_id);
		await returnReceiptToLoop(ctx, projectRoot, proposal, error.receipt);
		json(res, 200, { applied: false, detail: error.receipt.summary, receipt: error.receipt });
	}
}

/** POST /api/candidates/prepare → minimal (candidate flow folded into propose_write in M3). */
export async function handleCandidatePrepare(ctx, _req, res, _trustedHosts) {
	json(res, 200, {
		prepared: false,
		detail: "涌现候选已直接转为写入提案：请在对话中确认弹窗"
	});
}

export { HttpError };
