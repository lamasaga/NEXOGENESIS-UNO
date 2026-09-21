import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { annotateCardUnits, selectCardUnitMigrationCandidates } from "../packages/nexogenesis-tools/lib/card-unit-annotations.js";
import { loadCards, readCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { HarnessGateway } from "../packages/nexogenesis-tools/lib/harness/gateway.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const rootArg = process.argv.find((item) => item.startsWith("--root="));
const root = resolve(rootArg ? rootArg.slice("--root=".length) : ".");
const cards = loadCards(root);
const candidates = selectCardUnitMigrationCandidates(cards);
const byType = Object.fromEntries([...new Set(candidates.map((item) => item.type))].sort().map((type) => [type, candidates.filter((item) => item.type === type).length]));
const unitCount = candidates.reduce((total, item) => total + item.added.length, 0);

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", root, candidates: candidates.length, units_to_add: unitCount, by_type: byType }, null, 2));
if (!apply) process.exit(0);

const gateway = new HarnessGateway(root);
let committedCards = 0;
let committedUnits = 0;
for (let index = 0; index < candidates.length; index += 3) {
	const batch = candidates.slice(index, index + 3);
	const operations = batch.map((candidate) => {
		const latest = readCard(root, candidate.id);
		const annotated = annotateCardUnits(candidate.id, candidate.type, latest.body);
		if (annotated.added.length === 0) throw new Error(`Card ${candidate.id} 在迁移过程中不再满足标注条件：${annotated.reason}`);
		return { ...latest, body: annotated.body };
	});
	const checked = gateway.preflight({ operations, layer: "content" });
	const fingerprint = createHash("sha256").update(batch.map((item) => item.id).join("\n")).digest("hex").slice(0, 12);
	gateway.commit({
		proposal_id: `card-unit-migration-${String(index / 3 + 1).padStart(3, "0")}-${fingerprint}`,
		operations: checked.cards,
		revisions: checked.revisions,
		layer: checked.layer
	});
	committedCards += batch.length;
	committedUnits += batch.reduce((total, item) => total + item.added.length, 0);
	if (committedCards % 30 === 0 || committedCards === candidates.length) {
		console.log(`progress ${committedCards}/${candidates.length} cards; ${committedUnits}/${unitCount} units`);
	}
}

console.log(JSON.stringify({ status: "completed", committed_cards: committedCards, committed_units: committedUnits }, null, 2));
