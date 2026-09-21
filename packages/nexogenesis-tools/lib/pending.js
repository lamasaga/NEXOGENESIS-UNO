/**
 * Pending write proposals: the approval hand-off between the model's
 * propose_write tool and the UI's ConfirmCard (/api/write/confirm).
 * Stored under $DSH_HOME so both the tool plugin and the web-host
 * compatibility layer can reach it; keys are randomUUID proposal ids.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadCards } from "./cards.js";

function pendingPath() {
	return join(process.env.DSH_HOME ?? homedir(), "nexogenesis-pending.json");
}

function readAll() {
	try {
		return JSON.parse(readFileSync(pendingPath(), "utf8"));
	} catch {
		return {};
	}
}

function writeAll(store) {
	const path = pendingPath();
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
}

const RELATION_EXPLANATIONS = {
	supports: "前一张卡可以为后一张卡提供理解上的依据。",
	"based-on": "后一张卡可以追溯到前一张卡的理论或证据基础。",
	extends: "前一张卡是在已有理解上继续展开的内容。",
	"example-of": "前一张卡是后一张卡的一个具体例子。",
	"conflicts-with": "两张卡存在值得保留和继续解释的分歧。",
	"part-of": "前一张卡是后一张卡的组成部分。",
	"applies-to": "前一张卡的分析可以用于理解后一张卡。",
	influences: "前一张卡描述的因素会影响后一张卡描述的现象或判断。",
	precedes: "前一张卡描述的事情在时间上先于后一张卡。",
	involves: "前一张卡所记录的冲突或问题明确涉及后一张卡。"
};

function titlesAt(root, operations) {
	const titles = new Map();
	if (root) for (const [id, card] of loadCards(root)) titles.set(id, String(card.meta.title ?? id));
	for (const operation of operations ?? []) titles.set(operation.id, String(operation.title ?? operation.id));
	return titles;
}

function relationKey(relation) {
	return `${relation?.type ?? ""}\u0000${relation?.target ?? ""}`;
}

function relationChanges(root, operations) {
	if (!root) return [];
	const cards = loadCards(root);
	const titles = titlesAt(root, operations);
	const changes = [];
	for (const operation of operations ?? []) {
		const before = cards.get(operation.id);
		const beforeKeys = new Set((before?.meta.relations ?? []).map(relationKey));
		for (const relation of operation.relations ?? []) {
			if (beforeKeys.has(relationKey(relation))) continue;
			changes.push({
				source: titles.get(operation.id) ?? operation.id,
				target: titles.get(relation.target) ?? relation.target,
				type: relation.type
			});
		}
	}
	return changes;
}

function domainChanges(root, operations) {
	if (!root) return [];
	const cards = loadCards(root);
	const titles = titlesAt(root, operations);
	const changes = [];
	for (const operation of operations ?? []) {
		const before = cards.get(operation.id);
		const previous = new Set(before?.meta.domains ?? []);
		const current = new Set(operation.domains ?? []);
		for (const domain of current) if (!previous.has(domain)) changes.push({ kind: "add", card: titles.get(operation.id) ?? operation.id, domain: titles.get(domain) ?? domain });
		for (const domain of previous) if (!current.has(domain)) changes.push({ kind: "remove", card: titles.get(operation.id) ?? operation.id, domain: titles.get(domain) ?? domain });
	}
	return changes;
}

function plainSummary(summary) {
	return String(summary ?? "")
		.replaceAll("supports", "提供理解依据")
		.replaceAll("based-on", "理论或证据基础")
		.replaceAll("extends", "延伸")
		.replaceAll("example-of", "例子")
		.replaceAll("conflicts-with", "分歧")
		.replaceAll("提供理解依据 边", "提供理解依据的联系")
		.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "这项提案")
		.trim();
}

/** Project a pending write into wording a reader can decide on without Card ids or relation codes. */
export function presentProposal({ root, summary, operations, layer }) {
	const titles = titlesAt(root, operations);
	const cards = root ? loadCards(root) : new Map();
	const reason = plainSummary(summary);
	if (layer === "relation") {
		const changes = relationChanges(root, operations);
		if (changes.length === 1) {
			const change = changes[0];
			return {
				title: "建议建立一条知识联系",
				explanation: `将《${change.source}》与《${change.target}》联系起来。${RELATION_EXPLANATIONS[change.type] ?? "这会让两张相关知识在后续使用时能够互相参照。"}`,
				reason,
				changes: [`让《${change.source}》成为理解《${change.target}》时可参照的知识。`],
				confirm_label: "确认保存这条联系",
				cancel_label: "不保存，继续寻找更合适的联系"
			};
		}
		return {
			title: "建议调整知识之间的联系",
			explanation: "这次只会调整知识卡之间的联系，不会改动卡片正文或领域归属。",
			reason,
			changes: changes.map((change) => `联系《${change.source}》与《${change.target}》`).slice(0, 3),
			confirm_label: "确认保存这些联系",
			cancel_label: "暂不保存"
		};
	}
	if (layer === "membership") {
		const changes = domainChanges(root, operations);
		return {
			title: "建议调整知识归属",
			explanation: "这次只调整卡片所属的领域，不会改动卡片正文或既有知识联系。",
			reason,
			changes: changes.map((change) => change.kind === "add" ? `将《${change.card}》归入《${change.domain}》` : `将《${change.card}》从《${change.domain}》移出`).slice(0, 3),
			confirm_label: "确认调整归属",
			cancel_label: "暂不调整"
		};
	}
	if (layer === "creation") return {
		title: "建议新增知识卡",
		explanation: "这会把已经整理好的内容作为新的知识卡保存下来。",
		reason,
		changes: (operations ?? []).map((operation) => `新增《${titles.get(operation.id) ?? operation.id}》`).slice(0, 3),
		confirm_label: "确认保存新卡",
		cancel_label: "暂不保存"
	};
	if (layer === "lifecycle") return {
		title: "建议调整知识卡状态",
		explanation: "这会调整卡片是否继续作为当前知识使用，不会删除原有内容。",
		reason,
		changes: (operations ?? []).map((operation) => {
			const previous = cards.get(operation.id);
			return `将《${titles.get(operation.id) ?? operation.id}》${previous?.meta.lifecycle === "active" && operation.lifecycle === "superseded" ? "标记为已被替代" : "更新为新的使用状态"}`;
		}).slice(0, 3),
		confirm_label: "确认调整状态",
		cancel_label: "暂不调整"
	};
	if (layer === "reclassification") return {
		title: "建议修正知识卡类型",
		explanation: "这会保留卡片的来源、领域归属、成熟度和既有联系，并把正文改写为新类型所需的结构；保存前已核对所有指向与离开本卡的知识联系。",
		reason,
		changes: (operations ?? []).map((operation) => {
			const previous = cards.get(operation.id);
			return `将《${titles.get(operation.id) ?? operation.id}》从“${previous?.meta.type ?? "未知类型"}”修正为“${operation.type}”`;
		}).slice(0, 3),
		confirm_label: "确认修正类型",
		cancel_label: "暂不修改"
	};
	return {
		title: "建议更新知识卡",
		explanation: "这次只会保存本轮已经核对过的知识内容。",
		reason,
		changes: (operations ?? []).map((operation) => `更新《${titles.get(operation.id) ?? operation.id}》`).slice(0, 3),
		confirm_label: "确认保存修改",
		cancel_label: "暂不保存"
	};
}

/** Store one proposal; returns its id. */
export function storeProposal({ root, summary, operations, warnings, session_id, run_id, layer, revisions, consumed_buffers, skipped_buffers, skip_reasons, deferred_items, contribution_map, integration_decisions, buffer_outcomes, buffer_revisions }) {
	const id = randomUUID();
	const store = readAll();
	store[id] = {
		proposal_id: id, summary, operations, warnings: warnings ?? [],
		presentation: presentProposal({ root, summary, operations, layer }),
		session_id: session_id ?? null, run_id: run_id ?? null,
		layer: layer ?? "content", revisions: revisions ?? {},
		consumed_buffers: consumed_buffers ?? [], skipped_buffers: skipped_buffers ?? [], skip_reasons: skip_reasons ?? {}, deferred_items: deferred_items ?? [],
		contribution_map: contribution_map ?? {},
		buffer_outcomes: buffer_outcomes ?? {}, buffer_revisions: buffer_revisions ?? {},
		integration_decisions: integration_decisions ?? {},
		created_at: new Date().toISOString()
	};
	writeAll(store);
	return store[id];
}

/** Read one proposal (or undefined). */
export function getProposal(id) {
	return readAll()[id];
}

/** Read the still-actionable proposals belonging to one Web session. */
export function listProposalsForSession(session_id) {
	return Object.values(readAll()).filter((proposal) => proposal?.session_id === session_id);
}

/** Remove one proposal; returns the removed record (or undefined). */
export function takeProposal(id) {
	const store = readAll();
	const proposal = store[id];
	if (proposal !== void 0) {
		delete store[id];
		writeAll(store);
	}
	return proposal;
}
