import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { auditCardQuality } from "../packages/nexogenesis-tools/lib/harness/knowledge-quality.js";

const root = process.cwd();
const cards = loadCards(root);
const start = new Date("2026-09-01T01:56:00+08:00");
const themes = new Set(["exchange-rates", "asset-pricing", "portfolio-management", "behavioral-finance", "corporate-valuation", "econometrics", "behavioral-economics", "information-incentives", "market-microstructure"]);
const selected = [...cards.values()].filter((record) => {
	const id = record.meta.id;
	const path = join(root, "01-Cards", `${id}.md`);
	if (statSync(path).mtime < start) return false;
	return (record.meta.sources ?? []).some((source) => themes.has(/^05-Buffer\/themes\/([^/]+)\//u.exec(String(source).replaceAll("\\", "/"))?.[1]));
});

const findings = [];
const counts = Object.fromEntries([...themes].map((theme) => [theme, 0]));
for (const record of selected) {
	const card = { ...record.meta, body: record.body };
	const audit = auditCardQuality(card, { root });
	const sourceThemes = new Set();
	for (const source of card.sources ?? []) {
		const normalized = String(source).replaceAll("\\", "/");
		const theme = /^05-Buffer\/themes\/([^/]+)\//u.exec(normalized)?.[1];
		if (theme && themes.has(theme)) sourceThemes.add(theme);
		if (!existsSync(join(root, normalized))) findings.push({ id: card.id, code: "missing_source", value: normalized });
	}
	for (const theme of sourceThemes) counts[theme] += 1;
	if (!(card.relations ?? []).length) findings.push({ id: card.id, code: "unconnected" });
	for (const rel of card.relations ?? []) if (!cards.has(rel.target)) findings.push({ id: card.id, code: "ghost_relation", value: rel.target });
	for (const domain of card.domains ?? []) {
		const target = cards.get(domain);
		if (!target || target.meta.type !== "domain") findings.push({ id: card.id, code: "invalid_domain", value: domain });
	}
	for (const item of audit.findings.filter((x) => x.severity === "error")) findings.push({ id: card.id, code: item.code, value: item.detail });
}

console.log(JSON.stringify({ selected: selected.length, ready: selected.length - new Set(findings.map((x) => x.id)).size, counts, findings }, null, 2));
if (selected.length !== 54 || findings.length) process.exitCode = 1;
