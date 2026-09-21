import assert from "node:assert/strict";
import { compactPipelineTranscript } from "../packages/nexogenesis-web-host/lib/projects.js";

const messages = Array.from({ length: 5 }, (_, index) => [
  { role: "user", content: "/compile", ts: `2026-08-2${index}T10:00:00.000Z` },
  { role: "assistant", content: `编译已完成：写入 ${index + 1} 个 Buffer。`, ts: `2026-08-2${index}T10:01:00.000Z` },
]).flat();
const compacted = compactPipelineTranscript({ task_kind: "compile" }, messages);
assert.equal(compacted.changed, true);
assert.equal(compacted.messages.filter((message) => message.content === "/compile").length, 3);
assert.equal(compacted.metaPatch.pipeline_history.archived_runs, 2);
assert.equal(compacted.metaPatch.pipeline_history.buffers, 3);
const again = compactPipelineTranscript({ task_kind: "compile", ...compacted.metaPatch }, messages);
assert.equal(again.metaPatch, undefined);
assert.equal(again.messages.filter((message) => message.content === "/compile").length, 3);
console.log("PASS fixed task transcript keeps three recent runs and retains an achievement ledger");
