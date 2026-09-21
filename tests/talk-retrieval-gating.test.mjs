// 日常对话的提示契约：选择 nexo-talk 不等于强制检索。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const persona = readFileSync(new URL("presets/nexogenesis/agent.cordis.yml", root), "utf8");
const talk = readFileSync(new URL(".agent/skills/nexo-talk/SKILL.md", root), "utf8");
const analysis = readFileSync(new URL(".agent/reference/thinking-body.md", root), "utf8");
const tools = readFileSync(new URL("packages/nexogenesis-tools/lib/index.js", root), "utf8");

for (const level of ["none", "optional", "required"]) {
	assert.match(persona, new RegExp(`\\b${level}\\b`), `persona 必须定义 ${level} 证据需求`);
	assert.match(talk, new RegExp(`\\b${level}\\b`), `nexo-talk 必须定义 ${level} 证据需求`);
}
for (const route of ["direct", "grounded_quick", "analytical"]) {
	assert.match(persona, new RegExp(`\\b${route}\\b`), `persona 必须定义 ${route} 路径`);
	assert.match(talk, new RegExp(`\\b${route}\\b`), `nexo-talk 必须定义 ${route} 路径`);
}

assert.match(talk, /你是谁？顺便介绍自己思考问题的几种方法.+evidence_need=none/s, "身份与方法的混合问题必须直接回答");
assert.match(talk, /根据已有材料，你会怎样分析通胀？.+evidence_need=required/s, "明确要求既有依据时必须检索");
assert.match(persona, /没有可说明的证据收益时，选择不检索/);
assert.match(tools, /问候、身份与能力介绍、思考方法、协作方式/);
assert.match(persona, /focus、mechanisms、context、contrasts、exclusions/,
	"复杂问题的常驻提示必须要求传入结构化检索意图");
assert.match(tools, /raw_tail_candidate_total/,
	"检索结果必须可观察原问题尾部是否真正进入候选池");
assert.match(talk, /reference\/thinking-body\.md/, "分析路由必须发现共享契约");
assert.match(analysis, /两跳尝试并读新到达卡/, "共享分析保留结构义务");
assert.match(persona, /至少执行一次 graph_walk\(hops=2\)/,
	"常驻 persona 必须保留复杂问题的两跳底线");
assert.match(tools, /structural_frontier.+suggested_args.+graph_walk/s,
	"搜索结果必须把可执行的结构前沿暴露给模型");
assert.match(talk, /一次 retrieve \+ 一次 read_cards/,
	"快速有据回答必须限制为一次检索和一次批量精读");
assert.match(tools, /name: "read_cards"/);
assert.match(tools, /ids\.length < 1 \|\| ids\.length > 3/,
	"批量精读必须确定性限制为 1–3 张卡片");

assert.doesNotMatch(persona, /知识型回答必须以 retrieve 工具/,
	"persona 不得再把所有知识型回答一律送入检索");
assert.doesNotMatch(talk, /# Grounding（按顺序必读）/,
	"Grounding 不得在 evidence_need=none 时强制读取");
assert.doesNotMatch(tools, /回答知识性问题时先调用本工具/,
	"工具描述不得绕过检索门控");

console.log("PASS daily conversation retrieval gating prompt contract");
