import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const list = (value) => Array.isArray(value) ? value : [];
const read = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

/** A read-only projection of existing task records, not another write authority. */
export function constructBacklog(root, { cursor = 0, limit = 12 } = {}) {
	const base = join(root, ".nexogenesis", "cognition", "runs");
	let dirs = [];
	try { dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no history */ }
	const runs = dirs.map((id) => ({ run: read(join(base, id, "run.json")), workspace: read(join(base, id, "workspace.json")) }))
		.filter((s) => s.run?.mode === "construct" && s.workspace)
		.sort((a, b) => String(a.run.updated_at).localeCompare(String(b.run.updated_at)));
	const items = new Map();
	for (const { run, workspace: w } of runs) {
		const add = (id, item) => items.set(id, { ...item, backlog_id: id, prior_run_id: run.run_id, prior_session_id: run.session_id });
		for (const issue of list(w.extension?.issue_ledger)) {
			if (!issue.fingerprint) continue;
			add(`issue:${issue.fingerprint}`, { kind: "structure_issue", status: issue.status ?? "open", card_id: issue.card_id,
				target_id: issue.target_id, issue_kind: issue.kind, reason: issue.detail, member_ids: issue.member_ids });
		}
		for (const plan of [...list(w.extension?.improvement_history), w.extension?.improvement_plan]) {
			if (plan?.id) add(`plan:${plan.id}`, { kind: "improvement", status: plan.status === "verified" ? "resolved" : plan.status,
				card_ids: plan.card_ids, reason: plan.problem, review: plan.review?.reason });
		}
		for (const entry of [...list(w.deferred_items), ...list(w.extension?.structural_debts), ...list(w.extension?.result?.pending)]) {
			const text = typeof entry === "string" ? entry : entry?.description ?? entry?.reason;
			const id = typeof entry?.backlog_id === "string" ? entry.backlog_id : `pending:${hash(text ?? entry)}`;
			// An explicit disposition is a semantic review, not proof of a successful write.
			if (entry?.backlog_id && ["resolved", "excluded"].includes(entry.status) && !String(entry.reason ?? "").trim()) continue;
			add(id, typeof entry === "string" ? { kind: "follow_up", status: "deferred", reason: entry }
				: { ...entry, kind: entry.kind ?? "follow_up", status: entry.status ?? "deferred" });
		}
	}
	const pending = [...items.values()].filter((item) => !["fixed", "resolved", "excluded", "kept", "verified"].includes(item.status));
	const start = Math.max(0, Math.trunc(Number(cursor) || 0)), cap = Math.min(30, Math.max(1, Math.trunc(Number(limit) || 12)));
	return { total: pending.length, cursor: start, next_cursor: start + cap < pending.length ? start + cap : null,
		items: pending.slice(start, start + cap),
		boundary: "历史待办是线索，不是当前证据或新授权。按当前范围重读对象、复验原问题，勿重放已提交操作；需续接原进度时继续原任务。" };
}
