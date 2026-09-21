import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProposalsForSession, storeProposal, takeProposal } from "../packages/nexogenesis-tools/lib/pending.js";

const home = mkdtempSync(join(tmpdir(), "nexo-pending-"));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;

try {
	const first = storeProposal({
		session_id: "conversation-a",
		summary: "等待确认的第一项写入",
		operations: [],
		layer: "content"
	});
	storeProposal({
		session_id: "conversation-b",
		summary: "另一段对话的提案",
		operations: [],
		layer: "content"
	});

	assert.deepEqual(
		listProposalsForSession("conversation-a").map((proposal) => proposal.proposal_id),
		[first.proposal_id],
		"恢复会话时只能取回属于当前对话的待确认提案"
	);
	takeProposal(first.proposal_id);
	assert.deepEqual(listProposalsForSession("conversation-a"), [], "已处理的提案不能再次作为确认卡恢复");
	console.log("PASS pending proposals: 会话隔离与已处理提案过滤");
} finally {
	if (previousDshHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousDshHome;
	rmSync(home, { recursive: true, force: true });
}
