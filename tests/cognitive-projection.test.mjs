import assert from "node:assert/strict";
import { projectRunStatus } from "../packages/nexogenesis-web-host/lib/cognition.js";

const state = {
	run: { run_id: "run-1", mode: "construct", status: "running", step_count: 3, thinking_model: { id: "bridge-analysis" } },
	workspace: {
		goal: "梳理两个领域的关系", evidence: [{ card_id: "甲" }], counter_evidence: [],
		open_questions: ["桥梁是否只是词汇共现"], candidate_actions: [], extension: {}
	},
	episode: { steps: [{ observation: { status: "rejected", summary: "关系签名不合法", next_actions: [{ description: "改用专用关系操作" }] } }] }
};
const projected = projectRunStatus(state);
assert.equal(projected.attention, "正在关注：梳理两个领域的关系");
assert.equal(projected.finding, "关系签名不合法");
assert.equal(projected.why_not_write, "关系签名不合法");
assert.equal(projected.next, "改用专用关系操作");
assert.deepEqual(Object.keys(projected).includes("filename"), false);
console.log("PASS cognitive projection: 自然语言四项状态");
