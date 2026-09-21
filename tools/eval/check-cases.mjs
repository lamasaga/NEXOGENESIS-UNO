#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesRoot = path.resolve(here, "../../docs/金融经济与国际贸易测试资料集/02-测试集");
const requiredEnvelope = ["case_id", "checkpoint", "as_of", "previous_checkpoint", "evidence_anchors", "update_delta", "limitations"];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function cardCatalog(dir) {
  const ids = new Set();
  const targets = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const id = text.match(/^id:\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
    if (!id) throw new Error(`${file} 缺少 id`);
    ids.add(id);
    for (const match of text.matchAll(/^\s*-?\s*target:\s*["']?([^\r\n"']+)/gm)) targets.push({ file, target: match[1].trim() });
  }
  return { ids, targets };
}

const errors = [];
for (const entry of fs.readdirSync(casesRoot, { withFileTypes: true }).filter((item) => item.isDirectory() && /^FT-\d{3}-/.test(item.name))) {
  const root = path.join(casesRoot, entry.name);
  try {
    const spec = readJson(path.join(root, "case.json"));
    const schema = readJson(path.join(root, "output-schema.json"));
    const manifest = readJson(path.join(root, spec.fixture_manifest));
    const expected = readJson(path.join(root, "evaluator/expected-evidence.json"));
    const sourceManifest = readJson(path.join(root, "source-manifest.json"));
    for (const [index, line] of fs.readFileSync(path.join(root, "checksums.sha256"), "utf8").trim().split(/\r?\n/).entries()) {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/);
      if (!match) {
        errors.push(`${spec.case_id}/checksums.sha256:${index + 1}: 格式错误`);
        continue;
      }
      const file = path.join(root, ...match[2].split("/"));
      if (!fs.existsSync(file)) {
        errors.push(`${spec.case_id}: 校验目标不存在 ${match[2]}`);
        continue;
      }
      const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (actual !== match[1]) errors.push(`${spec.case_id}: 校验值漂移 ${match[2]}`);
    }
    const required = new Set(schema.required ?? []);
    for (const field of requiredEnvelope) if (!required.has(field)) errors.push(`${spec.case_id}: output-schema 缺少 ${field}`);
    for (const profile of ["A_naked", "B_fixed_packet", "C_graphops", "D_full"]) if (!spec.execution_profiles?.[profile]) errors.push(`${spec.case_id}: 缺少 execution profile ${profile}`);
    const { ids, targets } = cardCatalog(path.join(root, manifest.cards_dir ?? "fixture/01-Cards"));
    for (const relation of targets) if (!ids.has(relation.target)) errors.push(`${spec.case_id}/${relation.file}: 关系目标 ${relation.target} 不存在`);
    const sources = sourceManifest.sources ?? sourceManifest.visible_sources ?? [];
    for (const checkpoint of spec.checkpoints) {
      const release = manifest.releases[checkpoint.fixture_release];
      if (!release) {
        errors.push(`${spec.case_id}/${checkpoint.id}: 缺少 fixture release`);
        continue;
      }
      for (const id of release.card_ids) if (!ids.has(id)) errors.push(`${spec.case_id}/${checkpoint.id}: 缺少 Card ${id}`);
      const visible = new Set(release.card_ids);
      const visibleSources = new Set(sources.filter((source) => {
        if (source.first_checkpoint) return spec.checkpoints.findIndex((item) => item.id === source.first_checkpoint) <= spec.checkpoints.findIndex((item) => item.id === checkpoint.id);
        const released = source.available_at ?? source.released_at;
        return released ? new Date(released).getTime() <= new Date(checkpoint.as_of).getTime() : false;
      }).map((source) => source.id));
      const evidence = expected.by_checkpoint[checkpoint.id];
      if (!evidence) errors.push(`${spec.case_id}/${checkpoint.id}: 缺少预期证据集合`);
      for (const id of [...(evidence?.key ?? []), ...(evidence?.counter ?? [])]) {
        if (id.startsWith(spec.case_id.replace("-", "")) && !visible.has(id)) errors.push(`${spec.case_id}/${checkpoint.id}: 预期证据 ${id} 尚不可见`);
        if (/^S\d{2}$/.test(id) && !visibleSources.has(id)) errors.push(`${spec.case_id}/${checkpoint.id}: 来源 ${id} 尚不可见或未登记`);
      }
    }
    for (const questionsFile of Object.values(spec.variant_question_files)) {
      for (const [index, line] of fs.readFileSync(path.join(root, questionsFile), "utf8").trim().split(/\r?\n/).entries()) {
        try { JSON.parse(line); } catch (error) { errors.push(`${spec.case_id}/${questionsFile}:${index + 1}: ${error.message}`); }
      }
    }
  } catch (error) {
    errors.push(`${entry.name}: ${error.message}`);
  }
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("四套案例的共同外壳、执行配置、fixture 与证据集合检查通过。\n");
}
