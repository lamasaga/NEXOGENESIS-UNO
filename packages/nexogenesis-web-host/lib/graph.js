import { assetsForBookUnit } from '../../nexogenesis-tools/lib/uno/book-sources.js';
import { BOOK_UNIT_REF, bookExtractionBase, sameBookUnitSource } from '../../nexogenesis-tools/lib/uno/book-paths.js';
import { bookEvidencePath, bookEvidenceRevision } from '../../nexogenesis-tools/lib/uno/book-evidence.js';
import { readUnoUnit, unoPath, unoRevision, sha } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { resolveKnowledgeRef, knowledgeRef } from './project-knowledge.js';
/**
 * /api/graph and /api/cards compatibility handlers (M4 fs-direct subset).
 *
 * Reads the knowledge-body markdown cards (01-Cards/) directly:
 *   /api/graph       → { nodes, edges } mirroring the original Python
 *                      build_graph_payload (frontmatter-driven, relations →
 *                      edges, cached force layout for x/y).
 *   /api/cards/:id   → CardDetail { id, title, type, maturity, domains,
 *                      updated, body } for the CardReader.
 *
 * M4 remainder (RAG retrieve, graph animation events) lands later; this
 * subset is what makes the main surface loadable now.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadCards as loadKnowledgeCards, parseCardFile } from "../../nexogenesis-tools/lib/cards.js";
import { displayType } from "../../nexogenesis-tools/lib/uno-contract.js";
import { CARD_CLASSIFICATION_CONTRACT, CARD_TYPES, CARD_TYPE_LABELS } from '../../nexogenesis-tools/lib/uno/card-classification.js';
import { HttpError, json } from "./rpc.js";
import { ensureLayoutAsync, LAYOUT_VERSION } from "./layout.js";
import { readMaterial, listDomainsV2, readKnowledgeCard, resolveCardTarget } from '../../nexogenesis-tools/lib/uno/knowledge.js';
import { activeDomain } from '../../nexogenesis-tools/lib/uno/domain-contract.js';
import { buildDomainEdges, domainReadingDetail } from './domain-view.js';

// ---- card store scan ----

/** Recursively list *.md files under a directory. */
function listMarkdown(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) out.push(...listMarkdown(join(dir, entry.name)));
		else if (entry.name.endsWith(".md")) out.push(join(dir, entry.name));
	}
	return out;
}

/** Load all active cards from 01-Cards/ (id-keyed). */
function loadCards(root) {
	return loadKnowledgeCards(root);
}

/** Primary domain helper mirroring the original Python `_primary_domain`. */
function primaryDomain(domains) {
	return Array.isArray(domains) && domains.length > 0 ? domains[0] : "_none";
}

function relationshipIndex(cards, root) {
	const related = new Map([...cards.keys()].map((id) => [id, []]));
	for (const [sourceId, card] of cards) {
		const relations = Array.isArray(card.meta.relations) ? card.meta.relations : [];
		for (const relation of relations) {
			const targetId = typeof relation?.target === "string" ? (root ? resolveCardTarget(root,relation.target) : relation.target) : "";
			if (!targetId || !cards.has(targetId)) continue;
			const type = typeof relation?.type === "string" ? relation.type : "relation";
			const note = typeof relation?.note === "string" ? relation.note : "";
			related.get(sourceId).push({ direction: "outgoing", target: targetId, type, note });
			related.get(targetId).push({ direction: "incoming", target: sourceId, type, note });
		}
	}
	return related;
}

function plainExcerpt(body, query) {
	const plain = String(body ?? "")
		.replace(/(?:<!--|&lt;!--|&#60;!--)\s*unit\s*:[\s\S]*?(?:-->|--&gt;|--&#62;)/gi, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#>*_`~|\[\]()-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!plain) return "这张卡片还没有可预览的正文。";
	const token = String(query ?? "").trim().toLocaleLowerCase("zh-CN").split(/\s+/).find(Boolean);
	const index = token ? plain.toLocaleLowerCase("zh-CN").indexOf(token) : -1;
	const start = index > 48 ? Math.max(0, index - 44) : 0;
	const excerpt = plain.slice(start, start + 168);
	return `${start > 0 ? "…" : ""}${excerpt}${start + excerpt.length < plain.length ? "…" : ""}`;
}

function catalogScore(card, relations, query, tokens) {
	if (!tokens.length) return 0;
	const title = String(card.meta.title ?? card.meta.id ?? "").toLocaleLowerCase("zh-CN");
	const type = String(card.meta.type ?? "").toLocaleLowerCase("zh-CN");
	const domains = (Array.isArray(card.meta.domains) ? card.meta.domains : []).join(" ").toLocaleLowerCase("zh-CN");
	const relationText = relations.map((item) => `${item.type} ${item.target} ${item.note}`).join(" ").toLocaleLowerCase("zh-CN");
	const body = String(card.body ?? "").toLocaleLowerCase("zh-CN");
	let score = title.includes(query) ? 18 : 0;
	for (const token of tokens) {
		if (title.includes(token)) score += 8;
		if (type.includes(token)) score += 4;
		if (domains.includes(token)) score += 4;
		if (relationText.includes(token)) score += 3;
		if (body.includes(token)) score += 1;
	}
	return score;
}

function facetCounts(values, labelOf = (value) => value) {
	const counts = new Map();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || labelOf(left).localeCompare(labelOf(right), "zh-CN"))
		.map(([value, count]) => ({ value, label: labelOf(value), count }));
}

/**
 * Build the read-only card catalog used by the card browser. Search covers
 * title, body, type, domains and both incoming/outgoing relationship data.
 */
export function buildCardCatalog(projectRoot, options = {}) {
	const cards = loadCards(projectRoot);
	const relationsByCard = relationshipIndex(cards, projectRoot);
	const domainFilter = String(options.domain ?? "");
	const domainTitles = new Map(listDomainsV2(projectRoot).map(d=>[d.id,d.title]));
	const domainDocs = listDomainsV2(projectRoot), children = new Map();
	for (const domain of domainDocs) for (const parent of domain.parents ?? []) children.set(parent,[...(children.get(parent)??[]),domain.id]);
	const acceptedDomains = new Set(domainFilter ? [domainFilter] : []);
	for (const id of acceptedDomains) for (const child of children.get(id) ?? []) acceptedDomains.add(child);
	const titleOf = (id) => String(cards.get(id)?.meta.title ?? domainTitles.get(id) ?? id);
	const query = String(options.query ?? "").trim().toLocaleLowerCase("zh-CN");
	const tokens = query.split(/\s+/).filter(Boolean);
	const typeFilter = String(options.type ?? "");
	const relationFilter = String(options.relation ?? "");
	const sort = ["relevance", "updated", "title", "relations"].includes(options.sort) ? options.sort : (query ? "relevance" : "updated");
	const items = [];
	for (const [id, card] of cards) {
		const meta = card.meta;
		const type = displayType(meta);
		const domains = Array.isArray(meta.domains) ? meta.domains : [];
		const relations = relationsByCard.get(id) ?? [];
		if (typeFilter && type !== typeFilter) continue;
		if (domainFilter && !domains.some(id=>acceptedDomains.has(id))) continue;
		if (relationFilter && !relations.some((item) => item.type === relationFilter)) continue;
		const relationText = relations.map((item) => `${item.type} ${item.target} ${titleOf(item.target)} ${item.note}`).join(" ");
		const searchable = [id, meta.title, type, CARD_TYPE_LABELS[type] ?? '', domains.join(" "), relationText, card.body]
			.join(" ").toLocaleLowerCase("zh-CN");
		if (tokens.some((token) => !searchable.includes(token))) continue;
		items.push({
			id,
			title: String(meta.title ?? id),
			type,
			maturity: String(meta.maturity ?? "growing"),
			domains,
			domain_titles: Object.fromEntries(domains.map((domain) => [domain, titleOf(domain)])),
			updated: String(meta.updated ?? ""),
			excerpt: plainExcerpt(card.body, query),
			relation_count: relations.length,
			source_count: Array.isArray(meta.sources) ? meta.sources.length : 0,
			_score: catalogScore(card, relations.map((item) => ({ ...item, target: `${item.target} ${titleOf(item.target)}` })), query, tokens)
		});
	}
	items.sort((left, right) => {
		if (sort === "relevance") return right._score - left._score || right.updated.localeCompare(left.updated) || left.title.localeCompare(right.title, "zh-CN");
		if (sort === "title") return left.title.localeCompare(right.title, "zh-CN");
		if (sort === "relations") return right.relation_count - left.relation_count || left.title.localeCompare(right.title, "zh-CN");
		return right.updated.localeCompare(left.updated) || left.title.localeCompare(right.title, "zh-CN");
	});
	const typeValues = [...cards.values()].map((card) => displayType(card.meta));
	const domainValues = [...cards.values()].flatMap((card) => Array.isArray(card.meta.domains) ? card.meta.domains : []);
	const relationValues = [...relationsByCard.values()].flatMap((relations) => [...new Set(relations.map((relation) => relation.type))]);
	return {
		items: items.map(({ _score, ...item }) => item),
		total: items.length,
		all_total: cards.size,
		facets: {
			types: facetCounts(typeValues, value => CARD_TYPE_LABELS[value] ?? value),
			domains: facetCounts(domainValues, titleOf),
			relations: facetCounts(relationValues)
		}
	};
}

/**
 * Build the graph edges for a knowledge body: card relations → sorted edges
 * with stable `e<i>` ids (mirrors the original Python build_graph_payload).
 * Shared by /api/graph and the chat bridge (so animation edge ids match the
 * topology the frontend received).
 * @param root - knowledge-body root.
 * @returns edges array (from/to/kind/relation_type/bundle/id).
 */
export function buildGraphEdges(root) {
	const cards = loadCards(root);
	const domainOf = new Map();
	for (const [id, card] of cards) {
		const domains = Array.isArray(card.meta.domains) ? card.meta.domains : [];
		domainOf.set(id, primaryDomain(domains));
	}
	const edges = [];
	for (const [id, card] of cards) {
		const relations = Array.isArray(card.meta.relations) ? card.meta.relations : [];
		for (const rel of relations) {
			const target = typeof rel?.target === "string" ? resolveCardTarget(root,rel.target) : void 0;
			if (!target || target === id || !cards.has(target)) continue;
			const kind = typeof rel?.type === "string" ? rel.type : "relation";
			edges.push({
				from: id,
				to: target,
				kind,
				relation_type: kind,
				bundle: bundleId(domainOf.get(id), domainOf.get(target))
			});
		}
	}
	edges.sort((a, b) => `${a.from}|${a.to}|${a.kind}`.localeCompare(`${b.from}|${b.to}|${b.kind}`));
	edges.forEach((edge, i) => { edge.id = `e${i}`; });
	return edges;
}

/** GET /api/graph → GraphData (mirrors build_graph_payload + force layout). */
export async function handleGraphGet(ctx, _req, res, _trustedHosts, projectRoot) {
	const cards = loadCards(projectRoot);
	const nodes = [];
	for (const [id, card] of cards) {
		const meta = card.meta;
		nodes.push({
			id,
			title: String(meta.title ?? id),
			type: displayType(meta),
			domains: Array.isArray(meta.domains) ? meta.domains : []
		});
	}
	//  拓扑变化触发后台重排，避免阻塞对话；无变化则复用坐标缓存。
	const edges = buildGraphEdges(projectRoot);
  const domainDocs=listDomainsV2(projectRoot);
  for(const d of domainDocs.filter(activeDomain)) nodes.push({id:'domain:'+d.id,title:d.title,type:'domain',domains:[]});
  edges.push(...buildDomainEdges(domainDocs));
	const positions = await ensureLayoutAsync(projectRoot, nodes, edges);
	json(res, 200, {
		layout_version: LAYOUT_VERSION,
		nodes: nodes.map((n) => ({
			...n,
			x: positions[n.id]?.x ?? 0,
			y: positions[n.id]?.y ?? 0
		})),
		edges
	});
}

/**
 * Read-only counts for the menu's graph overview. It uses the same markdown
 * scan and relation builder as the canvas, so both surfaces stay consistent.
 */
export function buildGraphOverview(projectRoot) {
	const cards = loadCards(projectRoot);
	const nodesByType = new Map();
	for (const card of cards.values()) {
		const type = displayType(card.meta);
		nodesByType.set(type, (nodesByType.get(type) ?? 0) + 1);
	}
	const edges = buildGraphEdges(projectRoot);
	const relationsByType = new Map();
	for (const edge of edges) {
		const type = String(edge.relation_type ?? edge.kind ?? "relation");
		relationsByType.set(type, (relationsByType.get(type) ?? 0) + 1);
	}
	const nodeCount = cards.size;
	const relationTotal = edges.length;
	const entityCount = nodesByType.get("entity") ?? 0;
	const judgment = {
		tone: "info",
		text: "知识卡承载可独立理解的知识对象；领域组织长期问题空间；关系用于细分、补充、对照、质疑、类比、例证或应用。关系提供阅读导航，不自动证明结论。"
	};
	return {
		node_count: nodeCount,
		edge_count: relationTotal,
		domain_count: listDomainsV2(projectRoot).length,
		entity_count: entityCount,
		classification_scope: CARD_CLASSIFICATION_CONTRACT,
		node_types: rankedCounts(nodesByType, CARD_TYPES),
		relation_types: rankedCounts(relationsByType),
		relation_highlight: null,
		judgment
	};
}

function rankedCounts(counts, preferred = []) {
	const order = new Map(preferred.map((type, index) => [type, index]));
	return [...counts.entries()]
		.filter(([type, count]) => type && count > 0)
		.sort(([leftType, leftCount], [rightType, rightCount]) => rightCount - leftCount || (order.get(leftType) ?? 99) - (order.get(rightType) ?? 99) || leftType.localeCompare(rightType))
		.map(([type, count]) => ({ type, count }));
}

/** GET /api/graph/overview → concise graph counts and a plain-language judgment. */
export async function handleGraphOverviewGet(_ctx, _req, res, _trustedHosts, projectRoot) {
	json(res, 200, buildGraphOverview(projectRoot));
}

/** GET /api/cards → searchable card catalog. */
export async function handleCardList(_ctx, req, res, _trustedHosts, projectRoot) {
	const url = new URL(req.url ?? "/api/cards", "http://localhost");
	json(res, 200, buildCardCatalog(projectRoot, {
		query: url.searchParams.get("q") ?? "",
		type: url.searchParams.get("type") ?? "",
		domain: url.searchParams.get("domain") ?? "",
		relation: url.searchParams.get("relation") ?? "",
		sort: url.searchParams.get("sort") ?? ""
	}));
}

/** The user reads archived evidence independently of a running compilation job.
 * A unit must belong to its immutable extraction catalog, never an arbitrary file. */
function archivedBookUnit(root, ref) {
  const match = BOOK_UNIT_REF.exec(ref);
  if (!match) throw new HttpError(400, '图书原文引用无效');
  const file = bookEvidencePath(root, ref), base = bookExtractionBase(ref);
  const catalogFile = bookEvidencePath(root, base + '/catalog.md');
  if (!existsSync(file) || !existsSync(catalogFile)) throw new HttpError(404, '整理后的图书原文未找到');
  const unit = parseCardFile(file), catalog = parseCardFile(catalogFile);
  const expected = Array.isArray(catalog.meta.units) && catalog.meta.units.find(row => sameBookUnitSource(row.ref, ref));
  const originalPattern = new RegExp(`^03-Archive/books/${match[1]}/original\\.[a-z0-9]{1,10}$`);
  if (unit.meta.kind !== 'uno-book-unit-v1' || catalog.meta.kind !== 'uno-book-catalog-v1'
    || unit.meta.source_revision !== match[1] || unit.meta.extraction_revision !== match[2] || unit.meta.unit_id !== match[3]
    || catalog.meta.source_revision !== match[1] || catalog.meta.extraction_revision !== match[2]
    || typeof unit.meta.source_ref !== 'string' || !originalPattern.test(unit.meta.source_ref)
    || catalog.meta.source_ref !== unit.meta.source_ref || !expected || expected.revision !== bookEvidenceRevision(root, ref)
    || unit.meta.content_revision !== sha(unit.body) || expected.content_revision !== unit.meta.content_revision
    || unit.meta.chars !== Array.from(unit.body).length || unit.meta.chars > 60000)
    throw new HttpError(409, '原文单元与目录或版本不一致，不能显示为已核验的来源');
  if (!existsSync(unoPath(root, unit.meta.source_ref))) throw new HttpError(404, '归档原书未找到');
  return { ...unit, book_title: String(catalog.meta.title ?? '归档图书'), base };
}

const scopedAssetUrl = (ref, scope) => '/api/uno/assets?ref=' + encodeURIComponent(ref) + (scope ? '&library_id=' + encodeURIComponent(scope) : '');
function bookUnitAssets(unit, root, scope, inventory = false) {
  return (inventory || unit.meta.asset_scope === 'unit' ? (unit.meta.assets ?? []) : assetsForBookUnit(unit.meta.assets ?? [], unit.body, unit.meta.chapter_metadata)).filter(asset => {
    if (typeof asset.ref !== 'string') return false;
    const prefix = unit.base.replace(/^03-Archive\//, '05-Buffer/') + '/assets/';
    const normalized = asset.ref.replace(/^03-Archive\//, '05-Buffer/');
    if (!normalized.startsWith(prefix)) return false;
    const name = normalized.slice(prefix.length);
    return /^[a-zA-Z0-9._-]+$/.test(name) && name !== '.' && name !== '..' && existsSync(bookEvidencePath(root, asset.ref));
  }).map(asset => ({ ...asset, url: scopedAssetUrl(asset.ref, scope) }));
}

/** GET /api/cards/:id → CardDetail */
export async function handleCardGet(ctx, _req, res, _trustedHosts, projectRoot, id) {
    const resolved = resolveKnowledgeRef(projectRoot, id);
    projectRoot = resolved.root; id = resolved.id;
	if(id.startsWith('book:')){
    const match=/^book:(.+):(\d+)$/.exec(id);
    if(!match||!Number.isSafeInteger(Number(match[2])))throw new HttpError(400,'图书原文引用无效');
    const unit=archivedBookUnit(projectRoot,match[1]),chars=Array.from(unit.body),offset=Number(match[2]);
    if(offset>chars.length)throw new HttpError(400,'原文位置超出当前阅读单元');
    const text=chars.slice(offset,offset+60000).join('');
    return json(res,200,{id:resolved.scope?knowledgeRef(resolved.scope,id):id,title:unit.meta.title??'图书原文',
      type:'source',domains:[],domain_titles:{},relations:[],maturity:'原文',updated:'',
      summary:`${unit.book_title} · ${unit.meta.locator??unit.meta.chapter_locator??''} · 当前单元字符 ${offset}–${offset+Array.from(text).length}/${chars.length}`,
      body:text,sources:[unit.meta.source_ref],assets:bookUnitAssets(unit,projectRoot,resolved.scope),library_id:resolved.scope??null});
  }
  if(id.startsWith('domain:')) {
    const domains = listDomainsV2(projectRoot), domain = domains.find(row => row.id === id.slice(7));
    if(!domain) throw new HttpError(404,'领域未找到');
    const qualify = target => resolved.scope ? knowledgeRef(resolved.scope,target) : target;
    return json(res,200,{ id:qualify(id), title:domain.title, type:'domain', domains:[], domain_titles:{},
      maturity:activeDomain(domain) ? '领域说明' : '已退役领域', body:domain.body, summary:domain.summary, sources:[domain.ref],
      updated:domain.updated ?? '', library_id:resolved.scope ?? null,
      ...domainReadingDetail(domain,domains,loadCards(projectRoot),qualify) });
  }
	if(id.startsWith('buffer:')){const match=/^buffer:(05-Buffer\/(?:themes\/_sources\/.+|_index\/[^/]+)\.md):(\d+)$/.exec(id);if(!match)throw new HttpError(400,'原文引用无效');const unit=readMaterial(projectRoot,match[1],Math.max(0,Number(match[2])-200),30000);return json(res,200,{id:resolved.scope?knowledgeRef(resolved.scope,id):id,title:unit.title??'原文细节',type:'source',domains:[],domain_titles:{},relations:[],maturity:'source',updated:'',body:unit.text+(unit.truncated?'\n\n（本次显示已截断，可在编译工具中继续读取。）':''),sources:[unit.source+'；'+unit.locator]});}
	const cards = loadCards(projectRoot);
	const card = readKnowledgeCard(projectRoot,id);
	if (card === void 0) throw new HttpError(404, `卡片不存在: ${id}`);
	const meta = card.meta;
  const assets=[],seenAssets=new Set(),seenSources=new Set();
  const visit=ref=>{try{const file=ref.split('#')[0];if(seenSources.has(file))return;seenSources.add(file);const parsed=BOOK_UNIT_REF.test(file)?archivedBookUnit(projectRoot,file):file.startsWith('05-Buffer/')?readUnoUnit(projectRoot,file):file.startsWith('03-Archive/aggregates/')?parseCardFile(unoPath(projectRoot,file)):null;if(!parsed)return;for(const a of parsed.base?bookUnitAssets(parsed,projectRoot,resolved.scope,true):parsed.meta.assets??[]){if(!card.body.includes(a.ref)&&!(meta.assets??[]).some(item=>(typeof item==='string'?item:item.ref)===a.ref))continue;if(seenAssets.has(a.ref))continue;seenAssets.add(a.ref);assets.push({...a,url:scopedAssetUrl(a.ref,resolved.scope)});}for(const source of parsed.meta.sources??[])visit(source);}catch{}}
  for(const source of meta.sources??[])visit(source);
	const relations = relationshipIndex(cards,projectRoot).get(id) ?? [];
	const domainTitles=new Map(listDomainsV2(projectRoot).map(d=>[d.id,d.title]));
	const titleOf = (target) => String(cards.get(target)?.meta.title ?? domainTitles.get(target) ?? target);
	const domains = Array.isArray(meta.domains) ? meta.domains : [];
	json(res, 200, {
		id: resolved.scope ? knowledgeRef(resolved.scope, id) : id,
		title: String(meta.title ?? id),
		type: displayType(meta),
		maturity: String(meta.maturity ?? "growing"),
		domains,
		domain_titles: Object.fromEntries(domains.map((domain) => [domain, titleOf(domain)])),
		relations: relations.map((relation) => ({ ...relation, target_title: titleOf(relation.target), target: resolved.scope ? knowledgeRef(resolved.scope, relation.target) : relation.target })),
		sources: Array.isArray(meta.sources) ? meta.sources : [],
    assets,library_id:resolved.scope??null,
		updated: String(meta.updated ?? ""),
		body: card.body
		,summary:meta.summary,quality_notes:meta.quality_notes,superseded_by:meta.superseded_by
	});
}

export { HttpError, listMarkdown, loadCards, parseCardFile };

/** Mirror the original Python `_bundle_id`. */
function bundleId(d1, d2) {
	return d1 === d2 ? d1 : [d1, d2].sort().join("::");
}
