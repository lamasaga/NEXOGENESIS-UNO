import assert from "node:assert/strict";
import {
	allowedSignature,
	relationReadiness,
	validateRelationSemantics
} from "../packages/nexogenesis-tools/lib/harness/relation-semantics.js";

assert.equal(allowedSignature("involves", "conflict", "claim"), true);
assert.equal(allowedSignature("involves", "conflict", "model"), true);
assert.equal(allowedSignature("involves", "conflict", "entity"), true);
assert.equal(allowedSignature("supports", "conflict", "claim"), false);
assert.equal(allowedSignature("based-on", "conflict", "model"), false);
assert.equal(allowedSignature("influences", "conflict", "phenomenon"), false);
assert.equal(allowedSignature("involves", "claim", "model"), false);

assert.equal(allowedSignature("supports", "phenomenon", "claim"), true);
assert.equal(allowedSignature("influences", "model", "phenomenon"), true);

const selfCard = { id: "self", type: "claim", relations: [{ type: "supports", target: "self", note: "自我支持不构成图关系" }] };
const selfCards = new Map([["self", selfCard]]);
assert.equal(relationReadiness(selfCard, selfCard.relations[0], selfCard).level, "invalid");
assert.equal(validateRelationSemantics(selfCard, selfCards)[0]?.code, "self_relation");

const targetCard = { id: "target", type: "claim", relations: [] };
const duplicateCard = {
	id: "source",
	type: "claim",
	relations: [
		{ type: "supports", target: "target", note: "第一条具体证据说明" },
		{ type: "supports", target: "target", note: "第二条具体证据说明" }
	]
};
const duplicateCards = new Map([["source", duplicateCard], ["target", targetCard]]);
assert.equal(validateRelationSemantics(duplicateCard, duplicateCards)[0]?.code, "duplicate_relation");

console.log("PASS relation semantics: conflict 契约、自指与重复关系约束");
