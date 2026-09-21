/**
 * Knowledge-body card access for the nexogenesis tool suite.
 * Reuses the frontmatter parser from the web-host compatibility layer
 * (same contract: 01-Cards/*.md, frontmatter id/title/type/domains/relations).
 * M4 will swap the naive keyword matcher for the RAG bridge.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { displayType, LINK_LABELS } from "./uno-contract.js";
import { CARD_TYPES, MAX_CARD_DOMAINS } from "./uno/card-classification.js";
import { relationPlane, relationReadiness } from "./harness/relation-semantics.js";

const CARD_CORE_FIELDS = new Set([
	"id", "title", "type", "maturity", "lifecycle", "domains", "origin", "tags", "topics",
	"sources", "relations", "created", "updated", "body", "metadata"
]);
const PROJECTED_METADATA_FIELDS = ["school", "applicable_scope", "theory_status", "entity_kind", "aliases"];
const CARD_SNAPSHOT_LIMIT = 8;
const CARD_SNAPSHOT_VALIDATE_MS = 5000;
const cardSnapshots = new Map();
const snapshotVersions = new Map();
const snapshotCounters = new Map();

function canonicalRoot(root) {
	return resolve(root).toLocaleLowerCase();
}

function snapshotKey(root, includeExamples, includeInactive = false) {
	return `${canonicalRoot(root)}\u0000${includeExamples ? "examples" : "live"}${includeInactive ? ":history" : ""}`;
}

function countersFor(root) {
	const key = canonicalRoot(root);
	if (!snapshotCounters.has(key)) snapshotCounters.set(key, { hits: 0, misses: 0, scans: 0 });
	return snapshotCounters.get(key);
}

function nextSnapshotVersion(root) {
	const key = canonicalRoot(root);
	const next = (snapshotVersions.get(key) ?? 0) + 1;
	snapshotVersions.set(key, next);
	return next;
}

function evictOldSnapshots() {
	while (cardSnapshots.size > CARD_SNAPSHOT_LIMIT) {
		const oldest = cardSnapshots.keys().next().value;
		cardSnapshots.delete(oldest);
	}
}

function isMetadataValue(value) {
	return typeof value === "string"
		|| typeof value === "number"
		|| typeof value === "boolean"
		|| (Array.isArray(value) && value.every((item) => (
			typeof item === "string" || typeof item === "number" || typeof item === "boolean"
		)));
}

function metadataFromFrontmatter(frontmatter = {}) {
	return Object.fromEntries(Object.entries(frontmatter).filter(([key, value]) => (
		!CARD_CORE_FIELDS.has(key) && isMetadataValue(value)
	)));
}

function normalizeMetadata(record = {}) {
	const metadata = {
		...(record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
			? record.metadata : {})
	};
	for (const key of PROJECTED_METADATA_FIELDS) {
		if (record[key] !== void 0) metadata[key] = record[key];
	}
	for (const key of Object.keys(metadata)) {
		if (CARD_CORE_FIELDS.has(key)) {
			delete metadata[key];
			continue;
		}
		if (!isMetadataValue(metadata[key])) throw new Error(`metadata.${key} 必须是标量或标量列表`);
		if (metadata[key] === "" || (Array.isArray(metadata[key]) && metadata[key].length === 0)) delete metadata[key];
	}
	return metadata;
}

const FRONTMATTER_CONTROL = /[\u0000-\u001f\u007f]/;
const FRONTMATTER_KEY = /^[A-Za-z_][\w-]*$/;

function assertFrontmatterString(value, field) {
	if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
	if (FRONTMATTER_CONTROL.test(value)) throw new Error(`${field} 含有换行或控制字符`);
	return value;
}

/** Parse a frontmatter block (between the --- fences). */
function parseYamlBlock(block) {
	const document = parseDocument(block, { prettyErrors: true, strict: true, uniqueKeys: true });
	if (document.errors.length > 0) throw new Error(`frontmatter 无法解析: ${document.errors[0].message}`);
	const value = document.toJS({ maxAliasCount: 0 });
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("frontmatter 根节点必须是对象");
	return value;
}

/** Split a card file into { meta, body }. */
export function parseCardFile(filePath) {
	const text = readFileSync(filePath, "utf8");
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return { meta: {}, body: text };
	return { meta: parseYamlBlock(m[1]), body: text.slice(m[0].length).replace(/^(?:\r?\n){1,2}/, "") };
}

/** Recursively list *.md files under a directory. */
function listMarkdown(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) out.push(...listMarkdown(join(dir, entry.name)));
		else if (entry.name.endsWith(".md")) out.push(join(dir, entry.name));
	}
	return out;
}

function cardInventory(root) {
	const dir = join(root, "01-Cards");
	let files = [];
	try {
		if (statSync(dir).isDirectory()) files = listMarkdown(dir).sort((a, b) => a.localeCompare(b, "zh-CN"));
	} catch {
		files = [];
	}
	const hash = createHash("sha256");
	for (const file of files) {
		const stat = statSync(file);
		hash.update(file).update("\u0000").update(String(stat.size)).update("\u0000").update(String(stat.mtimeMs)).update("\n");
	}
	return { files, signature: hash.digest("hex") };
}

function isExampleCard(meta) {
	return String(meta?.id ?? "").startsWith("样例-")
		|| String(meta?.namespace ?? "").toLowerCase() === "example";
}

/**
 * Scan the card store with deterministic duplicate handling and hygiene diagnostics.
 * Example cards remain useful as prompt references, but must not silently enter the
 * live retrieval graph when they are accidentally copied into 01-Cards/.
 */
export function scanCards(root, { includeExamples = false, includeInactive = false } = {}) {
	const key = snapshotKey(root, includeExamples, includeInactive);
	const cached = cardSnapshots.get(key);
	const counters = countersFor(root);
	const now = Date.now();
	if (cached && now - cached.validatedAt < CARD_SNAPSHOT_VALIDATE_MS) {
		counters.hits += 1;
		cardSnapshots.delete(key);
		cardSnapshots.set(key, cached);
		return cached.value;
	}
	const inventory = cardInventory(root);
	if (cached?.signature === inventory.signature) {
		counters.hits += 1;
		cached.validatedAt = now;
		cardSnapshots.delete(key);
		cardSnapshots.set(key, cached);
		return cached.value;
	}
	counters.misses += 1;
	counters.scans += 1;
	const cards = new Map();
	const seenFiles = new Map();
	const allSeenFiles = new Map();
	const excludedExamples = [];
	const duplicateIds = [];
	for (const file of inventory.files) {
		const { meta, body } = parseCardFile(file);
		if (meta.kind === "uno-domain-index") continue;
		const id = meta.id;
		if (typeof id !== "string" || id === "") continue;
		const lifecycle = meta.lifecycle;
		if (!includeInactive && lifecycle !== void 0 && lifecycle !== "active") continue;
		if (allSeenFiles.has(id)) duplicateIds.push({ id, files: [allSeenFiles.get(id), file] });
		else allSeenFiles.set(id, file);
		if (isExampleCard(meta) && !includeExamples) {
			excludedExamples.push({ id, file });
			continue;
		}
		if (seenFiles.has(id)) {
			continue;
		}
		seenFiles.set(id, file);
		cards.set(id, { meta, body, file });
	}
	const value = {
		cards,
		diagnostics: {
			excluded_examples: excludedExamples,
			duplicate_ids: duplicateIds
		}
	};
	const version = nextSnapshotVersion(root);
	cardSnapshots.set(key, { signature: inventory.signature, value, version, validatedAt: now });
	evictOldSnapshots();
	return value;
}

/** Return the current in-process snapshot version for GraphOps cache coordination. */
export function cardSnapshotVersion(root, { includeExamples = false } = {}) {
	return cardSnapshots.get(snapshotKey(root, includeExamples))?.version ?? snapshotVersions.get(canonicalRoot(root)) ?? 0;
}

/** Drop all cached card views after a successful write. */
export function invalidateKnowledgeSnapshot(root) {
	const prefix = `${canonicalRoot(root)}\u0000`;
	for (const key of [...cardSnapshots.keys()]) if (key.startsWith(prefix)) cardSnapshots.delete(key);
	nextSnapshotVersion(root);
}

/** Lightweight diagnostics used by latency tests and local telemetry. */
export function knowledgeSnapshotStats(root) {
	const counters = countersFor(root);
	return { ...counters, version: snapshotVersions.get(canonicalRoot(root)) ?? 0 };
}

/** Reset diagnostics and cached state. Intended for deterministic tests. */
export function resetKnowledgeSnapshot(root) {
	invalidateKnowledgeSnapshot(root);
	snapshotCounters.set(canonicalRoot(root), { hits: 0, misses: 0, scans: 0 });
}

/** Load all active, non-example cards from 01-Cards/ (id-keyed). */
export function loadCards(root, options) {
	return scanCards(root, options).cards;
}

/** Tokenize a query into lowercase keyword fragments (CJK-aware: keeps 2+ char runs). */
function tokens(query) {
	return String(query ?? "")
		.toLowerCase()
		.split(/[\s，。、；：！？,.!?;:()（）"'“”‘’\-_/\\|]+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 1);
}

/** BM25-style weighted term frequency for one token in one card. */
function tfOf(card, token) {
	const title = String(card.meta.title ?? "").toLowerCase();
	const domains = (Array.isArray(card.meta.domains) ? card.meta.domains : []).join(" ").toLowerCase();
	const body = (displayType(card.meta) + " " + card.body).toLowerCase();
	let count = 0;
	let idx = -1;
	while ((idx = title.indexOf(token, idx + 1)) !== -1) count += 3; // title hits weigh 3x
	idx = -1;
	while ((idx = domains.indexOf(token, idx + 1)) !== -1) count += 2; // domain 2x
	idx = -1;
	while ((idx = body.indexOf(token, idx + 1)) !== -1) count += 1; // body 1x
	return count;
}

/** IDF for one token across the card corpus (smoothed). */
function idfOf(total, docFreq) {
	return Math.log(1 + (total - docFreq + 0.5) / (docFreq + 0.5));
}

/** Find the first token hit position in the body for a snippet. */
function snippetOf(card, queryTokens) {
	const body = card.body;
	const firstHit = queryTokens
		.map((t) => body.toLowerCase().indexOf(t))
		.filter((i) => i >= 0)
		.sort((a, b) => a - b)[0];
	if (firstHit === void 0) return body.slice(0, 100);
	const start = Math.max(0, firstHit - 40);
	return `${start > 0 ? "…" : ""}${body.slice(start, start + 140)}${start + 140 < body.length ? "…" : ""}`;
}

/** Relations of one card (target ids), if any. */
function relationTargets(card, cards) {
	const relations = Array.isArray(card.meta.relations) ? card.meta.relations : [];
	return relations.filter((relation) => {
		if (Object.hasOwn(LINK_LABELS, relation?.type)) return cards.has(relation.target);
		if (relationPlane(relation?.type) !== "argument" || relation?.type === "applies-to") return false;
		return relationReadiness(card, relation, cards.get(String(relation?.target ?? ""))).ready;
	}).map((relation) => relation.target).filter((target) => typeof target === "string");
}

/** Card to wire shape (shared by search + graph diffusion). */
function cardToResult(card, id, queryTokens, role) {
	return {
		id,
		title: String(card.meta.title ?? id),
		type: displayType(card.meta),
		domains: Array.isArray(card.meta.domains) ? card.meta.domains : [],
		maturity: String(card.meta.maturity ?? ""),
		snippet: snippetOf(card, queryTokens),
		role
	};
}

/**
 * Hybrid search over the knowledge body: BM25 keyword scoring + one-hop graph
 * diffusion. Direct hits are `core`; cards reachable from core via `relations`
 * are `expansion` (scored lower). Mirrors the dual-track retrieval design:
 * structure track (graph) supplies the Context Package's core/expansion nodes.
 */
export function searchCards(root, query, domainFilter) {
	const cards = loadCards(root);
	const queryTokens = tokens(query);

	// BM25 pass over all active cards (domain-filtered when asked).
	const total = cards.size;
	const docFreq = new Map();
	const scores = new Map();
	for (const [id, card] of cards) {
		if (domainFilter !== void 0 && Array.isArray(domainFilter) && domainFilter.length > 0) {
			const domains = Array.isArray(card.meta.domains) ? card.meta.domains : [];
			if (!domainFilter.some((d) => domains.includes(d))) continue;
		}
		let score = 0;
		for (const token of queryTokens) {
			const tf = tfOf(card, token);
			if (tf > 0) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
			score += tf;
		}
		if (score > 0) scores.set(id, score);
	}
	const idf = new Map();
	for (const token of queryTokens) idf.set(token, idfOf(total, docFreq.get(token) ?? 0));
	const ranked = [];
	for (const [id, raw] of scores) {
		let bm25 = 0;
		const card = cards.get(id);
		for (const token of queryTokens) bm25 += tfOf(card, token) * idf.get(token);
		if (bm25 <= 0) continue;
		ranked.push({ id, card, score: bm25 });
	}
	ranked.sort((a, b) => b.score - a.score);
	const core = ranked.slice(0, 6);

	// One-hop graph diffusion from the core seeds.
	const seen = new Set(core.map((r) => r.id));
	const expansion = [];
	for (const seed of core) {
		for (const target of relationTargets(seed.card, cards)) {
			if (seen.has(target)) continue;
			const neighbor = cards.get(target);
			if (neighbor === void 0) continue;
			seen.add(target);
			expansion.push({ id: target, card: neighbor });
		}
	}

	return [
		...core.map((r) => cardToResult(r.card, r.id, queryTokens, "core")),
		...expansion.slice(0, 4).map((r) => cardToResult(r.card, r.id, queryTokens, "expansion"))
	].slice(0, 10);
}

/** Full card detail for read_card. */
export function readCard(root, id) {
	const cards = loadCards(root);
	let card = cards.get(id);
	// Retired Markdown stays addressable by its exact ID; it is not returned to active retrieval.
	if (!card && typeof id === "string" && id !== "." && id !== ".." && !/[\\/:\x00-\x1f]/u.test(id)) {
		const file = join(root, "01-Cards", `${id}.md`);
		if (existsSync(file)) {
			const parsed = parseCardFile(file);
			if (parsed.meta.id === id && ["superseded", "archived"].includes(parsed.meta.lifecycle)) card = { ...parsed, file };
		}
	}
	if (card === void 0) return void 0;
	const meta = card.meta;
	const metadata = metadataFromFrontmatter(meta);
	return {
		id,
		title: String(meta.title ?? id),
		type: displayType(meta),
		maturity: String(meta.maturity ?? ""),
		lifecycle: String(meta.lifecycle ?? "active"),
		domains: Array.isArray(meta.domains) ? meta.domains : [],
		origin: String(meta.origin ?? "user"),
		sources: Array.isArray(meta.sources) ? meta.sources : [],
		relations: Array.isArray(meta.relations) ? meta.relations : [],
		created: String(meta.created ?? ""),
		updated: String(meta.updated ?? ""),
		school: metadata.school ?? "",
		applicable_scope: metadata.applicable_scope ?? [],
		theory_status: metadata.theory_status ?? "",
		entity_kind: metadata.entity_kind ?? "",
		aliases: metadata.aliases ?? [],
		metadata,
		body: card.body
	};
}

/** Canonical domain definitions. Legacy type:domain cards are not membership authority. */
export function listDomains(root) {
	const dir = join(root, "01-Cards", "_meta", "domains");
	if (!existsSync(dir)) return [];
	const domains = readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => {
		const card = parseCardFile(join(dir, name));
		return { id: String(card.meta.id ?? name.slice(0, -3)), title: String(card.meta.title ?? card.meta.id ?? name.slice(0, -3)) };
	});
	domains.sort((a, b) => a.title.localeCompare(b.title, "zh"));
	return domains;
}

// ---- Inbox / Buffer (pipeline material store) ----

/** Resolve a path inside a knowledge-body directory, rejecting traversal. */
function scopedPath(root, subdir, rel) {
	const base = join(root, subdir);
	const target = join(base, rel);
	if (target !== base && !target.startsWith(base + sep)) throw new Error(`路径越界被拒绝: ${rel}`);
	return target;
}

/** Recursively list relative file paths under a directory (empty when absent). */
function walkFiles(dir, prefix = "") {
	const out = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out;
}

/** List 00-Inbox material files (relative paths). */
export function listInbox(root) {
	return walkFiles(join(root, "00-Inbox")).map((rel) => ({ path: rel }));
}

/** Read one 00-Inbox file (path-traversal guarded). */
export function readInbox(root, rel) {
	return readFileSync(scopedPath(root, "00-Inbox", rel), "utf8");
}

/** Read raw Inbox bytes for format-aware source parsers such as EPUB. */
export function readInboxBytes(root, rel) {
	return readFileSync(scopedPath(root, "00-Inbox", rel));
}

/** List 05-Buffer materials with enough metadata to plan digestion. */
export function listBuffer(root, { status = "pending" } = {}) {
	const allowedStatuses = new Set(["pending", "partial", "settled", "skipped", "all"]);
	if (!allowedStatuses.has(status)) throw new Error("Buffer status 必须是 pending/partial/settled/skipped/all");
	let ledger = {};
	try { ledger = JSON.parse(readFileSync(join(root, ".nexogenesis", "cognition", "contributions.json"), "utf8")); }
	catch { /* first digestion run */ }
	return walkFiles(join(root, "05-Buffer"))
		.filter((rel) => rel.toLowerCase().endsWith(".md") && BUFFER_ROLES.has(rel.split("/")[0]))
		.map((rel) => {
			const { meta, body } = parseCardFile(scopedPath(root, "05-Buffer", rel));
			const contribution = ledger[rel];
			const contributionStatus = contribution?.status ?? "pending";
			return {
				path: rel,
				title: String(meta.title ?? rel.split("/").at(-1)?.replace(/\.md$/i, "") ?? rel),
				role: String(meta.role ?? rel.split("/")[0] ?? "meaning-unit"),
				source: String(meta.source ?? ""),
				status: contributionStatus,
				summary: body.replace(/\s+/g, " ").trim().slice(0, 240),
				...(contributionStatus === "partial" ? { remaining: contribution.remaining ?? [] } : {}),
				...(contribution?.settled_at ? { settled_at: contribution.settled_at } : {}),
				...(Array.isArray(contribution?.operation_ids) ? { target_ids: contribution.operation_ids } : {})
			};
		}).filter((item) => status === "all" || item.status === status || (status === "pending" && item.status === "partial"));
}

/** Read one 05-Buffer file (path-traversal guarded). */
export function readBuffer(root, rel) {
	return readFileSync(scopedPath(root, "05-Buffer", rel), "utf8");
}

function sourceTracePriority(root, reference) {
	if (String(reference).startsWith("03-Archive/aggregates/")) {
		try {
			const rel = String(reference).split("#", 1)[0].slice("03-Archive/".length);
			if (parseCardFile(scopedPath(root, "03-Archive", rel)).meta.source_quality_contract === "aggregation-v1") return 0;
		} catch { /* preserve a visible unavailable reference */ }
	}
	if (!String(reference).startsWith("05-Buffer/")) return 1;
	const rel = String(reference).split("#", 1)[0].slice("05-Buffer/".length);
	try {
		const { meta } = parseCardFile(scopedPath(root, "05-Buffer", rel));
		if (meta.source_quality_contract === "theme-source-v2") return 0;
	} catch { /* unavailable sources keep their declared order within the fallback tier */ }
	return 1;
}

function archiveSourceSection(body, fragment) {
  if(/^[a-zA-Z0-9_-]+$/.test(fragment)){
    const anchor=new RegExp('(?:^|\\s)\\^'+fragment+'(?=\\s|$)','m').exec(body);
    if(anchor){const before=body.slice(0,anchor.index),headings=[...before.matchAll(/^#{1,6} .+$/gm)];const start=headings.at(-1)?.index??Math.max(0,before.lastIndexOf('\n\n'));const end=body.indexOf('\n#',anchor.index);return body.slice(start,end<0?body.length:end);}
  }
	const headings = [...body.matchAll(/^(#{1,6})\s+(.+)\r?$/gm)];
	const start = headings.findIndex((heading) => heading[2].trim() === fragment
		|| (/^obj-[a-z0-9-]+$/.test(fragment) && heading[2].startsWith(`${fragment} `)));
	if (start < 0) return null;
	const heading = headings[start];
	const next = headings.slice(start + 1).find((item) => item[1].length <= heading[1].length);
	return body.slice(heading.index, next?.index ?? body.length);
}

/**
 * 受限来源追溯：只读取卡片 frontmatter 已声明的 Buffer 或 Archive Markdown 来源，
 * 不能借此读取任意文件。Archive 二进制与外部引用仅回传引用本身。
 */
export function traceCardSources(root, id, { source, limit = 3, preview = 1000 } = {}) {
	const card = readCard(root, id);
	if (!card) throw new Error(`卡片不存在：${id}`);
	const declared = card.sources.filter((item) => typeof item === "string");
	const selected = source === void 0
		? declared.map((reference, index) => ({ reference, index, priority: sourceTracePriority(root, reference) }))
			.sort((left, right) => left.priority - right.priority || left.index - right.index)
			.map((item) => item.reference)
		: declared.filter((item) => item === source);
	if (source !== void 0 && selected.length === 0) throw new Error("只能追溯该卡片 frontmatter 中已声明的 source");
	return {
		card_id: id,
		anchors: selected.slice(0, Math.min(Math.max(1, limit), 8)).map((reference) => {
			if (reference.startsWith("03-Archive/")) {
				const [fileRef, ...fragmentParts] = reference.split("#");
				const fragment = fragmentParts.join("#").trim();
				if (!/\.md$/i.test(fileRef)) return { source: reference, kind: "reference" };
				const rel = fileRef.slice("03-Archive/".length);
				try {
					const { meta, body } = parseCardFile(scopedPath(root, "03-Archive", rel));
					let excerpt = body;
					let anchorFound;
					if (fragment) {
						const section = archiveSourceSection(body, fragment);
						anchorFound = section !== null;
						if (anchorFound) excerpt = section;
					}
					excerpt = excerpt.replace(/<!--\s*unit:[^>]+-->/g, "").replace(/\s+/g, " ").trim();
					const previewLimit = Math.min(Math.max(120, preview), 2400);
					const image = typeof meta.image === "string" && meta.image.trim()
						? `03-Archive/${join(dirname(rel), meta.image).replaceAll("\\", "/")}` : undefined;
					return {
						source: reference, kind: meta.kind === "figure-source" ? "archive-figure" : "archive-markdown",
						title: String(meta.source_title ?? meta.title ?? body.match(/^#\s+(.+)$/m)?.[1] ?? rel),
						...(fragment ? { anchor: fragment, anchor_found: anchorFound } : {}), ...(image ? { image_path: image } : {}),
						preview: excerpt.slice(0, previewLimit), truncated: excerpt.length > previewLimit
					};
				} catch {
					return { source: reference, kind: "archive-markdown", unavailable: true };
				}
			}
			if (!reference.startsWith("05-Buffer/")) return { source: reference, kind: "reference" };
			const [fileRef, ...fragmentParts] = reference.split("#");
			const fragment = fragmentParts.join("#").trim();
			const rel = fileRef.slice("05-Buffer/".length);
			try {
				let parsed=parseCardFile(scopedPath(root,"05-Buffer",rel));
        if(parsed.meta.kind==='uno-material-index'){
          const target=parsed.meta.target;if(typeof target!=='string'||!target.startsWith('05-Buffer/')||target.startsWith('05-Buffer/_index/'))throw Error('原文指针无效');
          parsed=parseCardFile(scopedPath(root,'05-Buffer',target.slice('05-Buffer/'.length)));
        }else readBuffer(root,rel);
        const {meta,body}=parsed;
				const section = fragment ? archiveSourceSection(body, fragment) : null;
				const excerpt = (section ?? body).replace(/\s+/g, " ").trim();
				const previewLimit = Math.min(Math.max(120, preview), 2400);
				const image = typeof meta.image === "string" && meta.image.trim()
					? `05-Buffer/${join(dirname(rel), meta.image).replaceAll("\\", "/")}` : undefined;
				const kind = meta.kind === "figure-source" ? "theme-figure"
					: meta.kind === "chapter-source" ? "theme-chapter-source" : "buffer";
				return {
					source: reference,
					kind,
					title: String(meta.title ?? rel),
					...(fragment ? { anchor: fragment, anchor_found: section !== null } : {}),
					...(kind === "buffer" ? { role: String(meta.role ?? rel.split("/")[0] ?? "") } : {}),
					...(image ? { image_path: image } : {}),
					preview: excerpt.slice(0, previewLimit),
					truncated: excerpt.length > previewLimit
				};
			} catch {
				return { source: reference, kind: "buffer", unavailable: true };
			}
		})
	};
}

/** Allowed Buffer roles per the body-structure contract. */
export const BUFFER_ROLES = new Set([
	"meaning-unit", "tension", "link-hypothesis", "profile-seed",
	"detail", "evidence", "artifact-table", "artifact-figure"
]);

const BUFFER_NAME_SAFE = /[\\/:*?"<>|]/g;

/** Write one Buffer material file under 05-Buffer/<role>/ (direct, no approval). */
export function writeBuffer(root, { role, title, source, body }) {
	if (!BUFFER_ROLES.has(role)) throw new Error(`role 必须是 ${[...BUFFER_ROLES].join("/")} 之一`);
	if (typeof title !== "string" || title.trim() === "" || typeof body !== "string" || body.trim() === "") {
		throw new Error("title 与 body 为必填");
	}
	assertFrontmatterString(title, "Buffer title");
	assertFrontmatterString(String(source ?? ""), "Buffer source");
	const now = new Date();
	const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const clock = `${stamp}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
	const seq = String(Math.floor(Math.random() * 9000) + 1000);
	const safeTitle = title.replace(BUFFER_NAME_SAFE, "_").slice(0, 60);
	const dir = join(root, "05-Buffer", role);
	mkdirSync(dir, { recursive: true });
	const fname = `${clock}-${seq}-${safeTitle}.md`;
	const meta = { title, role, source: String(source ?? ""), created: stamp, updated: stamp, status: "scratch" };
	const yaml = stringifyYaml(meta, {
		lineWidth: 0, defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE", doubleQuotedAsJSON: true
	}).trimEnd();
	const parsed = parseYamlBlock(yaml);
	if (!isDeepStrictEqual(meta, parsed)) throw new Error("Buffer frontmatter 序列化往返校验失败，已阻止写入");
	const frontmatter = `---\n${yaml}\n---\n\n${String(body)}`;
	writeFileSync(join(dir, fname), frontmatter, "utf8");
	return { path: `05-Buffer/${role}/${fname}` };
}

// ---- Card atomic write (approval-gated, staged then committed) ----

/** Card id safety: letters, CJK, digits, dash/underscore; no separators or control chars. */
const CARD_ID_SAFE = /^[^\\\/:*?"<>|\x00-\x1f]+$/;

// ---- enrich 段落补丁（移植上游 card_overlay.py，消化 v2.1 语义）----
// 模型不必重抄未改段落：只提交 mode:"enrich" + 补丁（replace_sections /
// append_sections / add_sources / add_relations），Harness 从现有卡展开合并。

const HEADING_RE = /^(#{2,6})\s+(.+?)\s*$/gm;

/** 标题归一化：去 # 与空白（匹配 replace/append 的 key）。 */
function normalizeHeading(value) {
	return String(value ?? "").trim().replace(/^#{1,6}\s*/, "").trim();
}

/**
 * 按 `##`–`######` 标题切分正文。
 * 与上游不同：保留标题级别（level），合并时按原级别还原，
 * 避免把卡片契约中的三级小节（###）扁平化为二级。
 * @returns [{ heading, level, content }]，heading 不含 #。
 */
export function splitSections(body) {
	const text = String(body ?? "");
	const matches = [...text.matchAll(HEADING_RE)];
	if (matches.length === 0) return [{ heading: "", level: 0, content: text }];
	const parts = [];
	if (matches[0].index > 0) {
		const leading = text.slice(0, matches[0].index).trimEnd();
		if (leading) parts.push({ heading: "", level: 0, content: leading + "\n" });
	}
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
		parts.push({ heading: m[2].trim(), level: m[1].length, content: text.slice(m.index + m[0].length, end).trimEnd() + "\n" });
	}
	return parts;
}

/** 重组分节正文（标题按原级别还原为 `##`-`######`）。 */
export function joinSections(parts) {
	const chunks = [];
	for (const { heading, level, content } of parts) {
		const body = String(content ?? "").trimEnd() + "\n";
		if (heading) chunks.push(`${"#".repeat(Math.max(2, level))} ${heading}\n\n${body}`);
		else if (body.trim()) chunks.push(body);
	}
	return chunks.join("\n").trimEnd() + "\n";
}

/**
 * 应用 replace/append 章节补丁：
 * - replace：已有标题 → 替换该节；无该标题 → 末尾新增该节。
 * - append：已有标题 → 节末追加；无 → 新增该节。
 */
export function applySectionPatches(body, { replaceSections, appendSections } = {}) {
	let parts = splitSections(body);
	const byHeading = new Map();
	parts.forEach((p, i) => {
		if (p.heading) byHeading.set(normalizeHeading(p.heading), i);
	});

	for (const [rawHeading, newBody] of Object.entries(replaceSections ?? {})) {
		const heading = normalizeHeading(rawHeading);
		if (!heading) continue;
		const text = String(newBody ?? "").trimEnd() + "\n";
		if (byHeading.has(heading)) {
			parts[byHeading.get(heading)].content = text;
		} else {
			byHeading.set(heading, parts.length);
			parts.push({ heading, level: 2, content: text });
		}
	}

	for (const [rawHeading, extra] of Object.entries(appendSections ?? {})) {
		const heading = normalizeHeading(rawHeading);
		if (!heading) continue;
		const addition = String(extra ?? "").trimEnd() + "\n";
		if (byHeading.has(heading)) {
			const index = byHeading.get(heading);
			const current = parts[index].content.trimEnd();
			parts[index].content = current ? `${current}\n\n${addition}` : addition;
		} else {
			byHeading.set(heading, parts.length);
			parts.push({ heading, level: 2, content: addition });
		}
	}
	return joinSections(parts);
}

/** 合并去重（sources 为字符串数组，relations 为对象数组）。 */
export function mergeUnique(existing, added) {
	const seen = new Set();
	const merged = [];
	for (const item of [...(existing ?? []), ...(added ?? [])]) {
		const key = typeof item === "string" ? item : JSON.stringify(item);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
	}
	return merged;
}

/**
 * 把 mode:"enrich" 补丁展开为完整卡片记录（保留现有卡的元数据与未改段落）。
 * @throws 目标卡不存在或补丁为空时。
 * @returns { write, warnings }
 */
export function expandEnrichWrite(root, item) {
	const id = String(item?.id ?? "").trim();
	if (!id) throw new Error("enrich 补丁缺少目标卡 id");
	const existing = readCard(root, id);
	if (existing === void 0) {
		throw new Error(`enrich 目标卡不存在：${id}（请先 read_card 或检索确认 id）`);
	}

	const replaceSections = item.replace_sections !== void 0 && typeof item.replace_sections === "object"
		? item.replace_sections : {};
	const appendSections = item.append_sections !== void 0 && typeof item.append_sections === "object"
		? item.append_sections : {};
	const hasBodyPatch = Object.keys(replaceSections).length > 0 || Object.keys(appendSections).length > 0;
	const hasSources = Array.isArray(item.add_sources) && item.add_sources.length > 0;
	const hasRelations = Array.isArray(item.add_relations) && item.add_relations.length > 0;
	const overlayKeys = ["title", "type", "maturity", "lifecycle", "origin", "domains", "created", "updated", "body", ...PROJECTED_METADATA_FIELDS];
	const hasOverlay = overlayKeys.some((key) => item[key] !== void 0 && item[key] !== null && item[key] !== "");
	if (!hasBodyPatch && !hasSources && !hasRelations && !hasOverlay) {
		throw new Error(`enrich 补丁为空：请提供 replace_sections / append_sections / add_sources / add_relations 或覆盖字段`);
	}

	const base = {
		id: existing.id,
		title: existing.title,
		type: existing.type,
		maturity: existing.maturity,
		lifecycle: existing.lifecycle,
		domains: existing.domains,
		origin: existing.origin ?? "user",
		sources: existing.sources ?? [],
		relations: existing.relations ?? [],
		created: existing.created,
		updated: existing.updated,
		metadata: existing.metadata,
		body: existing.body
	};
	const warnings = [];

	for (const key of ["title", "type", "maturity", "lifecycle", "origin"]) {
		if (item[key] !== void 0 && item[key] !== null && item[key] !== "") base[key] = item[key];
	}
	if (Array.isArray(item.domains)) base.domains = item.domains;
	if (item.created) base.created = item.created;
	base.updated = String(item.updated ?? new Date().toISOString().slice(0, 10));
	for (const key of PROJECTED_METADATA_FIELDS) {
		if (item[key] !== void 0) base.metadata[key] = item[key];
	}
	if (item.metadata !== void 0) {
		base.metadata = normalizeMetadata({
			...base,
			metadata: { ...base.metadata, ...item.metadata }
		});
	}

	if (hasBodyPatch) {
		base.body = applySectionPatches(base.body, { replaceSections, appendSections });
		warnings.push("已应用章节补丁（replace/append sections）");
	} else if (typeof item.body === "string" && item.body.trim() !== "") {
		base.body = item.body;
	}

	if (Array.isArray(item.sources)) {
		base.sources = item.sources;
	} else if (hasSources) {
		const before = base.sources.length;
		base.sources = mergeUnique(base.sources, item.add_sources);
		if (base.sources.length > before) warnings.push(`add_sources 新增 ${base.sources.length - before} 条`);
	}
	if (Array.isArray(item.relations)) {
		base.relations = item.relations;
	} else if (hasRelations) {
		const before = base.relations.length;
		base.relations = mergeUnique(base.relations, item.add_relations);
		if (base.relations.length > before) warnings.push(`add_relations 新增 ${base.relations.length - before} 条`);
	}

	return { write: base, warnings };
}

/** Validate one card write record before staging. */
export function validateCardRecord(record) {
	const id = record?.id;
	if (typeof id !== "string" || id.trim() === "" || !CARD_ID_SAFE.test(id)) {
		throw new Error(`卡片 id 非法: ${JSON.stringify(id)}（不允许路径分隔符与危险字符）`);
	}
	for (const field of ["title", "type"]) {
		if (typeof record?.[field] !== "string" || record[field].trim() === "") {
			throw new Error(`卡片缺少必填字段: ${field}`);
		}
	}
	if (!CARD_TYPES.includes(record.type)) throw new Error(`卡片 type 必须为 ${CARD_TYPES.join("/")} 之一`);
	if (record.tags !== void 0 || record.topics !== void 0) throw new Error("新卡片只使用 type 与 domains，不得写入 tags 或 topics");
	if (!Array.isArray(record.domains)) throw new Error("卡片 domains 必须为数组（先调用 list_domains）");
	if (record.domains.length > MAX_CARD_DOMAINS) throw new Error(`卡片 domains 最多 ${MAX_CARD_DOMAINS} 个`);
	for (const [index, domain] of record.domains.entries()) {
		assertFrontmatterString(domain, `domains[${index}]`);
		if (domain.trim() === "") throw new Error(`domains[${index}] 不能为空`);
	}
	for (const field of ["id", "title", "type", "maturity", "lifecycle", "origin", "created", "updated"]) {
		if (record[field] !== void 0 && record[field] !== null) assertFrontmatterString(String(record[field]), field);
	}
	for (const [index, source] of (record.sources ?? []).entries()) assertFrontmatterString(source, `sources[${index}]`);
	for (const [index, relation] of (record.relations ?? []).entries()) {
		if (!relation || typeof relation !== "object" || Array.isArray(relation)) throw new Error(`relations[${index}] 必须是对象`);
		for (const field of ["target", "type", "note"]) {
			if (relation[field] !== void 0 && relation[field] !== null) assertFrontmatterString(String(relation[field]), `relations[${index}].${field}`);
		}
	}
	const metadata = normalizeMetadata(record);
	for (const [key, value] of Object.entries(metadata)) {
		if (!FRONTMATTER_KEY.test(key)) throw new Error(`metadata 字段名非法: ${key}`);
		for (const [index, item] of (Array.isArray(value) ? value : [value]).entries()) {
			if (typeof item === "string") assertFrontmatterString(item, `metadata.${key}[${index}]`);
		}
	}
	if (typeof record.body !== "string" || record.body.trim() === "") throw new Error("卡片 body 为必填");
	return {
		id,
		title: record.title,
		type: record.type,
		maturity: String(record.maturity ?? "growing"),
		lifecycle: String(record.lifecycle ?? "active"),
		domains: record.domains,
		origin: String(record.origin ?? "user"),
		relations: Array.isArray(record.relations) ? record.relations : [],
		sources: Array.isArray(record.sources) ? record.sources : [],
		created: String(record.created ?? new Date().toISOString().slice(0, 10)),
		updated: String(record.updated ?? new Date().toISOString().slice(0, 10)),
		metadata,
		body: record.body
	};
}

/** Serialize a card record to markdown (frontmatter + body). */
export function serializeCard(card) {
	const metadata = normalizeMetadata(card);
	const frontmatter = {
		id: card.id,
		title: card.title,
		type: card.type,
		...(card.maturity ? { maturity: card.maturity } : {}),
		...(card.lifecycle ? { lifecycle: card.lifecycle } : {}),
		domains: card.domains,
		origin: card.origin,
		...Object.fromEntries(PROJECTED_METADATA_FIELDS.filter((key) => metadata[key] !== void 0).map((key) => [key, metadata[key]])),
		...Object.fromEntries(Object.keys(metadata).filter((key) => !PROJECTED_METADATA_FIELDS.includes(key)).sort().map((key) => [key, metadata[key]])),
		...(Array.isArray(card.sources) && card.sources.length > 0 ? { sources: card.sources } : {}),
		...(Array.isArray(card.relations) && card.relations.length > 0 ? { relations: card.relations } : {}),
		created: card.created,
		updated: card.updated
	};
	const yaml = stringifyYaml(frontmatter, {
		lineWidth: 0,
		defaultKeyType: "PLAIN",
		defaultStringType: "QUOTE_DOUBLE",
		doubleQuotedAsJSON: true
	}).trimEnd();
	return `---\n${yaml}\n---\n\n${card.body}`;
}

/**
 * Atomically write a card into 01-Cards/ (staging then rename).
 * @param root - knowledge-body root.
 * @param card - validated card record.
 * @returns the committed relative path.
 */
export function commitCard(root, card) {
	const dir = join(root, "01-Cards");
	mkdirSync(dir, { recursive: true });
	const finalPath = join(dir, `${card.id}.md`);
	const stagingPath = join(dir, `.staging-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
	const validated = validateCardRecord(card);
	const serialized = serializeCard(validated);
	try {
		writeFileSync(stagingPath, serialized, "utf8");
		const reparsed = parseCardFile(stagingPath);
		const normalizedRoundTrip = validateCardRecord({
			...reparsed.meta,
			metadata: metadataFromFrontmatter(reparsed.meta),
			body: reparsed.body
		});
		if (!isDeepStrictEqual(validated, normalizedRoundTrip)) {
			const changed = Object.keys(validated).filter((key) => !isDeepStrictEqual(validated[key], normalizedRoundTrip[key]));
			throw new Error(`卡片序列化往返校验失败，已阻止写入（字段：${changed.join("、")}）`);
		}
		renameSync(stagingPath, finalPath);
		invalidateKnowledgeSnapshot(root);
	} catch (error) {
		try { unlinkSync(stagingPath); } catch { /* staging may not exist or was renamed */ }
		throw error;
	}
	return `01-Cards/${card.id}.md`;
}

/** Append a Journal entry (06-Journal/), one file per day. */
export function appendJournal(root, entry) {
	const dir = join(root, "06-Journal");
	mkdirSync(dir, { recursive: true });
	const today = new Date().toISOString().slice(0, 10);
	const file = join(dir, `${today}.md`);
	const line = `- ${new Date().toISOString()} ${entry}`;
	writeFileSync(file, `${readFileSafe(file)}\n${line}\n`.replace(/^\n/, ""), "utf8");
}

/** Read a file safely (empty string when absent). */
function readFileSafe(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}
