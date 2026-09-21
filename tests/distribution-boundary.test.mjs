import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const contract = JSON.parse(await readFile(new URL("deploy/portable-snapshot.json", root), "utf8"));
const preset = await readFile(new URL("presets/nexogenesis/agent.cordis.yml", root), "utf8");
const patch = await readFile(new URL("patch/cordis.patch.yml", root), "utf8");

test("便携发行契约保留知识事实并排除运行状态", () => {
  assert.deepEqual(contract.knowledge_roots, [
    "00-Inbox",
    "01-Cards",
    "02-Profile",
    "03-Archive",
    "04-OutBox",
    "05-Buffer",
  ]);
  assert.deepEqual(contract.core_knowledge_roots, ["01-Cards", "02-Profile", "04-OutBox", "05-Buffer"]);
  assert.deepEqual(contract.raw_material_roots, ["00-Inbox", "03-Archive"]);
  assert.deepEqual(
    [...contract.core_knowledge_roots, ...contract.raw_material_roots].sort(),
    [...contract.knowledge_roots].sort(),
  );

  for (const name of [".nexogenesis", "node_modules", "dist", "tmp", "06-Journal", "07-Conversations"]) {
    assert.ok(contract.excluded_directory_names.includes(name), `${name} must be excluded`);
  }
  assert.ok(contract.excluded_file_names.includes(".env"));
  assert.ok(contract.root_files.includes("prepare-nexogenesis.ps1"));
  assert.ok(contract.program_roots.includes(".agent"));
  assert.ok(contract.program_roots.includes("packages"));
  assert.ok(contract.program_roots.includes("schemes"));
});

test("便携配置只保存路径占位符", () => {
  assert.match(preset, /__NEXO_PROJECT_ROOT__/);
  assert.match(patch, /__NEXO_PROJECT_ROOT__/);
  assert.doesNotMatch(preset, /D:\/UESR\/Desktop\/NEXOGENESIS-DSH/);
  assert.doesNotMatch(patch, /D:\/UESR\/Desktop\/NEXOGENESIS-DSH/);
});
