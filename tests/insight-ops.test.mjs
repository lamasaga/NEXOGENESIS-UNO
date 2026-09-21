// 特殊 OPS 只能沿真实 ready 关系探索；假设反转只返回待核验候选。
import assert from "node:assert/strict";
import { GraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";

const card = (title, type, body, relations = []) => ({
  meta: {
    title, type, domains: ["系统风险"], maturity: "growing", lifecycle: "active",
    origin: "document", sources: ["测试来源"], relations
  },
  body
});

const cards = new Map([
  ["核心判断", card("连接度通常提升风险分担", "claim", "## 作用机制\n\n市场连接度提升风险分担，但依赖冲击彼此独立。")],
  ["一级支持", card("分散持仓吸收局部损失", "claim", "## 作用机制\n\n分散持仓让局部损失由更多主体吸收。", [
    { target: "核心判断", type: "supports", note: "分散持仓是风险分担得以发生的直接机制" }
  ])],
  ["二级支持", card("资产相关性较低", "claim", "## 适用条件\n\n资产相关性较低时，分散机制才不会同步失效。", [
    { target: "一级支持", type: "supports", note: "低相关性为分散持仓提供必要条件" },
    { target: "反方判断", type: "conflicts-with", note: "低相关性前提与共同冲击下的同步传染相冲突" }
  ])],
  ["反方判断", card("共同冲击使连接度放大冲击传播", "claim", "## 作用机制\n\n共同冲击下，市场连接度放大冲击传播并触发同步去杠杆。")],
  ["反转候选", card("高度连接网络中的级联失效", "phenomenon", "## 现象描述\n\n市场连接度放大冲击传播，风险分担会转化为风险传染。")]
]);

const adjOut = new Map();
const adjIn = new Map();
for (const [from, value] of cards) for (const relation of value.meta.relations) {
  const edge = { from, to: relation.target, kind: "relation", relation_type: relation.type, note: relation.note };
  adjOut.set(from, [...(adjOut.get(from) ?? []), edge]);
  adjIn.set(relation.target, [...(adjIn.get(relation.target) ?? []), edge]);
}
const ops = new GraphOps(cards, new Map([["系统风险", [...cards.keys()]]]), adjOut, adjIn, new Map(), process.cwd(), []);

const tension = ops.traceSupportToTension("核心判断", { maxDepth: 5, branchWidth: 2, limit: 12 });
assert.equal(tension.tension.found, true);
assert.equal(tension.tension.depth, 2);
assert.equal(tension.stop_reason, "tension_found");
assert.deepEqual(tension.support_layers.map((layer) => layer.node_ids), [["一级支持"], ["二级支持"]]);
assert.equal(tension.tension.opponent_ids[0], "反方判断");
assert.ok(tension.tension.edges.every((edge) => edge.ready), "张力路径不得包含待核验旧边");
assert.equal(tension.write_evidence_eligible, false);

const shallow = ops.traceSupportToTension("核心判断", { maxDepth: 1 });
assert.equal(shallow.tension.found, false);
assert.equal(shallow.stop_reason, "depth_limit");

const inversion = ops.probeAssumptionInversion("核心判断", {
  assumption: "市场连接度提升风险分担",
  invertedAssumption: "市场连接度放大冲击传播",
  limit: 6
});
assert.equal(inversion.assumption_located, true);
assert.ok(inversion.candidate_ids.includes("反转候选") || inversion.candidate_ids.includes("反方判断"));
assert.equal(inversion.hypothesis_status, "unverified_probe");
assert.equal(inversion.write_evidence_eligible, false);
assert.ok(inversion.nodes.every((node) => node.hypothesis_status === "unverified_inversion_candidate"));

const invalid = ops.probeAssumptionInversion("核心判断", {
  assumption: "连接度提升风险分担", invertedAssumption: "连接度提升风险分担"
});
assert.equal(invalid.misuse_code, "assumption_inversion_requires_distinct_statements");

console.log("PASS special insight OPS stay bounded, evidence-aware, and non-writing");
