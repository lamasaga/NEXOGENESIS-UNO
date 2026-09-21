import { prepareBookSource, saveBookCards, archiveCompletedBook, reconcileArchivedBookInboxCopy } from '../uno/book-store.js';
import { migrateBookMaterialStorage } from '../uno/book-storage-migration.js';
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendJournal, commitCard, loadCards, validateCardRecord } from "../cards.js";
import { makeHarnessReceipt } from "../cognition/observations.js";
import { auditCardQuality, newBlockingFindings } from "./knowledge-quality.js";
import { listDomainsV2, writeDomain } from "../uno/knowledge.js";
import { validateCardClassification } from '../uno/card-classification.js';
import { stageKnowledge, publishKnowledge, publishConstructionDomains } from "../uno/drafts.js";
import { applyDomainGovernance } from '../uno/domain-governance.js';
import { createDomainFromUnassignedCard, deleteUnassignedCard } from '../uno/card-management.js';
import {
	allowedSignature, CARD_TYPES, relationAlternatives, validateRelationReadiness, validateRelationSemantics
} from "./relation-semantics.js";

function hashFile(path) {
	if (!existsSync(path)) return null;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cardPath(root, id) { return join(root, "01-Cards", `${id}.md`); }
function journalPath(root) { return join(root, "06-Journal", `${new Date().toISOString().slice(0, 10)}.md`); }

function backupFile(path) {
	return { path, existed: existsSync(path), content: existsSync(path) ? readFileSync(path, "utf8") : null };
}

function restoreFiles(backups) {
	for (const backup of backups) {
		if (backup.existed) {
			mkdirSync(join(backup.path, ".."), { recursive: true });
			writeFileSync(backup.path, backup.content, "utf8");
		} else if (existsSync(backup.path)) unlinkSync(backup.path);
	}
}

function currentRecords(root, pending = []) {
	const records = new Map();
	for (const [id, card] of loadCards(root)) records.set(id, comparableExisting(card, id));
	for (const card of pending) records.set(card.id, card);
	return records;
}

function relationShape(relations) {
	return JSON.stringify((relations ?? []).map((relation) => ({
		target: relation?.target, type: relation?.type, note: String(relation?.note ?? "")
	})));
}

function changedRelations(beforeRelations, afterRelations) {
	const before = new Map((beforeRelations ?? []).map((relation) => [
		`${relation?.type ?? ""}\u0000${relation?.target ?? ""}`,
		String(relation?.note ?? "")
	]));
	return (afterRelations ?? []).filter((relation) => {
		const key = `${relation?.type ?? ""}\u0000${relation?.target ?? ""}`;
		return !before.has(key) || before.get(key) !== String(relation?.note ?? "");
	});
}

function comparableExisting(card, id) {
	const core = new Set([
		"id", "title", "type", "maturity", "lifecycle", "domains", "origin", "sources",
		"relations", "created", "updated", "body", "metadata"
	]);
	const metadata = Object.fromEntries(Object.entries(card.meta ?? {}).filter(([key]) => !core.has(key)));
	return {
		id,
		title: String(card.meta.title ?? id), type: String(card.meta.type ?? "unknown"),
		maturity: String(card.meta.maturity ?? "growing"), lifecycle: String(card.meta.lifecycle ?? "active"),
		domains: Array.isArray(card.meta.domains) ? card.meta.domains : [], origin: String(card.meta.origin ?? "user"),
		relations: Array.isArray(card.meta.relations) ? card.meta.relations : [],
		sources: Array.isArray(card.meta.sources) ? card.meta.sources : [], metadata, body: card.body
	};
}

function changedFields(before, after) {
	return ["title", "type", "maturity", "lifecycle", "domains", "origin", "relations", "sources", "metadata", "body"]
		.filter((key) => {
			const left = key === "metadata" ? Object.fromEntries(Object.entries(before[key] ?? {}).sort(([a], [b]) => a.localeCompare(b))) : before[key];
			const right = key === "metadata" ? Object.fromEntries(Object.entries(after[key] ?? {}).sort(([a], [b]) => a.localeCompare(b))) : after[key];
			return JSON.stringify(left) !== JSON.stringify(right);
		});
}

const LAYER_FIELDS = {
	content: new Set(["title", "body"]),
	relation: new Set(["relations"]),
	membership: new Set(["domains"]),
	lifecycle: new Set(["lifecycle"]),
	sources: new Set(["sources"]),
	origin: new Set(["origin"]),
	maturity: new Set(["maturity"]),
	reclassification: new Set(["title", "type", "metadata", "body"])
};

const ENTITY_KINDS = new Set(["person", "organization", "institution", "school", "legal-instrument", "collective", "artifact", "other"]);

function incomingSignatureViolations(cardsById, changedTypeIds) {
	const violations = [];
	for (const [sourceId, source] of cardsById) {
		for (const [index, relation] of (source.relations ?? source.meta?.relations ?? []).entries()) {
			const targetId = String(relation?.target ?? "");
			if (!changedTypeIds.has(targetId)) continue;
			const sourceType = source.type ?? source.meta?.type;
			const target = cardsById.get(targetId);
			const targetType = target?.type ?? target?.meta?.type;
			if (!allowedSignature(String(relation?.type ?? ""), sourceType, targetType)) violations.push({
				card_id: targetId,
				code: "incoming_relation_signature_invalidated",
				field: `incoming:${sourceId}.relations[${index}]`,
				detail: `重分类会使入边失效：${relation?.type}: ${sourceType} -> ${targetType}（来源：${sourceId}）`
			});
		}
	}
	return violations;
}

export class HarnessRejected extends Error {
	constructor(receipt) {
		super(receipt.summary);
		this.name = "HarnessRejected";
		this.receipt = receipt;
	}
}

export class HarnessGateway {
	constructor(root) { this.root = resolve(root); }
    prepareBookSource(input) { return prepareBookSource(this.root, input); }
    checkBookCards(input) { return saveBookCards(this.root, { ...input, check_only: true }); }
    saveBookCards(input) { return saveBookCards(this.root, input); }
    archiveCompletedBook(input) { return archiveCompletedBook(this.root, input); }
    reconcileArchivedBookInboxCopy(input) { return reconcileArchivedBookInboxCopy(this.root, input); }
    migrateBookMaterialStorage(input) { return migrateBookMaterialStorage(this.root, input); }
    applyDomainGovernance(input) { return applyDomainGovernance(this.root, input); }
    createDomainFromUnassignedCard(input) { return createDomainFromUnassignedCard(this.root, input); }
    deleteUnassignedCard(input) { return deleteUnassignedCard(this.root, input); }
    writeDomain(input) { return writeDomain(this.root, input); }
    stageUnoKnowledge(input) { return stageKnowledge(this.root, input); }
    publishUnoDomainAssignments(input) { return publishConstructionDomains(this.root, input); }
    publishUnoKnowledge(input) { return publishKnowledge(this.root, input); }

	preflight({ operations, layer = "content" }) {
		if (!Array.isArray(operations) || operations.length < 1 || operations.length > 3) {
			throw new HarnessRejected(makeHarnessReceipt({
				operator: "harness.preflight", accepted: false,
				summary: "一次提案必须包含 1–3 个紧密相关原子操作。",
				reason_code: "batch_size_out_of_range",
				alternatives: [
					{ action: "split_batch", description: "只保留当前结构层面的 1–3 项操作" },
					{ action: "simulate_first", description: "先模拟影响，再选择一个最小可写动作" }
				]
			}));
		}
		const duplicateIds = operations.map((card) => card?.id).filter((id, index, ids) => id && ids.indexOf(id) !== index);
		if (duplicateIds.length) {
			throw new HarnessRejected(makeHarnessReceipt({
				operator: "harness.preflight", accepted: false,
				summary: `同一提案不能重复修改 Card ${duplicateIds[0]}，否则后写版本会覆盖前写版本。`,
				reason_code: "duplicate_card_operation",
				alternatives: [
					{ action: "merge_operations", description: "合并为一个最终 Card 版本" },
					{ action: "split_sequentially", description: "先提交一项，重新读取后再提交下一项" }
				]
			}));
		}
		const cards = operations.map(validateCardRecord);
		const existingCards = loadCards(this.root);
		const records = currentRecords(this.root, cards);
		const domainCatalog = listDomainsV2(this.root);
		const violations = [];
		const quality = [];
		const changedTypeIds = new Set();
		if (layer === "lifecycle") {
			const retiring = new Set(cards.filter((card) => ["superseded", "archived"].includes(card.lifecycle)).map((card) => card.id));
			for (const [id, record] of records) {
				if (retiring.has(id) || ["superseded", "archived"].includes(record.lifecycle)) continue;
				for (const relation of record.relations ?? []) if (retiring.has(relation.target)) violations.push({
					card_id: relation.target, code: "retirement_has_active_inbound", field: "lifecycle",
					detail: `活跃卡 ${id} 仍引用该对象；先核对并迁移入边，不能退役后令引用失效。`
				});
			}
		}
		for (const card of cards) {
			const existing = existingCards.get(card.id);
			const afterQuality = auditCardQuality(card, { root: this.root });
			quality.push(afterQuality);
			if (!existing && layer !== "creation") {
				violations.push({ card_id: card.id, code: "creation_layer_required", field: "layer", detail: `新建卡必须使用 creation，当前为 ${layer}` });
			} else if (!existing) {
				violations.push(...afterQuality.findings.filter((item) => item.severity === "error").map((item) => ({ card_id: card.id, ...item })));
			} else if (existing) {
				const allowed = LAYER_FIELDS[layer];
				if (!allowed) violations.push({ card_id: card.id, code: "unknown_change_layer", field: "layer", detail: layer });
				else {
					const changed = changedFields(comparableExisting(existing, card.id), card);
					const crossLayer = changed.filter((field) => !allowed.has(field));
					if (crossLayer.length) {
						// 跨层字段已经说明这不是可执行的内容变更。到这里立即停止
						// 该卡的后续关系校验，避免把历史关系问题混进同一张回执。
						violations.push({ card_id: card.id, code: "cross_layer_mutation", field: crossLayer.join(","), detail: `${layer} 提案的元数据发生漂移：${crossLayer.join(", ")}` });
						continue;
					}
					if (layer === "reclassification") {
						if (!CARD_TYPES.has(card.type)) violations.push({ card_id: card.id, code: "unknown_card_type", field: "type", detail: card.type });
						if (!changed.includes("type")) violations.push({ card_id: card.id, code: "reclassification_type_unchanged", field: "type", detail: "重分类必须把卡片改为另一种知识对象类型。" });
						else changedTypeIds.add(card.id);
						violations.push(...afterQuality.findings.filter((item) => item.severity === "error").map((item) => ({ card_id: card.id, ...item })));
						const entityKind = String(card.metadata?.entity_kind ?? "").trim();
						if (card.type === "entity" && !ENTITY_KINDS.has(entityKind)) violations.push({
							card_id: card.id, code: "entity_kind_required_for_reclassification", field: "metadata.entity_kind",
							detail: "重分类为实体卡时必须选择合法的 entity_kind。"
						});
						if (card.type !== "entity" && (card.metadata?.entity_kind !== void 0 || card.metadata?.aliases !== void 0)) violations.push({
							card_id: card.id, code: "stale_entity_metadata", field: "metadata",
							detail: "离开实体类型时必须清除 entity_kind 与 aliases，避免 OPS 继续把它当作实体。"
						});
					}
					if (layer === "content") {
						const beforeQuality = auditCardQuality(comparableExisting(existing, card.id), { root: this.root });
						violations.push(...newBlockingFindings(beforeQuality, afterQuality).map((item) => ({
							card_id: card.id, ...item, code: "quality_regression", detail: `本次修改新增质量缺口：${item.detail}`
						})));
					}
				}
			}
			const domainChanged = !existing || JSON.stringify(existing.meta.domains ?? []) !== JSON.stringify(card.domains ?? []);
			const typeChanged = Boolean(existing && existing.meta.type !== card.type);
			if (domainChanged || typeChanged) for (const issue of validateCardClassification(card, domainCatalog).issues) {
				violations.push({ card_id: card.id, code: issue.code.toLowerCase(), field: issue.code === 'INVALID_TYPE' ? 'type' : 'domains', detail: issue.message });
			}
			const relationChanged = !existing || relationShape(existing.meta.relations) !== relationShape(card.relations);
			if (relationChanged || typeChanged) {
				violations.push(...validateRelationSemantics(card, records).map((v) => ({ card_id: card.id, ...v })));
			}
			if (relationChanged) {
				const touched = existing ? changedRelations(existing.meta.relations, card.relations) : card.relations;
				violations.push(...validateRelationReadiness(card, records, touched).map((v) => ({ card_id: card.id, ...v })));
			}
			if (card.lifecycle === "deleted") violations.push({ card_id: card.id, code: "deletion_forbidden", field: "lifecycle" });
		}
		if (changedTypeIds.size) violations.push(...incomingSignatureViolations(records, changedTypeIds));
		if (violations.length) {
			throw new HarnessRejected(makeHarnessReceipt({
				operator: "harness.preflight", accepted: false,
				summary: `候选未通过契约：${violations[0].detail ?? violations[0].code}`,
				reason_code: violations[0].code,
				alternatives: relationAlternatives(violations[0]),
				data: { violations: violations.slice(0, 6), layer }
			}));
		}
		const revisions = Object.fromEntries(cards.map((card) => [card.id, hashFile(cardPath(this.root, card.id))]));
		return { cards, revisions, layer, quality };
	}

	commit(proposal) {
        if (['digest-content','contribution-settlement'].includes(proposal.layer)
            || proposal.consumed_buffers?.length || proposal.skipped_buffers?.length
            || Object.keys(proposal.buffer_revisions ?? {}).length || Object.keys(proposal.contribution_map ?? {}).length)
            throw new HarnessRejected(makeHarnessReceipt({ operator: 'harness.commit', accepted: false,
                summary: '旧编译与消化写入已经退役；历史提案不能发布或结算。', reason_code: 'legacy_compile_retired' }));
		const checked = this.preflight({ operations: proposal.operations, layer: proposal.layer });
		for (const [id, expected] of Object.entries(proposal.revisions ?? {})) {
			const actual = hashFile(cardPath(this.root, id));
			if (actual !== expected) {
				throw new HarnessRejected(makeHarnessReceipt({
					operator: "harness.commit", accepted: false,
					summary: `卡片 ${id} 在提案后已发生变化，本次没有覆盖写入。`,
					reason_code: "revision_conflict",
					alternatives: [
						{ action: "read_latest_revision", description: "重新读取最新卡片，再生成最小补丁" },
						{ action: "defer_write", description: "保留候选到待办，不修改当前知识体" }
					],
					revision: { card_id: id, expected, actual }
				}));
			}
		}

		const backups = checked.cards.map((card) => {
			const path = cardPath(this.root, card.id);
			return backupFile(path);
		});
		backups.push(backupFile(journalPath(this.root)));
		const created = [];
		const enriched = [];
		try {
			for (const card of checked.cards) {
				const existed = existsSync(cardPath(this.root, card.id));
				commitCard(this.root, card);
				(existed ? enriched : created).push(card.id);
			}
			appendJournal(this.root, `HarnessGateway 提交 ${checked.cards.length} 个原子操作（层面：${checked.layer}；提案：${proposal.proposal_id}）`);
		} catch (error) {
			restoreFiles(backups);
			throw error;
		}
		return makeHarnessReceipt({
			operator: "harness.commit", accepted: true,
			summary: `已提交 ${checked.cards.length} 个原子操作。`,
			reason_code: "committed",
			scope: { card_ids: checked.cards.map((card) => card.id), buffer_paths: proposal.consumed_buffers ?? [], layer: checked.layer },
			revision: Object.fromEntries(checked.cards.map((card) => [card.id, hashFile(cardPath(this.root, card.id))])),
			data: {
				operation_count: checked.cards.length,
				created, enriched, unchanged: [], pending: proposal.deferred_items ?? [], quality: checked.quality
			}
		});
	}
}
