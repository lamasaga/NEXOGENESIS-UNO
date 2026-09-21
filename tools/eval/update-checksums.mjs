#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesRoot = path.resolve(here, "../../docs/金融经济与国际贸易测试资料集/02-测试集");

function filesBelow(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) return filesBelow(root, full);
    if (entry.name === "checksums.sha256") return [];
    return [full];
  });
}

for (const entry of fs.readdirSync(casesRoot, { withFileTypes: true }).filter((item) => item.isDirectory() && /^FT-\d{3}-/.test(item.name))) {
  const root = path.join(casesRoot, entry.name);
  const lines = filesBelow(root)
    .map((file) => {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const relative = path.relative(root, file).split(path.sep).join("/");
      return `${hash}  ${relative}`;
    })
    .sort((left, right) => left.localeCompare(right, "en"));
  fs.writeFileSync(path.join(root, "checksums.sha256"), `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${entry.name}: ${lines.length} files\n`);
}
