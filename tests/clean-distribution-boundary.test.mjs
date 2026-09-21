import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const contract = JSON.parse(await readFile(new URL("deploy/clean-agent-distribution.json", root), "utf8"));
const prepare = await readFile(new URL("prepare-nexogenesis.ps1", root), "utf8");
const launcher = await readFile(new URL("start-nexogenesis.cmd", root), "utf8");

test("纯净 Agent 发行只复制运行白名单并创建空知识目录", () => {
  assert.deepEqual(contract.empty_knowledge_directories, [
    "00-Inbox", "01-Cards", "02-Profile", "03-Archive",
    "04-OutBox", "05-Buffer", "06-Journal", "07-Conversations",
  ].map(path=>"knowledge-bases/legacy/"+path));
  for (const directory of contract.empty_knowledge_directories) {
    assert.ok(!contract.include_trees.some((path) => path === directory || path.startsWith(`${directory}/`)));
    assert.ok(!contract.include_files.some((path) => path === directory || path.startsWith(`${directory}/`)));
  }
  for (const forbidden of ["docs/history", "tests", "tools", "instances", ".nexogenesis", "node_modules", "web/dist"]) {
    assert.ok(!contract.include_trees.some((path) => path === forbidden || path.startsWith(`${forbidden}/`)), `${forbidden} must not be copied`);
  }
  assert.ok(contract.include_trees.includes(".agent"));
  assert.ok(contract.include_trees.includes("packages/nexogenesis-tools/lib"));
  assert.ok(contract.include_trees.includes("packages/nexogenesis-web-host/lib"));
  assert.ok(contract.include_trees.includes("schemes/default"));
  assert.ok(contract.include_trees.includes("web/src"));
  assert.deepEqual(contract.mapped_files, [
    { source: "deploy/clean-docs-README.md", target: "docs/README.md" },
  ]);
});

test("纯净发行排除测试、材料、密钥、依赖和运行状态", () => {
  for (const name of [".git", ".nexogenesis", "instances", "node_modules", "dist", "tmp", "coverage", "artifacts", "output", "test-results"]) {
    assert.ok(contract.excluded_directory_names.includes(name), `${name} must be excluded`);
  }
  for (const glob of [".env.*", "*.log", "*.tsbuildinfo", "*.test.*", "*.map"]) {
    assert.ok(contract.excluded_file_globs.includes(glob), `${glob} must be excluded`);
  }
  for (const glob of ["*.pdf", "*.epub", "*.docx", "*.xlsx", "*.pptx", "*.zip"]) {
    assert.ok(contract.forbidden_payload_globs.includes(glob), `${glob} must be forbidden`);
  }
});

test("准备脚本能幂等初始化空白知识目录，启动器不含本机 DSH 回退路径", () => {
  for (const directory of contract.empty_knowledge_directories) assert.match(prepare, new RegExp(`\"${directory.split("/").at(-1)}\"`));
  assert.doesNotMatch(launcher, /KimiData|D:\\KimiData|C:\\Users/i);
  assert.match(launcher, /start-nexogenesis\.ps1/i);
});
