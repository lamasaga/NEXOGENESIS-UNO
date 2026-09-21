import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";
import { registerCognitionTools } from "../packages/nexogenesis-tools/lib/cognition/tools.js";
import { commitCard, loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { loadGraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { verifyEvidenceAnchors, inspectEvidenceSet } from "../packages/nexogenesis-tools/lib/cognition/evidence-inspection.js";
import { buildWorkingMemory, workingMemoryReadiness } from "../packages/nexogenesis-tools/lib/cognition/working-memory.js";
import { describeReading } from "../packages/nexogenesis-tools/lib/cognition/reading-coverage.js";

const card = (id, body, sources = []) => ({ id, title: id, type: "claim", maturity: "growing", lifecycle: "active", domains: [], origin: "document", sources, relations: [], body });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexo-working-memory-"));
  const tools = new Map();
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); } } };
  apply(ctx, { projectRoot: root }); registerCognitionTools(ctx, root);
  const exec = { agent: { session: { id: "memory-test" } } };
  return { root, tools, exec, runtime: getCognitiveRuntime(root), call: (name, args = {}) => tools.get(name).execute(args, exec) };
}

test("批量阅读保留非标准标题，预算裁剪不能核验未读全文或未读 unit", async () => {
  const f = fixture();
  try {
    const short = "## 诠释\n\n观察不等于因果。\n\n## 模式描述\n\n周期约 8–10 年。\n\n## 反例与失效条件\n\n样本以外尚未验证。";
    const long = "## 核心思想\n\n<!-- unit: core-thesis -->\n有限的主张。\n\n## 模式描述\n\n" + "历史资料。".repeat(500) + "\n\n## 边界\n\n<!-- unit: boundary-limit -->\n这是未交付的边界。";
    commitCard(f.root, card("short", short)); commitCard(f.root, card("long", long));
    const result = await f.call("read_cards", { ids: ["short", "long"], max_characters: 1000 });
    assert.match(result.cards[0].body, /模式描述/);
    assert.equal(result.cards[0].reading.coverage, "full");
    assert.equal(result.cards[1].reading.coverage, "excerpt");
    assert.equal(result.cards[1].body_total, loadCards(f.root).get("long").body.length);
    assert.ok(result.total_characters <= 1000);
    const repeated = describeReading("repeat", "## 主张\n\n相同文字。\n\n## 边界\n\n<!-- unit: boundary-limit -->\n相同文字。", "## 主张\n\n相同文字。");
    assert.deepEqual(repeated.unit_addresses, [], "相同句子不能冒充未交付的 unit 标记");
    const state = f.runtime.current("memory-test");
    const verified = verifyEvidenceAnchors(f.root, state, [
      { anchor: "short", role: "support", claim_id: "c" },
      { anchor: "long", role: "support", claim_id: "c" },
      { anchor: "long#core-thesis", role: "support", claim_id: "c" },
      { anchor: "long#boundary-limit", role: "boundary", claim_id: "c" }
    ]);
    assert.deepEqual(verified.results.map((item) => item.usable), [true, false, true, false]);
    await f.call("read_card_unit", { address: "long#boundary-limit" });
    assert.equal(verifyEvidenceAnchors(f.root, f.runtime.current("memory-test"), [{ anchor: "long#boundary-limit", role: "boundary", claim_id: "c" }]).all_deterministic_checks_passed, true);
    const memory = buildWorkingMemory(f.runtime.current("memory-test"));
    assert.ok(memory.readings.find((item) => item.card_id === "long").excerpts.some((item) => item.text.includes("未交付的边界")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("同书切片归并出处，不声称已证明独立；比较从正文定位时间尺度", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "05-Buffer", "meaning-unit"), { recursive: true });
    for (const id of ["a", "b"]) {
      writeFileSync(join(f.root, "05-Buffer", "meaning-unit", `${id}.md`), `---\nsource: 03-Archive/same-book.md\n---\n片段`, "utf8");
      commitCard(f.root, card(id, "## 核心思想\n\n周期长度为 8–10 年，传导存在时滞。", [`05-Buffer/meaning-unit/${id}.md`]));
    }
    const state = { episode: { steps: ["a", "b"].map((id) => ({ action: { operator: "read_card" }, observation: { status: "ok", data: { id, reading: { coverage: "full" } }, evidence: [{ card_id: id }] } })) } };
    const result = inspectEvidenceSet(f.root, state, ["a", "b"].map((id) => ({ anchor: id, role: "support", claim_id: "c" })));
    assert.equal(result.claims[0].source_family_count, 1);
    assert.equal(result.claims[0].independent_source_count, null);
    const compared = loadGraphOps(f.root).compare(["a", "b"], { dimensions: ["time_horizon", "buffer"] });
    assert.match(compared.semantic_matrix.a.time_horizon[0].excerpt, /8–10/);
    assert.equal(compared.semantic_matrix.a.time_horizon[0].match_basis, "body_candidate_requires_review");
    assert.deepEqual(compared.missing_dimensions.a, ["buffer"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("普通 deep 的真实工具闭环提供最终工作记忆，空探索可结束且不成为洞见", async () => {
  const f = fixture();
  try {
    for (const id of ["a", "b", "c", "d"]) commitCard(f.root, card(id, `## 核心思想\n\n${id}只说明历史样本。\n\n## 失效边界\n\n无法外推为当前普遍规律。`));
    const state = f.runtime.start({ session_id: "memory-test", mode: "general", skill: "nexo-talk", goal: "研究历史机制", scope: { analysis_depth: "iterative", complexity_level: "deep" } });
    f.runtime.selectThinkingModel(state.run.run_id, { id: "mechanism-test", version: "1", required_capabilities: [], observation_obligations: [], output_obligations: ["evidence_anchors"], stop_conditions: ["形成有边界的解释"] });
    await f.call("read_cards", { ids: ["a", "b", "c"] }); await f.call("read_card", { id: "d" });
    assert.ok(workingMemoryReadiness(f.runtime.current("memory-test")).missing.includes("exploration_opportunity"), "普通 deep 也检查探索机会，不依赖专用 TM");
    const exploration = await f.call("trace_support_to_tension", { card_id: "a", max_depth: 2 });
    assert.ok(exploration.observation.step > 0, "模型必须直接看见 operation_step");
    assert.equal(exploration.tension.found, false);
    const items = [
      { anchor: "a", role: "support", claim_id: "c1" }, { anchor: "b", role: "counter", claim_id: "c1" }, { anchor: "c", role: "boundary", claim_id: "c1" }
    ];
    await f.call("inspect_evidence_set", { items }); await f.call("verify_evidence_anchors", { items });
    const incomplete = await f.call("inspect_cognitive_sufficiency");
    assert.ok(incomplete.data.missing.includes("focused_claims"));
    assert.ok(incomplete.data.missing.includes("exploration_review"));
    await f.call("update_cognitive_workspace", { patch: {
      hypotheses: [{ id: "c1", statement: "本轮只能提出有条件的机制解释", status: "inference", scope: "历史合成样本；没有当前实证", uncertainty: "外推有效性未知", anchors: ["a", "b", "c"] }],
      extension: { insight_reviews: [{ operation_step: exploration.observation.step, outcome: "empty", finding: "支持链耗尽，没有发现真实反对边", next_check: "缺少可定位的独立反方材料" }] }
    } });
    const sufficiency = await f.call("inspect_cognitive_sufficiency");
    assert.equal(sufficiency.data.ready, true, sufficiency.data.missing.join(","));
    const finish = await f.call("finish_cognitive_run", { status: "completed", stop_reason: "已形成有边界的解释", changed: ["明确解释范围"], unchanged: ["没有新的实证结论"], pending: ["实际样本验证"], evidence_anchors: items });
    assert.equal(finish.run.status, "completed");
    assert.equal(finish.working_memory.claims[0].status, "inference");
    assert.equal(finish.working_memory.explorations[0].review.outcome, "empty");
    assert.match(JSON.stringify(finish.working_memory), /没有当前实证/);
    const other = f.runtime.start({ session_id: "other", mode: "general", goal: "另一问题" });
    assert.equal(buildWorkingMemory(other).readings.length, 0, "工作记忆不能跨任务污染");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("探索候选不能凭文字声明升级；类比需要补读、对应结构和挑战记录", () => {
  const reading = describeReading("a", "正文", "正文");
  const state = { run: { run_id: "test" }, workspace: { goal: "检验", hypotheses: [{ id: "c", statement: "待检验", status: "unresolved", scope: "未知", uncertainty: "缺反例", anchors: [] }], extension: { insight_reviews: [{ operation_step: 2, outcome: "alternative", finding: "发现竞争解释", anchors: ["b"], next_check: "还没检查" }] } }, episode: { steps: [
    { step: 1, action: { operator: "read_card" }, observation: { status: "ok", data: { id: "a", reading } } },
    { step: 2, action: { operator: "graph_analogize" }, observation: { status: "ok", data: { start: "a", nodes: [{ id: "b" }] } } }
  ] } };
  let result = workingMemoryReadiness(state);
  assert.ok(result.missing.includes("exploration_candidate_read"));
  assert.ok(result.missing.includes("analogy_mapping_and_break_point"));
  assert.ok(result.missing.includes("exploration_challenge_observation"));
  state.episode.steps.push({ step: 3, action: { operator: "read_card" }, observation: { status: "ok", data: { id: "b", reading } } });
  state.episode.steps.push({ step: 4, action: { operator: "inspect_conflicts" }, observation: { status: "ok", data: {} } });
  Object.assign(state.workspace.extension.insight_reviews[0], { claim_id: "c", mapping: "正反馈对应", break_point: "参与者激励不同", challenge_step: 4 });
  result = workingMemoryReadiness(state);
  assert.equal(result.ready, true, result.missing.join(","));
  state.workspace.extension.insight_reviews[0].outcome = "empty";
  assert.ok(workingMemoryReadiness(state).missing.includes("exploration_outcome"));
});

test("工作窗口有限且报告省略，旧角色不混入最终证据", () => {
  const state = { run: { run_id: "size-test" }, workspace: { goal: "有界记忆", hypotheses: [{ id: "c", statement: "重要边界", status: "unresolved", scope: "样本内", uncertainty: "外推未知" }], extension: {} }, episode: { steps: [] } };
  for (let i = 0; i < 30; i++) state.episode.steps.push({ step: i + 1, action: { operator: "read_card" }, observation: { status: "ok", data: { id: String(i), reading: { coverage: "full", excerpts: [{ section: "正文", text: "有据可查".repeat(150) }] } } } });
  state.episode.steps.push({ step: 31, action: { operator: "verify_evidence_anchors" }, observation: { status: "ok", data: { results: [{ anchor: "0", claim_id: "c", role: "support", usable: true }] } } });
  state.episode.steps.push({ step: 32, action: { operator: "verify_evidence_anchors" }, observation: { status: "ok", data: { results: [{ anchor: "0", claim_id: "c", role: "boundary", usable: true }] } } });
  const memory = buildWorkingMemory(state, 5000);
  assert.ok(JSON.stringify(memory).length <= 5000);
  assert.ok(memory.omitted_readings > 0);
  assert.deepEqual(memory.claims[0].evidence.map((item) => item.role), ["boundary"]);
  assert.equal(memory.readings[0].card_id, "0", "优先保留核心证据而非最近流水");
});
