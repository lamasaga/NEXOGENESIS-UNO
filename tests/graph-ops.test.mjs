// GraphOps 回归测试；当前运行契约见 docs/history/pre-uno/2026-08-30-TM-Skill-OPS与知识流程统一实施SPEC.md。
// 运行：node tests/graph-ops.test.mjs（读取 01-Cards 合成卡）
import {
  loadGraphOps, GraphOps, isArgumentEdge, isReferenceEdge, effectiveRelationType,
  queryTokens, hubPenalty
} from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { recordStructureReview } from "../packages/nexogenesis-tools/lib/cognition/structure-reviews.js";

import { isolatedGraphFixture } from "./fixtures/isolated-graph.mjs";
const root = isolatedGraphFixture();
const cards = loadCards(root);
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, detail); } };

// 1. 关系语义
check("effectiveRelationType: based-on+组成note→part-of",
  effectiveRelationType("based-on", "是组成部分") === "part-of");
check("effectiveRelationType: influences+时序note→precedes",
  effectiveRelationType("influences", "时间上先于") === "precedes");
check("effectiveRelationType: 普通保持", effectiveRelationType("supports") === "supports");
check("queryTokens: 长句补 n-gram", queryTokens("事后解释与反条件的对立").has("事后解释") || queryTokens("事后解释与反条件的对立").size > 1);

// 2. 论证边分类（用合成边）
const mkEdge = (from, to, type, note = "") => ({ from, to, kind: "relation", relation_type: type, note });
check("isArgumentEdge: supports 可走", isArgumentEdge(cards, mkEdge("a", "b", "supports")) === true);
check("isArgumentEdge: influences 默认不走", isArgumentEdge(cards, mkEdge("a", "b", "influences")) === false);
check("isArgumentEdge: influences 显式打开可走", isArgumentEdge(cards, mkEdge("a", "b", "influences"), { includeInfluences: true }) === true);
check("isArgumentEdge: precedes 不走", isArgumentEdge(cards, mkEdge("a", "b", "precedes")) === false);
check("isReferenceEdge: 对象引用独立于论证平面", isReferenceEdge(cards, mkEdge("a", "b", "characterizes")) === true
  && isArgumentEdge(cards, mkEdge("a", "b", "characterizes")) === false);
// applies-to → domain 目标剔除
const domainId = [...cards.keys()].find((id) => cards.get(id).meta.type === "domain");
check("isArgumentEdge: applies-to→domain 剔除", domainId ? isArgumentEdge(cards, mkEdge("a", domainId, "applies-to")) === false : true, "no domain card");

// 3. search / members 观察学分
const ops = loadGraphOps(root);
const s = ops.search("银行危机 最后贷款人");
check("search: channel=lexical", s.channel === "lexical");
check("search: 观察学分齐全", ["n", "hub_ratio", "on_topic_new", "truncated"].every((k) => k in s), JSON.stringify(s));
check("search: 返回节点含 id/title/type", s.nodes.every((n) => n.id && n.title && n.type));
const mem = ops.members(domainId ?? "");
check("members: channel=membership", mem.channel === "membership");
const misuse = ops.members("测试周期观察");
check("members: 非 domain 卡 misuse", misuse.misuse !== void 0);
check("cards: 样例卡不进入正式检索图", [...cards.keys()].every((id) => !id.startsWith("样例-")));
const hygieneRoot = mkdtempSync(join(tmpdir(), "nexo-graphops-hygiene-"));
try {
  const fixtureCards = join(hygieneRoot, "01-Cards");
  mkdirSync(fixtureCards, { recursive: true });
  writeFileSync(join(fixtureCards, "样例卡.md"), `---
id: 样例-图谱审计
namespace: example
title: 图谱审计样例
type: claim
domains: []
origin: system
relations: []
---
  此卡只用于验证样例隔离。\n`);
  for (const filename of ["重复卡-a.md", "重复卡-b.md"]) {
    writeFileSync(join(fixtureCards, filename), `---
id: 重复-图谱审计
title: 重复标识测试卡
type: claim
domains: []
origin: system
relations: []
---
  此卡只用于验证重复标识诊断。\n`);
  }
  const hygiene = loadGraphOps(hygieneRoot).structureIssues({ kinds: ["sample_card", "duplicate_id"], limit: 30 });
  check("structureIssues: 样例与重复 id 形成确定性问题队列",
    hygiene.issue_total === 2
      && hygiene.issues.some((item) => item.kind === "sample_card")
      && hygiene.issues.some((item) => item.kind === "duplicate_id"), JSON.stringify(hygiene));
} finally {
  rmSync(hygieneRoot, { recursive: true, force: true });
}

// 4. walk：合成卡 1 跳论证边（不含隶属）
const hub = "测试反馈机制"; // 真实高连接卡（含多个 relations）
const w = ops.walk(hub);
check("walk: channel=argument", w.channel === "argument");
check("walk: 返回 via/direction", w.nodes.every((n) => "via" in n && "direction" in n), JSON.stringify(w.nodes.slice(0, 2)));
const domainWalkMisuse = ops.walk(domainId ?? "x");
check("walk: 领域卡起点返回可纠正错误码",
  domainWalkMisuse.misuse_code === "domain_start_requires_members"
  && domainWalkMisuse.suggested_operator === "graph_members", JSON.stringify(domainWalkMisuse));
const wOut = ops.walk(hub, { direction: "out" });
check("walk: direction=out 过滤生效", wOut.nodes.every((n) => n.direction === "out" || n.direction === "both"));
// walk 结果不含隶属（domain 卡不会作为论证邻居出现，除非真有论证边指向它）
check("walk: 邻居不含领域星（hub_ratio 低或 0）", w.hub_ratio < 0.5, `hub_ratio=${w.hub_ratio}`);

const tracedCards = new Map([
  ["甲", { meta: { title: "测试甲", type: "claim", domains: ["领域甲"], maturity: "growing", origin: "user", school: "制度主义", applicable_scope: ["政策"], theory_status: "active", relations: [{ target: "乙", type: "supports", note: "只在流动性收缩时支持" }, { target: "丁", type: "influences", note: "流动性变化会改变跨市场传导强度" }] }, body: "## 作用机制\n\n流动性收缩通过保证金压力放大抛售。\n\n## 已知限制\n\n信用仍可得时机制较弱。" }],
  ["乙", { meta: { title: "乙", type: "claim", domains: ["领域甲"], maturity: "mature", origin: "system", relations: [{ target: "丙", type: "based-on", note: "经由资产负债表机制" }] }, body: "## 机制\n\n外币负债通过汇率变化放大偿付压力。\n\n## 缓冲因素\n\n充足储备可以减弱短期冲击。" }],
  ["丙", { meta: { title: "丙", type: "model", domains: ["领域乙"], maturity: "growing", origin: "system", relations: [{ target: "丁", type: "extends", note: "扩展到跨市场传导" }] }, body: "" }],
  ["丁", { meta: { title: "丁", type: "phenomenon", domains: ["领域乙"], maturity: "nascent", origin: "system", relations: [] }, body: "" }]
]);
const tracedOps = new GraphOps(
  tracedCards, new Map([["领域甲", ["甲", "乙"]], ["领域乙", ["丙", "丁"]]]),
  new Map([
    ["甲", [{ from: "甲", to: "乙", kind: "relation", relation_type: "supports", note: "只在流动性收缩时支持" }, { from: "甲", to: "丁", kind: "relation", relation_type: "influences", note: "流动性变化会改变跨市场传导强度" }]],
    ["乙", [{ from: "乙", to: "丙", kind: "relation", relation_type: "based-on", note: "经由资产负债表机制" }]],
    ["丙", [{ from: "丙", to: "丁", kind: "relation", relation_type: "extends", note: "扩展到跨市场传导" }]]
  ]),
  new Map([
    ["乙", [{ from: "甲", to: "乙", kind: "relation", relation_type: "supports", note: "只在流动性收缩时支持" }]],
    ["丙", [{ from: "乙", to: "丙", kind: "relation", relation_type: "based-on", note: "经由资产负债表机制" }]],
    ["丁", [{ from: "丙", to: "丁", kind: "relation", relation_type: "extends", note: "扩展到跨市场传导" }, { from: "甲", to: "丁", kind: "relation", relation_type: "influences", note: "流动性变化会改变跨市场传导强度" }]]
  ]),
  new Map(), root, null
);
const filteredWalk = tracedOps.walk("甲", { relationTypes: ["supports"] });
check("walk: relation_types 过滤并保留 edge note", filteredWalk.nodes[0]?.edge?.note === "只在流动性收缩时支持", JSON.stringify(filteredWalk));
const twoHopWalk = tracedOps.walk("甲", { direction: "out", hops: 2, limit: 2 });
check("walk: 2 跳返回逐层真实路径", twoHopWalk.layers.length === 2
  && twoHopWalk.nodes[1]?.hop === 2
  && twoHopWalk.nodes[1]?.path?.join("→") === "甲→乙→丙", JSON.stringify(twoHopWalk));
const threeHopWalk = tracedOps.walk("甲", { direction: "out", hops: 3, limit: 3 });
check("walk: 3 跳跨簇仍受总预算约束", threeHopWalk.reached_hops === 3
  && threeHopWalk.n === 3
  && threeHopWalk.layers[2]?.node_ids?.[0] === "丁"
  && threeHopWalk.nodes[2]?.path_edges?.length === 3, JSON.stringify(threeHopWalk));
const clampedWalk = tracedOps.walk("甲", { direction: "out", hops: 9, limit: 24 });
check("walk: 深度硬限制为 3 跳", clampedWalk.hops === 3 && /限制为 3/.test(clampedWalk.note), JSON.stringify(clampedWalk));
const metadataSearch = tracedOps.search("测试甲", { school: ["制度主义"], applicable_scope: ["政策"] });
check("search: school 与 applicable_scope 可作筛选", metadataSearch.nodes[0]?.id === "甲", JSON.stringify(metadataSearch));
check("search: 为有两跳结构的命中返回可执行 frontier",
  metadataSearch.structural_frontier[0]?.card_id === "甲"
    && metadataSearch.structural_frontier[0]?.two_hop_reachable >= 1
    && metadataSearch.suggested_operator === "graph_walk"
    && metadataSearch.suggested_args?.hops === 2,
  JSON.stringify(metadataSearch));
const comparison = tracedOps.compare(["甲", "乙"]);
check("compare: 返回元数据差异与显式关系说明", comparison.direct_relations[0]?.note === "只在流动性收缩时支持" && comparison.differences.甲.school[0] === "制度主义", JSON.stringify(comparison));
const semanticComparison = tracedOps.compare(["甲", "乙"], { dimensions: ["mechanism", "buffer", "counterevidence"] });
check("compare: 按语义维度返回正文矩阵和缺失项", semanticComparison.semantic_matrix.甲.mechanism[0]?.excerpt.includes("保证金")
  && semanticComparison.semantic_matrix.乙.buffer[0]?.excerpt.includes("储备")
  && semanticComparison.missing_dimensions.甲.includes("buffer"), JSON.stringify(semanticComparison));
const argumentView = tracedOps.argument("乙");
check("argument: 分组返回支持、依据与关系就绪度", argumentView.supports.length === 1
  && argumentView.based_on.length === 1 && argumentView.ready_relation_count === 2, JSON.stringify(argumentView));
const pathView = tracedOps.path("甲", "丙", { maxHops: 3, direction: "out" });
check("path: 只用 ready 关系找到两跳论证链", pathView.paths[0]?.node_ids?.join("→") === "甲→乙→丙"
  && pathView.paths[0]?.edges.every((edge) => edge.ready), JSON.stringify(pathView));
const contextWalk = tracedOps.walk("甲", { plane: "context", direction: "out" });
check("walk: context 平面只返回情境关系", contextWalk.nodes.length === 1
  && contextWalk.nodes[0]?.id === "丁" && contextWalk.nodes[0]?.edge?.type === "influences", JSON.stringify(contextWalk));

const entityCards = new Map([
  ["判断一", { meta: { title: "判断一", type: "claim", domains: ["领域甲"], origin: "document", sources: ["材料甲"], relations: [{ target: "机构甲", type: "characterizes", note: "该判断说明机构甲承担政策执行职能" }] }, body: "机构甲承担一种制度角色。" }],
  ["判断二", { meta: { title: "判断二", type: "model", domains: ["领域甲"], origin: "document", sources: ["材料乙"], relations: [] }, body: "机构甲参与第二种机制。" }],
  ["判断三", { meta: { title: "判断三", type: "phenomenon", domains: ["领域乙"], origin: "document", sources: ["材料丙"], relations: [] }, body: "机构甲再次出现。" }],
  ["机构甲", { meta: { title: "机构甲", type: "entity", entity_kind: "institution", aliases: ["机构A"], domains: ["领域甲"], origin: "document", sources: ["材料甲"], relations: [] }, body: "稳定对象。" }]
]);
const entityOps = new GraphOps(entityCards, new Map(),
  new Map([["判断一", [mkEdge("判断一", "机构甲", "characterizes", "该判断说明机构甲承担政策执行职能")]]]),
  new Map([["机构甲", [mkEdge("判断一", "机构甲", "characterizes", "该判断说明机构甲承担政策执行职能")]]]), new Map(), root, null);
const referenceWalk = entityOps.walk("判断一", { plane: "reference", direction: "out" });
check("walk: reference 平面返回实体对象", referenceWalk.nodes[0]?.id === "机构甲"
  && referenceWalk.nodes[0]?.edge?.readiness === "reference_ready", JSON.stringify(referenceWalk));
const entityCandidateView = entityOps.entityCandidates([{ name: "机构甲", aliases: ["机构A"], entity_kind: "institution" }]);
check("entityCandidates: 识别既有实体与多来源出现", entityCandidateView.candidates[0]?.status === "existing"
  && entityCandidateView.candidates[0]?.mention_card_count >= 3, JSON.stringify(entityCandidateView));

// 5. conflicts：找一张真实 conflict 卡
const conflictId = [...cards.keys()].find((id) => cards.get(id).meta.type === "conflict");
if (conflictId) {
  const c = ops.conflicts(conflictId);
  check("conflicts: conflict 卡返回 involves 两造", c.parties !== void 0 && Array.isArray(c.parties), JSON.stringify(c));
} else {
  check("conflicts: 库中无 conflict 卡（跳过）", true);
}

// 6. analogize：从真实 model/claim 出发
const modelId = [...cards.keys()].find((id) => cards.get(id).meta.type === "model");
if (modelId) {
  const a = ops.analogize(modelId);
  check("analogize: channel=analogical", a.channel === "analogical");
  check("analogize: 返回 why/score", a.nodes.every((n) => "why" in n && "score" in n), JSON.stringify(a.nodes.slice(0, 1)));
  check("analogize: 跨域（不含同域）", a.nodes.every((n) => !(n.domains ?? []).some((d) => (cards.get(modelId)?.meta.domains ?? []).includes(d))));
} else {
  check("analogize: 库中无 model 卡（跳过）", true);
}
const m2 = ops.analogize("测试周期观察"); // phenomenon → misuse
check("analogize: 非 model/claim/method misuse", m2.misuse !== void 0);

// 7. 未接入卡：必须通过元数据全局扫描定位，不能依赖关键词召回。
const isolatedCards = new Map([
  ["完全孤立", { meta: { title: "完全孤立", type: "claim", domains: [], relations: [], lifecycle: "active" }, body: "" }],
  ["仅缺关系", { meta: { title: "仅缺关系", type: "claim", domains: ["领域甲"], relations: [], lifecycle: "active" }, body: "" }],
  ["仅缺领域", { meta: { title: "仅缺领域", type: "claim", domains: [], relations: [{ target: "已接入", type: "supports" }], lifecycle: "active" }, body: "" }],
  ["已接入", { meta: { title: "已接入", type: "claim", domains: ["领域甲"], relations: [], lifecycle: "active" }, body: "" }],
  ["领域甲", { meta: { title: "领域甲", type: "domain", domains: [], relations: [], lifecycle: "active" }, body: "" }]
]);
const isolatedOps = new GraphOps(
  isolatedCards, new Map([["领域甲", ["仅缺关系"]]]),
  new Map([["仅缺领域", [{ from: "仅缺领域", to: "已接入", kind: "relation", relation_type: "supports" }]]]),
  new Map([["已接入", [{ from: "仅缺领域", to: "已接入", kind: "relation", relation_type: "supports" }]]]),
  new Map(), root, null
);
const fullIsolates = isolatedOps.unconnected();
check("unconnected: 完全孤立不因已有领域被排除", fullIsolates.candidate_total === 2 && ["完全孤立", "仅缺关系"].every(id => fullIsolates.nodes.some(node => node.id === id)), JSON.stringify(fullIsolates));
const noRelations = isolatedOps.unconnected({ scope: "without_relations" });
check("unconnected: 缺关系包含已有领域的卡", noRelations.candidate_total === 2 && noRelations.nodes.some((node) => node.id === "仅缺关系"));
const noDomain = isolatedOps.unconnected({ scope: "without_domain" });
check("unconnected: 缺领域不把领域卡本身列为成员候选", noDomain.candidate_total === 2 && noDomain.nodes.every((node) => node.id !== "领域甲"));
const noReadyRelations = isolatedOps.unconnected({ scope: "without_ready_relations" });
check("unconnected: 缺 note 的旧边不算可供多跳推理的 ready 关系",
  noReadyRelations.nodes.some((node) => node.id === "仅缺领域") && noReadyRelations.nodes.some((node) => node.id === "已接入"), JSON.stringify(noReadyRelations));

// 8. read 带 slots
const slotRead = ops.read(hub, { slots: ["失效边界"] });
check("read: slots 摘录（无匹配槽则空）", "body" in slotRead);

// 8.5 read_card 输出 schema 一致性（回归：GraphOps.read 含 channel，
//     工具层剥离后不得超出 read_card 的 additionalProperties:false 白名单）
const readCardSchemaKeys = new Set(["id","title","type","maturity","lifecycle","domains","origin","sources","relations","created","updated","theory_status","school","applicable_scope","entity_kind","aliases","source_summary","body","body_total","truncated","error"]);
const readSample = ops.read(hub);
const { channel, ...readResult } = readSample;
check("read_card: 剥离 channel 后无超白名单键",
  Object.keys(readResult).every((k) => readCardSchemaKeys.has(k)),
  Object.keys(readResult).join(","));
check("read_card: 关键字段齐全",
  ["id","title","type","domains","body"].every((k) => k in readResult));
const notFound = { id: "x", title: "x", type: "unknown", domains: [], body: "不存在" };
check("read_card: 未找到回退形状在白名单内",
  Object.keys(notFound).every((k) => readCardSchemaKeys.has(k)));

// 8.6 图工具观察根为宽松 schema（additionalProperties:true，extra 字段不拒）
const walkSample = ops.walk(hub);
check("graph 工具: 观察根含学分字段",
  ["channel","n","nodes","hub_ratio","on_topic_new","truncated"].every((k) => k in walkSample));


// 9. noteDebt：用临时根隔离（不污染真实 debts.jsonl）
const os = await import("node:os");
const path = await import("node:path");
const fs = await import("node:fs");
const tmpRoot = path.join(os.tmpdir(), `nexo-graphops-test-${Date.now()}`);
const governanceCards = new Map([
  ["冲突孤立", { meta: { title: "冲突孤立", type: "conflict", domains: [], sources: [], relations: [], lifecycle: "active" }, body: "两种解释尚未接入参与方。" }],
  ["来源孤立", { meta: { title: "库存周期测算", type: "phenomenon", domains: ["领域甲"], sources: ["材料甲"], relations: [], lifecycle: "active" }, body: "库存周期的阶段振幅具有不对称性。" }],
  ["相邻模型", { meta: { title: "库存周期阶段模型", type: "model", domains: ["领域甲"], sources: ["材料甲"], relations: [], lifecycle: "active" }, body: "库存周期阶段模型解释振幅不对称。" }],
  ["普通孤立", { meta: { title: "普通孤立", type: "claim", domains: [], sources: [], relations: [], lifecycle: "active" }, body: "当前没有足够候选。" }],
  ["领域甲", { meta: { title: "领域甲", type: "domain", domains: [], sources: [], relations: [], lifecycle: "active" }, body: "" }]
]);
const governanceOps = new GraphOps(governanceCards, new Map(), new Map(), new Map(), new Map(), tmpRoot, null);
const firstPage = governanceOps.unconnected({ scope: "without_relations", limit: 1 });
check("unconnected: 高优先级问题先于字母顺序且返回游标",
  firstPage.nodes[0]?.id === "冲突孤立" && typeof firstPage.next_cursor === "string" && firstPage.nodes[0]?.incident_summary.ready === 0,
  JSON.stringify(firstPage));
const secondPage = governanceOps.unconnected({ scope: "without_relations", cursor: firstPage.next_cursor, limit: 1 });
check("unconnected: 游标能推进到后续候选", secondPage.nodes.length === 1 && secondPage.nodes[0]?.id !== firstPage.nodes[0]?.id, JSON.stringify(secondPage));
recordStructureReview(tmpRoot, governanceCards, {
  card_id: "冲突孤立", issue_kind: "without_relations", status: "evidence_gap",
  reason: "尚缺两造对应知识卡，暂时不能建立参与关系。", candidate_ids: []
});
const continuedAfterReview = new GraphOps(governanceCards, new Map(), new Map(), new Map(), new Map(), tmpRoot, null)
  .unconnected({ scope: "without_relations", cursor: firstPage.next_cursor, excludeReviewed: true, limit: 1 });
check("unconnected: 前页审阅移出后稳定游标不跳过下一项",
  continuedAfterReview.nodes[0]?.id === secondPage.nodes[0]?.id, JSON.stringify(continuedAfterReview));
const endpointCandidates = governanceOps.integrationCandidates("来源孤立", { limit: 3, issueScope: "without_relations" });
check("integrationCandidates: 共享来源、领域和语义信号形成可解释候选",
  endpointCandidates.nodes[0]?.id === "相邻模型"
    && endpointCandidates.nodes[0]?.signals.shared_sources.includes("材料甲")
    && endpointCandidates.nodes[0]?.signals.evidence_tier === "E2"
    && endpointCandidates.nodes[0]?.signals.write_evidence_eligible === false
    && endpointCandidates.focus_fingerprint?.length === 64, JSON.stringify(endpointCandidates));

const relationCase = tracedOps.relationCase("甲", "乙", { relationType: "supports" });
check("relationCase: 一次返回端点语义、当前方向、路径与影响标志",
  relationCase.current_relations[0]?.type === "supports"
    && relationCase.endpoints.source.semantic_slots[0]?.excerpt.includes("保证金")
    && relationCase.existing_paths[0]?.node_ids?.join("→") === "甲→乙"
    && relationCase.case_fingerprint.length === 64,
  JSON.stringify(relationCase));
const keepSimulation = tracedOps.simulateRelationPatch({
  decision: "keep", sourceId: "甲", targetId: "乙", oldRelationType: "supports",
  evidence: ["甲#作用机制"], counterevidence: ["信用仍可得时机制较弱"],
  directionReason: "甲提供保证金压力机制，乙是该机制所支持的判断。",
  scopeOrBoundary: "只在流动性收缩且信用受限时成立。"
});
check("simulateRelationPatch: 结构化 keep 裁决通过 E4 且不产生重复边",
  keepSimulation.contract_valid && keepSimulation.E4_preflight.reached
    && keepSimulation.preflight_passed && !keepSimulation.checks.duplicate_relation,
  JSON.stringify(keepSimulation));
const newRelationSimulation = governanceOps.simulateRelationPatch({
  decision: "change", sourceId: "来源孤立", targetId: "相邻模型",
  proposedRelationType: "supports", note: "库存阶段振幅测算为阶段模型提供了可比较的现象证据",
  evidence: ["双方共享材料甲且正文分别描述振幅现象与阶段解释"],
  counterevidence: ["共同来源本身不足以证明支持关系"],
  directionReason: "现象证据指向解释该现象的模型。",
  scopeOrBoundary: "仅限材料甲讨论的库存周期阶段。"
});
check("simulateRelationPatch: 无旧边时 change 可表达新增关系候选",
  newRelationSimulation.adjudication.old_relation === null
    && newRelationSimulation.E4_preflight.reached && newRelationSimulation.preflight_passed,
  JSON.stringify(newRelationSimulation));
const invalidKeepWithoutOldRelation = governanceOps.simulateRelationPatch({
  decision: "keep", sourceId: "来源孤立", targetId: "相邻模型", oldRelationType: "supports",
  evidence: ["双方都讨论库存周期"], counterevidence: ["当前并没有可保留的既有边"],
  directionReason: "用于验证 keep 只能对应既有关系。", scopeOrBoundary: "只验证裁决动词与关系现状的一致性。"
});
check("simulateRelationPatch: 无旧边时 keep 明确返回契约错误",
  !invalidKeepWithoutOldRelation.contract_valid
    && invalidKeepWithoutOldRelation.contract_errors.includes("old_relation_not_found")
    && !invalidKeepWithoutOldRelation.preflight_passed,
  JSON.stringify(invalidKeepWithoutOldRelation));
const conflictTargetSimulation = governanceOps.simulateRelationPatch({
  decision: "change", sourceId: "来源孤立", targetId: "冲突孤立",
  proposedRelationType: "supports", note: "尝试让普通知识直接支持冲突档案",
  evidence: ["两者都讨论库存周期"], counterevidence: ["冲突档案不应代替真实立场承接论证"],
  directionReason: "仅为验证冲突角色阻断。", scopeOrBoundary: "冲突应由参与方关系归档。",
  criticalReview: "即使两者主题相关，普通判断也不应直接把冲突档案当作论证目标。"
});
check("simulateRelationPatch: conflict 作为目标不能承接普通论证边",
  conflictTargetSimulation.checks.conflict_role_violation
    && conflictTargetSimulation.deterministic_blockers.includes("conflict_role_violation")
    && !conflictTargetSimulation.preflight_passed,
  JSON.stringify(conflictTargetSimulation));
const riskyRemoval = tracedOps.simulateRelationPatch({
  decision: "remove", sourceId: "甲", targetId: "乙", oldRelationType: "supports",
  evidence: ["双方正文没有直接支持关系"], counterevidence: ["移除可能切断甲乙之间唯一直接链路"],
  scopeOrBoundary: "缺少能够证明支持方向的来源锚点。"
});
check("simulateRelationPatch: 路径切断移除要求第二次批判复核",
  riskyRemoval.requires_critical_review && !riskyRemoval.critical_review_completed
    && !riskyRemoval.preflight_passed, JSON.stringify(riskyRemoval));
const reviewedRemoval = tracedOps.simulateRelationPatch({
  decision: "remove", sourceId: "甲", targetId: "乙", oldRelationType: "supports",
  evidence: ["双方正文没有直接支持关系"], counterevidence: ["移除可能切断甲乙之间唯一直接链路"],
  scopeOrBoundary: "缺少能够证明支持方向的来源锚点。",
  criticalReview: "已重新检查局部路径；断开直接边会降低连通性，但保留伪关系的推理风险更高。"
});
check("simulateRelationPatch: 高风险复核后可进入 Harness 预检",
  reviewedRemoval.critical_review_completed && reviewedRemoval.preflight_passed,
  JSON.stringify(reviewedRemoval));

const priorityCards = new Map([
  ["甲", { meta: { id: "甲", title: "甲", type: "claim", domains: [], sources: [], relations: [
    { target: "甲", type: "supports", note: "自我支持不成立" },
    { target: "乙", type: "supports", note: "为乙提供一个具体论据" },
    { target: "乙", type: "supports", note: "为乙提供另一个重复论据" }
  ] }, body: "" }],
  ["乙", { meta: { id: "乙", title: "乙", type: "claim", domains: [], sources: [], relations: [] }, body: "" }]
]);
const priorityOps = new GraphOps(priorityCards, new Map(), new Map(), new Map(), new Map(), tmpRoot, null);
const priorityIssues = priorityOps.structureIssues({ limit: 30 });
check("structureIssues: P0 先行、重复问题去重并带稳定指纹",
  priorityIssues.issues.every((item) => item.priority === "P0")
    && priorityIssues.issues.every((item) => item.fingerprint?.length === 64)
    && priorityIssues.issues.filter((item) => item.kind === "duplicate_relation").length === 1
    && priorityIssues.totals_by_priority.P0 === priorityIssues.issue_total,
  JSON.stringify(priorityIssues));
recordStructureReview(tmpRoot, governanceCards, {
  card_id: "普通孤立", issue_kind: "without_relations", status: "intentionally_standalone",
  reason: "已经比较当前候选，只有宽泛主题相似，暂不建立关系。", candidate_ids: []
});
const excludedReview = governanceOps.unconnected({ scope: "without_relations", excludeReviewed: true, limit: 12 });
check("unconnected: 当前指纹下已审卡默认排除",
  !excludedReview.nodes.some((node) => node.id === "普通孤立") && excludedReview.reviewed_excluded_total === 2,
  JSON.stringify(excludedReview));
governanceCards.get("普通孤立").body += "新增证据使原审阅失效。";
const reopenedReview = new GraphOps(governanceCards, new Map(), new Map(), new Map(), new Map(), tmpRoot, null)
  .unconnected({ scope: "without_relations", excludeReviewed: true, limit: 12 });
check("unconnected: Card 改变后旧审阅自动失效并重新入队", reopenedReview.nodes.some((node) => node.id === "普通孤立"), JSON.stringify(reopenedReview));
recordStructureReview(tmpRoot, governanceCards, {
  card_id: "普通孤立", issue_kind: "without_relations", status: "linked",
  reason: "模拟此前已经接入但入边后来被移除的运行记录。", candidate_ids: []
});
const relinkRequired = new GraphOps(governanceCards, new Map(), new Map(), new Map(), new Map(), tmpRoot, null)
  .unconnected({ scope: "without_relations", excludeReviewed: true, limit: 12 });
check("unconnected: 原问题重新出现时 linked 记录不能隐藏卡片", relinkRequired.nodes.some((node) => node.id === "普通孤立"), JSON.stringify(relinkRequired));
recordStructureReview(tmpRoot, governanceCards, {
  card_id: "来源孤立", issue_kind: "without_relations", status: "duplicate_candidate",
  reason: "两张卡共享来源且核心机制高度重合，等待后续合并判断。", candidate_ids: ["相邻模型"]
});
const duplicateExcluded = new GraphOps(governanceCards, new Map(), new Map(), new Map(), new Map(), tmpRoot, null)
  .unconnected({ scope: "without_relations", excludeReviewed: true, limit: 12 });
check("unconnected: 近重复处置会暂时排除焦点卡", !duplicateExcluded.nodes.some((node) => node.id === "来源孤立"), JSON.stringify(duplicateExcluded));
governanceCards.get("相邻模型").body += "候选卡已经形成新的差异边界。";
const candidateChanged = new GraphOps(governanceCards, new Map(), new Map(), new Map(), new Map(), tmpRoot, null)
  .unconnected({ scope: "without_relations", excludeReviewed: true, limit: 12 });
check("unconnected: 候选卡改变后近重复结论失效", candidateChanged.nodes.some((node) => node.id === "来源孤立"), JSON.stringify(candidateChanged));
const tmpOps = new GraphOps(new Map(), new Map(), new Map(), new Map(), new Map(), tmpRoot, null);
const debt = tmpOps.noteDebt("uncovered_conflict", [hub], "测试债");
check("noteDebt: 合法债返回 ok", debt.ok === true && debt.channel === "debt", JSON.stringify(debt));
const debtFile = path.join(tmpRoot, ".nexogenesis", "graph", "debts.jsonl");
check("noteDebt: 写入 jsonl", fs.existsSync(debtFile) && fs.readFileSync(debtFile, "utf8").includes("uncovered_conflict"));
tmpOps.noteDebt("relation_evidence_gap", [hub, "候选卡"], "新卡成立，但仍缺少能够判定关系方向的共同来源证据。");
const debtIssues = tmpOps.structureIssues({ kinds: ["relation_evidence_gap"] });
check("structureIssues: 消化留下的关系证据缺口进入建构队列",
  debtIssues.issue_total === 1 && debtIssues.issues[0].source === "graph_debt"
    && debtIssues.issues[0].candidate_ids.includes("候选卡"), JSON.stringify(debtIssues));
const bad = tmpOps.noteDebt("not-a-kind", [], "x");
check("noteDebt: 非法债类型报错", bad.ok === false);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
