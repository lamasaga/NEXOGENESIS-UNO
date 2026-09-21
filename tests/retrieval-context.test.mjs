// 首轮 retrieve 与高级 graph_search 必须共享同一联合召回和上下文计划引擎。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { loadGraphOps, retrievalQueryTokens } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";

const root = mkdtempSync(join(tmpdir(), "nexo-retrieval-context-"));
const today = new Date().toISOString().slice(0, 10);
const card = (id, type, body, relations = [], sources = []) => ({
  id, title: id, type, maturity: "growing", lifecycle: "active", domains: [],
  origin: "user", sources, relations, created: today, updated: today, body
});

try {
  const monetaryTokens = retrievalQueryTokens("美元从加息转向降息时如何判断衰退");
  assert.ok(["美元", "加息", "降息", "衰退"].every((token) => monetaryTokens.has(token)));
  assert.ok(!["美元从", "息转", "息时", "向降"].some((token) => monetaryTokens.has(token)));
  const transmissionTokens = retrievalQueryTokens("市场情绪通过信用和流动性影响宏观经济");
  assert.ok(["市场情绪", "信用", "流动性", "宏观经济"].every((token) => transmissionTokens.has(token)));
  assert.ok(!["情绪通过", "信用和", "通过信", "和流动性"].some((token) => transmissionTokens.has(token)));
  const ordinaryWordTokens = retrievalQueryTokens("青年失业与和平发展");
  assert.ok(["青年", "失业", "和平", "发展"].every((token) => ordinaryWordTokens.has(token)), "连接词切分不能破坏普通词语");

  commitCard(root, card("流动性危机会放大抛售", "claim", [
    "## 核心表达", "", "流动性危机通过融资约束和被迫出售形成反馈。"
  ].join("\n"), [
    { target: "融资约束反馈模型", type: "based-on", note: "融资约束反馈解释流动性危机如何放大被迫抛售" },
    { target: "现金缓冲可以打断反馈", type: "conflicts-with", note: "充足现金缓冲构成流动性危机放大结论的实质反例" },
    { target: "缺说明的弱邻居", type: "supports" }
  ]));
  commitCard(root, card("融资约束反馈模型", "model", [
    "## 机制", "", "保证金、抵押品价格和融资能力相互反馈。"
  ].join("\n"), [
    { target: "保证金压力案例", type: "supports", note: "保证金压力案例支持融资约束反馈在压力期成立" }
  ]));
  commitCard(root, card("保证金压力案例", "claim", [
    "## 依据", "", "压力时期保证金要求上升并伴随被迫出售。"
  ].join("\n"), [], ["案例来源#压力期"]));
  commitCard(root, card("现金缓冲可以打断反馈", "claim", [
    "## 核心表达", "", "预先持有现金可以减少被迫出售。", "", "## 限制与边界", "", "缓冲不足或资产冻结时，该反例不成立。"
  ].join("\n")));
  commitCard(root, card("缺说明的弱邻居", "claim", "这张卡只通过缺 note 的旧边相连。"));
  commitCard(root, card("抵押品价格下跌会收紧融资", "claim", [
    "## 机制", "", "抵押品价格下跌会削弱抵押折价约束并形成抵押折价螺旋；脆弱性传导随后收紧融资能力。"
  ].join("\n"), [
    { target: "抵押折价传导模型", type: "based-on", note: "抵押折价传导模型解释价格下跌如何收紧融资能力" }
  ]));
  commitCard(root, card("抵押折价传导模型", "model", [
    "## 机制", "", "抵押折价约束使资产价格变化传导为融资能力变化。"
  ].join("\n")));
  commitCard(root, card("被迫出售反馈机制", "model", [
    "## 机制", "", "抵押折价约束在压力下会加强抵押折价螺旋；脆弱性传导收缩融资能力并诱发被迫出售，放大市场流动性风险。"
  ].join("\n")));

  const plan = loadGraphOps(root).retrieveContext("流动性危机的传导机制与反例", { limit: 8, graphHops: 2 });
  const ids = plan.nodes.map((node) => node.id);
  assert.equal(plan.channel, "context-retrieval");
  assert.ok(ids.includes("流动性危机会放大抛售"));
  assert.ok(ids.includes("融资约束反馈模型"));
  assert.ok(ids.includes("保证金压力案例"), "ready 两跳节点应进入联合候选池");
  assert.ok(ids.includes("现金缓冲可以打断反馈"), "实质冲突与边界不应被同类核心卡挤掉");
  assert.ok(!ids.includes("缺说明的弱邻居"), "legacy 旧边不能参与两跳候选扩展");
  assert.equal(plan.context_plan.coverage.mechanism, true);
  assert.equal(plan.context_plan.coverage.evidence, true);
  assert.equal(plan.context_plan.coverage.counter, true);
  assert.equal(plan.context_plan.coverage.boundary, true);
  assert.equal(plan.suggested_operator, "graph_walk");
  assert.ok(plan.context_plan.selected.every((item) => item.reasons.length && item.read_slots.length));

  const discoveryPlan = loadGraphOps(root).retrieveContext("抵押品价格下跌的脆弱性", { limit: 16, graphHops: 0 });
  const discovered = discoveryPlan.nodes.find((node) => node.retrieval_source === "discovery");
  assert.ok(discovered, "首轮应从直接命中卡的机制锚点发现未建正式边的候选桥梁");
  assert.equal(discovered.retrieval_source, "discovery");
  assert.equal(discovered.discovery.status, "unverified_association");
  assert.equal(discovered.discovery.write_evidence_eligible, false);
  assert.ok(discoveryPlan.context_plan.selected.some((item) => item.candidate_status === "unverified_association"));

  const compactPlan = loadGraphOps(root).retrieveContext("抵押品价格下跌的脆弱性", { limit: 4, graphHops: 1 });
  assert.ok(compactPlan.nodes.some((node) => node.id === "抵押折价传导模型" && node.retrieval_source === "graph"));
  assert.ok(!compactPlan.nodes.some((node) => node.retrieval_source === "discovery"), "小预算必须优先保留直接与 ready 图候选");

  const routedPlan = loadGraphOps(root).retrieveContext("请判断当前金融脆弱性", {
    limit: 4, graphHops: 0,
    intent: {
      focus: ["抵押品价格下跌"], mechanisms: ["抵押折价约束"], context: ["压力时期"],
      contrasts: ["现金缓冲"], exclusions: ["货币政策"]
    }
  });
  assert.equal(routedPlan.retrieval_intent.source, "model_brief");
  assert.deepEqual(routedPlan.retrieval_intent.focus, ["抵押品价格下跌"]);
  assert.ok(routedPlan.nodes.some((node) => node.id === "抵押品价格下跌会收紧融资"), "结构化意图应为泛化问题提供稳定的主焦点召回");

  const rawTailPlan = loadGraphOps(root).retrieveContext("抵押品价格下跌如何与流动性危机共同放大风险", {
    limit: 16, graphHops: 0, intent: { focus: ["抵押品价格下跌"], mechanisms: ["抵押折价约束"] }
  });
  assert.ok(rawTailPlan.retrieval_intent.intent_effects.raw_tail_term_count > 0, "返回值必须表明原问题尾部确实参与了补召回");
  assert.ok(rawTailPlan.raw_tail_candidate_total > 0, "原问题尾部的强命中必须实际进入有限候选池");
  assert.ok(rawTailPlan.nodes.some((node) => node.id === "流动性危机会放大抛售"), "结构化意图不能把原问题中的第二机制静默丢弃");

  commitCard(root, card("模板甲", "claim", "## 机制\n\nthis would be a generic copied sentence."));
  commitCard(root, card("模板乙", "claim", "## 机制\n\nthis would be another generic copied sentence."));
  const templateAssociation = loadGraphOps(root)._discoveryAssociation("模板甲", "模板乙");
  assert.equal(templateAssociation.qualified, false, "英文模板和通用章节不能制造候选关联");

  commitCard(root, card("嵌套短语甲", "claim", "## 机制\n\n铸币法案引起争议。"));
  commitCard(root, card("嵌套短语乙", "claim", "## 机制\n\n铸币法案需要复核。"));
  const nestedAssociation = loadGraphOps(root)._discoveryAssociation("嵌套短语甲", "嵌套短语乙");
  assert.equal(nestedAssociation.qualified, false, "同一概念的嵌套短语不能被重复计为多条发现证据");

  const integration = loadGraphOps(root).integrationCandidates("抵押品价格下跌会收紧融资", { limit: 6 });
  const integrationBridge = integration.nodes.find((node) => node.id === "被迫出售反馈机制");
  assert.ok(integrationBridge, "建构候选端点也应收到同一个未证实关联场的桥梁");
  assert.equal(integrationBridge.signals.candidate_association.status, "unverified_association");
  assert.equal(integrationBridge.signals.write_evidence_eligible, false);

  const registered = new Map();
  apply({ tools: { register(tool) { registered.set(tool.name, tool); } } }, { projectRoot: root });
  const retrieve = await registered.get("retrieve").execute({
    query: "流动性危机的传导机制与反例", limit: 8, graph_hops: 2
  }, { agent: { session: { id: "retrieve-session" } } });
  const graphSearch = await registered.get("graph_search").execute({
    query: "流动性危机的传导机制与反例", limit: 8, graph_hops: 2
  }, { agent: { session: { id: "graph-search-session" } } });
  assert.deepEqual(retrieve.cards.map((item) => item.id), graphSearch.nodes.map((item) => item.id));
  assert.deepEqual(retrieve.context_plan.coverage, graphSearch.context_plan.coverage);
  const routedRetrieve = await registered.get("retrieve").execute({
    query: "请判断当前金融脆弱性", limit: 4, graph_hops: 0,
    intent: { focus: ["抵押品价格下跌"], mechanisms: ["抵押折价约束"], contrasts: ["现金缓冲"] }
  }, { agent: { session: { id: "retrieve-routed-session" } } });
  assert.equal(routedRetrieve.retrieval_intent.source, "model_brief");
  assert.ok(routedRetrieve.cards.some((item) => item.id === "抵押品价格下跌会收紧融资"));
  const retrievedDiscovery = await registered.get("retrieve").execute({
    query: "抵押品价格下跌的脆弱性", limit: 16, graph_hops: 0
  }, { agent: { session: { id: "retrieve-discovery-session" } } });
  const toolBridge = retrievedDiscovery.cards.find((item) => item.role === "discovery");
  assert.equal(toolBridge.role, "discovery");
  assert.equal(toolBridge.discovery.status, "unverified_association");
  console.log("PASS unified retrieval uses query-aware graph expansion, role coverage, and one shared engine");
} finally {
  rmSync(root, { recursive: true, force: true });
}
