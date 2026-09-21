import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCases, validateAnswer, validateCasePackage } from "../tools/eval/schema.mjs";
import { materializeFixture } from "../tools/eval/materialize-fixture.mjs";
import { prepareRunPlan } from "../tools/eval/runner.mjs";

const cases = discoverCases();
assert.equal(cases.length, 4);
for (const item of cases) {
  const report = validateCasePackage(item.dir, item.case);
  assert.equal(report.valid, true, `${item.case.case_id}: ${JSON.stringify(report.errors)}`);
  assert.equal(report.checksums.failures.length, 0);
}

const root = mkdtempSync(join(tmpdir(), "nexo-eval-prep-"));
try {
  const prepared = materializeFixture({
    caseId: "FT-004", checkpointId: "T2", variant: "anonymous",
    profileName: "E_thinking_body_v1", outputRoot: join(root, "fixture")
  });
  assert.equal(prepared.scope.read_only, true);
  assert.ok(prepared.scope.allowed_ops.includes("verify_evidence_anchors"));
  assert.ok(prepared.scope.allowed_thinking_models.includes("sequential-belief-update"));
  assert.equal(readdirSync(join(prepared.root, "01-Cards")).length, prepared.scope.fixture.card_ids.length);
  assert.equal(existsSync(join(prepared.root, ".agent", "skills", "nexo-judge", "SKILL.md")), true);
  assert.equal(existsSync(join(prepared.root, "evaluator")), false, "临时根不得出现评分答案");
  assert.equal(existsSync(join(prepared.root, "checksums.sha256")), false, "临时根不得出现 checksum 线索");
  const scopeText = readFileSync(join(prepared.root, ".eval", "run-scope.json"), "utf8");
  assert.equal(scopeText.includes("outcomes"), false);

  const schemaResult = validateAnswer({ type: "object", required: ["case_id"], properties: { case_id: { const: "FT-004" } }, additionalProperties: false }, { case_id: "FT-004" });
  assert.equal(schemaResult.valid, true);
  const plan = prepareRunPlan({ caseId: "FT-001", profile: "D_skill_only", variant: "anonymous", repeat: 1, outputRoot: join(root, "plan") });
  assert.equal(plan.runs.length, 3);
  assert.equal(plan.runs[1].previous_answer_file.endsWith("T0.json"), true);
  console.log("PASS four case packages validate and isolated evaluation plans materialize without answer leakage");
} finally {
  rmSync(root, { recursive: true, force: true });
}
