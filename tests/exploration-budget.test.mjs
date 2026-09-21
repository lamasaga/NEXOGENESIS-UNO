import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { loadGraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { CognitiveRuntime, getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { registerGraphOpsTools } from "../packages/nexogenesis-tools/lib/index.js";
import { explorationBudget } from "../packages/nexogenesis-tools/lib/cognition/exploration-budget.js";
import { buildWorkingMemory, workingMemoryReadiness } from "../packages/nexogenesis-tools/lib/cognition/working-memory.js";

const relation = (target, note = "抵押品约束机制为流动性反馈提供条件性支持") => ({ target, type: "supports", note });
const card = (id, relations = [], body = "普通背景资料") => ({ id, title: id, type: "claim", maturity: "growing", lifecycle: "active", origin: "document", domains: [], sources: ["fixture-source"], relations, body: `## 核心思想\n\n${body}` });

test("缺口驱动多跳优先桥梁，保留未展开分支，并可从桥梁继续超过累计三跳", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexo-gap-walk-"));
  try {
    const noise = Array.from({ length: 12 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    noise.forEach((id) => commitCard(root, card(id)));
    commitCard(root, card("start", [...noise.map((id) => relation(id)), relation("z-bridge") ]));
    commitCard(root, card("z-bridge", [relation("mechanism")], "流动性抵押约束"));
    commitCard(root, card("mechanism", [relation("boundary")], "流动性抵押约束的中介机制"));
    commitCard(root, card("boundary", [relation("outside")], "流动性抵押约束的边界"));
    commitCard(root, card("outside", [], "尚待检验的新解释"));
    const ops = loadGraphOps(root, new Set());
    const broad = ops.walk("start", { direction: "out", hops: 3, limit: 6 });
    assert.equal(broad.nodes.some((node) => node.id === "boundary"), false);
    const directed = ops.walk("start", { direction: "out", hops: 3, limit: 6, focusQuery: "流动性抵押约束" });
    assert.equal(directed.reached_hops, 3);
    assert.ok(directed.nodes.some((node) => node.id === "boundary" && node.path.length === 4));
    assert.ok(directed.deferred_frontier.length > 0);
    assert.ok(directed.deferred_frontier.every((node) => !directed.nodes.some((shown) => shown.id === node.card_id)));
    assert.ok(directed.nodes.length <= 6);
    ops.read("boundary");
    const continued = ops.walk("boundary", { direction: "out", hops: 2, limit: 6, focusQuery: "新解释" });
    assert.ok(continued.nodes.some((node) => node.id === "outside"));
    const tools = new Map();
    registerGraphOpsTools({ tools: { register(tool) { tools.set(tool.name, tool); } } }, root, () => new Set());
    const runtime = getCognitiveRuntime(root);
    const run = runtime.start({ session_id: "auto-gap", mode: "general", goal: "宽泛问题", scope: { analysis_depth: "iterative", complexity_level: "deep" } });
    runtime.updateWorkspace(run.run.run_id, { open_questions: ["流动性抵押约束"] });
    const actual = await tools.get("graph_walk").execute({ card_id: "start", hops: 3, limit: 6, direction: "out" }, { agent: { session: { id: "auto-gap" } } });
    assert.equal(actual.focus_query, "流动性抵押约束");
    assert.deepEqual(actual.observation.data.deferred_frontier, actual.deferred_frontier, "分支信息必须真实进入 Episode 与模型工作记忆");
    assert.equal(actual.observation.data.nodes.find((node) => node.id === "z-bridge").discovery_score, actual.nodes.find((node) => node.id === "z-bridge").discovery_score);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deep 在同一硬预算内为阅读与验证留资源，轻量流程不受影响", () => {
  const root = mkdtempSync(join(tmpdir(), "nexo-exploration-reserve-"));
  try {
    const runtime = new CognitiveRuntime(root);
    const state = runtime.start({ session_id: "deep", mode: "general", goal: "缺资料", scope: { analysis_depth: "iterative", complexity_level: "deep" }, budget: { max_steps: 40, max_reads: 20 } });
    for (let i = 0; i < 18; i++) runtime.record(state.run.run_id, { action: { operator: "read_card", mode: "read" }, observation: { status: "ok", data: { id: `c${i}`, reading: { coverage: "full" } } } });
    const decision = runtime.canOperate(state.run.run_id, { operator: "graph_walk", mode: "read" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason_code, "exploration_read_reserve");
    assert.equal(decision.governance.exploration.remaining_reads, 2);
    assert.equal(runtime.canOperate(state.run.run_id, { operator: "read_cards", mode: "read" }).allowed, true);
    assert.equal(runtime.canOperate(state.run.run_id, { operator: "inspect_conflicts", mode: "read" }).allowed, true);
    assert.equal(runtime.canOperate(state.run.run_id, { operator: "inspect_cognitive_sufficiency", mode: "read" }).allowed, true);
    assert.equal(runtime.get(state.run.run_id).workspace.budget.max_reads, 20, "不偷偷抬高用户预算");
    const light = runtime.start({ session_id: "light", mode: "general", goal: "简单问题", scope: { analysis_depth: "iterative", complexity_level: "light" } });
    assert.equal(runtime.governance(light.run.run_id).exploration.applicable, false);
    assert.equal(runtime.canOperate(light.run.run_id, { operator: "graph_walk", mode: "read" }).allowed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("工作记忆建议先读深层候选再继续，重复发现促使换向，精读不是零增益", () => {
  const state = { run: { mode: "general", run_id: "fixture" }, workspace: { goal: "缺少反方", scope: { analysis_depth: "iterative", complexity_level: "deep" }, budget: { max_reads: 24, max_steps: 48 }, open_questions: ["在什么条件下失效？"], extension: {} }, episode: { steps: [] } };
  const append = (operator, data) => state.episode.steps.push({ step: state.episode.steps.length + 1, action: { operator, mode: "read" }, observation: { status: "ok", data } });
  const walk = { start: "a", plane: "argument", layers: [{ depth: 2 }], nodes: [{ id: "b", hop: 2, path: ["a", "m", "b"], edge: { ready: true } }] };
  append("graph_walk", walk);
  assert.equal(explorationBudget(state).frontier[0].next_action, "read_card");
  append("graph_walk", walk); append("graph_walk", walk);
  assert.equal(explorationBudget(state).phase, "change_branch_or_read");
  append("read_card", { id: "b", reading: { coverage: "full" } });
  const budget = explorationBudget(state);
  assert.equal(budget.phase, "gap_directed_exploration");
  assert.equal(budget.frontier[0].next_action, "graph_walk");
  assert.equal(buildWorkingMemory(state).exploration_budget.frontier[0].suggested_args.card_id, "b");
});

test("工作记忆只显示最近四次特殊探索，不再把显示上限误当运行上限", () => {
  const state = { run: { mode: "general", run_id: "reviews" }, workspace: { goal: "多条支线", hypotheses: [{ id: "c", statement: "尚未找到证据", status: "unresolved", scope: "本轮范围", uncertainty: "缺反方" }], extension: { insight_reviews: [] } }, episode: { steps: [] } };
  for (let i = 1; i <= 5; i++) {
    state.episode.steps.push({ step: i, action: { operator: "trace_support_to_tension", mode: "read" }, observation: { status: "ok", data: { start: `c${i}`, tension: { opponent_ids: [] }, stop_reason: "support_exhausted" } } });
    state.workspace.extension.insight_reviews.push({ operation_step: i, outcome: "empty", finding: "未找到反方", next_check: "需补充新来源" });
  }
  assert.equal(buildWorkingMemory(state).omitted_explorations, 1);
  assert.equal(workingMemoryReadiness(state).ready, true);
  state.workspace.extension.insight_reviews.shift();
  assert.ok(workingMemoryReadiness(state).missing.includes("exploration_review"), "窗口之外的探索仍要核验");
});
