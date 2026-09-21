/**
 * Normalize a full-card content proposal into a body-only operation.
 *
 * Older tools and model retries may still send a whole Card record for a
 * content edit.  Relations, domains and provenance are not evidence in a
 * body edit, so accept only title/body and retain the latest stored metadata.
 */
import { readCard } from "../cards.js";

const PROTECTED_FIELDS = [
	"type", "maturity", "lifecycle", "domains", "origin", "sources", "relations",
	"created", "updated", "metadata"
];

export function preserveContentMetadata(root, operation) {
	const id = String(operation?.id ?? "");
	const existing = id ? readCard(root, id) : null;
	if (!existing) return { operation, ignored_fields: [] };
	const ignored_fields = PROTECTED_FIELDS.filter((field) =>
		operation?.[field] !== void 0 && JSON.stringify(operation[field]) !== JSON.stringify(existing[field])
	);
	return {
		operation: {
			...existing,
			title: typeof operation?.title === "string" ? operation.title : existing.title,
			body: typeof operation?.body === "string" ? operation.body : existing.body
		},
		ignored_fields
	};
}
