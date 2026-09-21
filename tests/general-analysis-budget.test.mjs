// 普通复杂问答由语义档位分配预算，模型请求只能在该档范围内调整。
import assert from "node:assert/strict";
import { allocateGeneralAnalysisBudget } from "../packages/nexogenesis-tools/lib/cognition/general-analysis.js";

const allocate = (complexity_level, budget) => allocateGeneralAnalysisBudget(
  "general", { analysis_depth: "iterative", complexity_level }, budget
);

assert.deepEqual(allocate(undefined, undefined).budget, { max_steps: 24, max_reads: 16, max_writes: 0 });
assert.equal(allocate(undefined, undefined).scope.complexity_level, "standard", "缺省复杂度必须稳定回落到 standard");
assert.deepEqual(allocate("light", { max_steps: 1, max_reads: 99, max_writes: 9 }).budget, { max_steps: 8, max_reads: 8, max_writes: 0 });
assert.deepEqual(allocate("standard", { max_steps: 32, max_reads: 20 }).budget, { max_steps: 32, max_reads: 20, max_writes: 0 });
assert.deepEqual(allocate("deep", undefined).budget, { max_steps: 48, max_reads: 24, max_writes: 0 });
assert.deepEqual(allocate("deep", { max_steps: 40, max_reads: 20 }).budget, { max_steps: 40, max_reads: 20, max_writes: 0 });
assert.deepEqual(allocate("deep", { max_steps: 60, max_reads: 32 }).budget, { max_steps: 60, max_reads: 32, max_writes: 0 });
assert.deepEqual(allocate("deep", { max_steps: 999, max_reads: 999 }).budget, { max_steps: 60, max_reads: 32, max_writes: 0 });
assert.equal(allocateGeneralAnalysisBudget("construct", {}, { max_steps: 7 }).applied, false, "普通问答预算策略不得改写其他任务模式");
console.log("PASS complexity-aware analysis budgets are defaulted and clamped by runtime");
