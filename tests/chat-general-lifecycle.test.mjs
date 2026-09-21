// 回答边界必须隔离未完成的普通问答 Run，下一问题应得到全新状态。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleGeneralRunAtTurnBoundary } from "../packages/nexogenesis-web-host/lib/chat.js";
import { CognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";

const root = mkdtempSync(join(tmpdir(), "nexo-chat-lifecycle-"));
try {
  const runtime = new CognitiveRuntime(root);
  const first = runtime.start({ session_id: "session-a", mode: "general", skill: "nexo-talk", goal: "第一问", scope: { analysis_depth: "iterative" } });
  settleGeneralRunAtTurnBoundary(runtime, "session-a", { phase: "end", kind: "completed" });
  assert.equal(runtime.get(first.run.run_id).run.status, "blocked");
  assert.match(runtime.get(first.run.run_id).workspace.stop_reason, /没有通过基准思考完成门/);

  const second = runtime.ensure({ agent: { session: { id: "session-a" } } }, { mode: "general", skill: "nexo-talk", goal: "第二问" });
  assert.notEqual(second.run.run_id, first.run.run_id, "终态 Run 不得被下一问题复用");
  assert.equal(second.workspace.goal, "第二问");

  runtime.setStatus(second.run.run_id, "completed", "已通过完成门");
  settleGeneralRunAtTurnBoundary(runtime, "session-a", { phase: "end", kind: "completed" });
  assert.equal(runtime.get(second.run.run_id).run.status, "completed", "已正常结束的 Run 不应被宿主改写");
  console.log("PASS unfinished general run is isolated at the turn boundary");
} finally {
  rmSync(root, { recursive: true, force: true });
}
