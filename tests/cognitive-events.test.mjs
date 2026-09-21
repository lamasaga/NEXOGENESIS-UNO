import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCognitiveEvent } from "../packages/nexogenesis-web-host/lib/cognitive-events.js";

const root = mkdtempSync(join(tmpdir(), "nexo-cognitive-event-"));
try {
	mkdirSync(join(root, "01-Cards"), { recursive: true });
	writeFileSync(join(root, "01-Cards", "a.md"), `---\nid: a\ntitle: A\ntype: claim\ndomains: []\nrelations:\n- target: b\n  type: supports\n---\n\nA`, "utf8");
	writeFileSync(join(root, "01-Cards", "b.md"), `---\nid: b\ntitle: B\ntype: claim\ndomains: []\nrelations:\n- target: c\n  type: based-on\n---\n\nB`, "utf8");
	writeFileSync(join(root, "01-Cards", "c.md"), `---\nid: c\ntitle: C\ntype: model\ndomains: []\nrelations: []\n---\n\nC`, "utf8");
	const event = projectCognitiveEvent({
		sessionId: "session-a",
		operator: "user_write_decision",
		phase: "observed",
		projectRoot: root,
		state: {
			run: { run_id: "run-a" },
			workspace: { budget: { max_steps: 24, max_reads: 12, max_writes: 3 } },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "user_write_decision", mode: "runtime-write" },
				observation: { status: "ok", summary: "已原子写入一张卡片。", data: { created: ["新卡"], enriched: ["旧卡"] } }
			}] }
		}
	});
	assert.equal(event.kind, "write.applied");
	assert.deepEqual(event.targets.created, ["新卡"]);
	assert.deepEqual(event.targets.enriched, ["旧卡"]);
	assert.match(event.presentation.title, /完成结构化写入/);

	const walked = projectCognitiveEvent({
		sessionId: "session-a", operator: "graph_walk", args: { card_id: "a" }, phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "graph_walk", mode: "read" },
				observation: {
					status: "ok", summary: "沿论证关系展开 2/2 跳。",
					data: {
						start: "a", hops: 2, reached_hops: 2,
						nodes: [
							{ id: "b", edge: { from: "a", to: "b", type: "supports", readiness: "legacy_candidate", ready: false } },
							{ id: "c", edge: { from: "b", to: "c", type: "based-on" } }
						],
						layers: [
							{ depth: 1, source_ids: ["a"], node_ids: ["b"], edges: [{ from: "a", to: "b", type: "supports", readiness: "legacy_candidate", ready: false }] },
							{ depth: 2, source_ids: ["b"], node_ids: ["c"], edges: [{ from: "b", to: "c", type: "based-on" }], truncated: true }
						]
					}
				}
			}] }
		}
	});
	assert.equal(walked.targets.walk_layers.length, 2);
	assert.equal(walked.targets.walk_layers[0].edge_ids.length, 1, "第一跳必须映射为真实图边");
	assert.equal(walked.targets.walk_layers[0].legacy_edge_ids.length, 1, "待核验旧边必须被单独标记，不能伪装成 ready 关系");
	assert.equal(walked.targets.walk_layers[1].edge_ids.length, 1, "第二跳必须映射为真实图边");
	assert.equal(walked.targets.walk_requested_depth, 2);
	assert.equal(walked.targets.walk_reached_depth, 2);
	assert.equal(walked.targets.walk_layers[1].truncated, true);

	const tension = projectCognitiveEvent({
		sessionId: "session-a", operator: "trace_support_to_tension", args: { card_id: "a" }, phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "trace_support_to_tension", mode: "read" },
				observation: { status: "ok", summary: "沿支持链在第二层发现张力。", data: {
					start: "a", requested_depth: 5, reached_depth: 2, stop_reason: "tension_found",
					support_layers: [
						{ depth: 1, source_ids: ["a"], node_ids: ["b"], edges: [{ from: "a", to: "b", type: "supports" }] },
						{ depth: 2, source_ids: ["b"], node_ids: ["c"], edges: [{ from: "b", to: "c", type: "based-on" }] }
					],
					tension: { found: true, anchor_ids: ["c"], opponent_ids: ["a"], conflict_card_ids: [], node_ids: ["a"], edges: [{ from: "a", to: "b", type: "supports" }] }
				} }
			}] }
		}
	});
	assert.equal(tension.targets.walk_layers.length, 2);
	assert.equal(tension.targets.walk_requested_depth, 5);
	assert.deepEqual(tension.targets.insight_anchor_ids, ["c"]);
	assert.deepEqual(tension.targets.insight_tension_node_ids, ["a"]);
	assert.equal(tension.targets.insight_tension_edge_ids.length, 1);
	assert.equal(tension.presentation.tone, "conflict");

	const batchRead = projectCognitiveEvent({
		sessionId: "session-a", operator: "read_cards", phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "read_cards", mode: "read" },
				observation: { status: "ok", summary: "批量精读 2/2 张卡片。", data: { results: [{ card_id: "a" }, { card_id: "b" }] } }
			}] }
		}
	});
	assert.deepEqual(batchRead.targets.node_ids, ["a", "b"], "批量精读的每个实际结果都应成为可视化目标");

	const evidenceSet = projectCognitiveEvent({
		sessionId: "session-a", operator: "inspect_evidence_set", phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "inspect_evidence_set", mode: "read" },
				observation: { status: "ok", summary: "证据角色已审视。", data: {
					claims: [{ claim_id: "claim-1" }], all_deterministic_checks_passed: true,
					results: [
						{ card_id: "a", role: "support", exists: true, usable: true },
						{ card_id: "b", role: "counter", exists: true, usable: true },
						{ card_id: "c", role: "boundary", exists: true, usable: true }
					]
				} }
			}] }
		}
	});
	assert.equal(evidenceSet.presentation.title, "审视证据角色与覆盖");
	assert.deepEqual(evidenceSet.targets.evidence_role_node_ids.support, ["a"]);
	assert.deepEqual(evidenceSet.targets.evidence_role_node_ids.counter, ["b"]);
	assert.deepEqual(evidenceSet.targets.evidence_role_node_ids.boundary, ["c"]);
	assert.equal(evidenceSet.targets.evidence_claim_count, 1);

	const verified = projectCognitiveEvent({
		sessionId: "session-a", operator: "verify_evidence_anchors", phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "verify_evidence_anchors", mode: "read" },
				observation: { status: "partial", summary: "证据锚点核验未全部通过。", data: {
					all_deterministic_checks_passed: false,
					results: [
						{ card_id: "a", role: "support", exists: true, usable: true },
						{ card_id: "b", role: "counter", exists: true, usable: false }
					]
				} }
			}] }
		}
	});
	assert.equal(verified.presentation.title, "核验证据锚点");
	assert.deepEqual(verified.targets.evidence_valid_node_ids, ["a"]);
	assert.deepEqual(verified.targets.evidence_invalid_node_ids, ["b"]);

	const sufficient = projectCognitiveEvent({
		sessionId: "session-a", operator: "inspect_cognitive_sufficiency", phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "inspect_cognitive_sufficiency", mode: "read" },
				observation: { status: "ok", summary: "已经达到完成门。", data: {
					ready: true, missing: [], evidence_anchors: [{ anchor: "a#机制", role: "support", claim_id: "claim-1" }]
				} }
			}] }
		}
	});
	assert.equal(sufficient.presentation.title, "判断证据是否足够");
	assert.equal(sufficient.targets.sufficiency_ready, true);
	assert.deepEqual(sufficient.targets.sufficiency_node_ids, ["a"]);

	const simulatedDirection = projectCognitiveEvent({
		sessionId: "session-a", operator: "simulate_relation_patch", phase: "observed", projectRoot: root,
		args: { source_id: "a", target_id: "b" },
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{ action: { operator: "simulate_relation_patch", mode: "read" },
				observation: { status: "ok", summary: "预演方向调整", data: {
					nodes: [{ id: "a" }, { id: "b" }],
					adjudication: { decision: "change", proposed_relation: { from: "b", to: "a", type: "supports" } }
				} }
			}] }
		}
	});
	assert.equal(simulatedDirection.targets.relation_source_id, "b");
	assert.equal(simulatedDirection.targets.relation_target_id, "a");
	assert.equal(simulatedDirection.targets.relation_type, "supports");

	const corrected = projectCognitiveEvent({
		sessionId: "session-a", operator: "graph_walk", args: { card_id: "领域甲" }, phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [
				{ action: { operator: "graph_walk", mode: "read" }, observation: { status: "partial", summary: "旧的误用记录。", data: { misuse: "old" } } },
				{ action: { operator: "graph_members", mode: "read" }, observation: {
					status: "ok", summary: "已自动改用成员观察。", evidence: [{ card_id: "a" }],
					data: { domain_id: "领域甲", nodes: [{ id: "a" }], auto_corrected_from: { operator: "graph_walk", reason_code: "domain_start_requires_members" } }
				} }
			] }
		}
	});
	assert.equal(corrected.operator.name, "graph_members", "自动纠正后必须投影真实执行的 Operator");
	assert.deepEqual(corrected.targets.node_ids, ["a", "领域甲"]);

	const trusted = projectCognitiveEvent({
		sessionId: "session-a", operator: "propose_semantic_patch", phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "propose_semantic_patch", mode: "proposal" },
				observation: { status: "ok", reason_code: "committed", summary: "已直接写入。", data: { created: ["新建卡"], enriched: ["丰富卡"] } }
			}] }
		}
	});
	assert.equal(trusted.kind, "write.applied", "trusted 提交不得投影为待确认提案");
	assert.deepEqual(trusted.targets.created, ["新建卡"]);
	assert.deepEqual(trusted.targets.enriched, ["丰富卡"]);

	const trustedRelation = projectCognitiveEvent({
		sessionId: "session-a", operator: "propose_relation_patch",
		args: { source_id: "a", target_id: "b", relation_type: "supports", action: "upsert" },
		phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "propose_relation_patch", mode: "write" },
				observation: { status: "ok", reason_code: "committed", summary: "关系已写入。", data: { enriched: ["a"] } }
			}] }
		}
	});
	assert.deepEqual(trustedRelation.targets.node_ids, ["a", "b"]);
	assert.equal(trustedRelation.targets.relation_source_id, "a");
	assert.equal(trustedRelation.targets.relation_target_id, "b");
	assert.equal(trustedRelation.targets.relation_decision, "upsert");
	assert.equal(trustedRelation.targets.edge_ids.length, 1, "已提交关系必须映射到当前真实图边");

	const integration = projectCognitiveEvent({
		sessionId: "session-a", operator: "record_card_integration_decision",
		args: { card_id: "新建卡", candidate_ids: ["a", "b"] }, phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "record_card_integration_decision", mode: "runtime-write" },
				observation: { status: "ok", summary: "已记录关系证据缺口。", data: { card_id: "新建卡", candidate_ids: ["a", "b"] } }
			}] }
		}
	});
	assert.equal(integration.presentation.title, "确认新卡结构边界");
	assert.deepEqual(integration.targets.node_ids, ["新建卡", "a", "b"]);

	const completed = projectCognitiveEvent({
		sessionId: "session-a", operator: "finish_cognitive_run", phase: "observed", projectRoot: root,
		state: {
			run: { run_id: "run-a" }, workspace: { budget: {} },
			episode: { episode_id: "episode-a", steps: [{
				action: { operator: "finish_cognitive_run", mode: "runtime-write" },
				observation: { status: "ok", summary: "已形成有依据的结论。", data: { status: "completed" } }
			}] }
		}
	});
	assert.equal(completed.kind, "run.completed", "正常收束必须有可恢复的完成事件");
	console.log("PASS cognitive events: Harness 回执与 GraphOps 自动纠正投影为真实可视化事件");
} finally {
	rmSync(root, { recursive: true, force: true });
}
