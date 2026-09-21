import { createHash } from "node:crypto";
import { normalizeJsonValue } from "../json-value.js";

const STATUSES = new Set(["ok", "partial", "rejected", "conflict", "error", "cancelled"]);

function compactList(values, limit = 12) {
	return Array.isArray(values) ? values.filter((value) => value !== void 0).slice(0, limit) : [];
}

export function contentDigest(value) {
	return createHash("sha256").update(JSON.stringify(normalizeJsonValue(value ?? null))).digest("hex").slice(0, 16);
}

/** Build the compact model-facing result shared by GraphOps and Harness. */
export function makeObservation({
	operator, status = "ok", summary, evidence = [], scope = {}, revision = {},
	cost = {}, truncated = false, next_actions = [], data, reason_code
}) {
	if (!STATUSES.has(status)) throw new Error(`未知 Observation 状态: ${status}`);
	const out = {
		observation_version: "1.0",
		operator: String(operator),
		status,
		summary: String(summary ?? ""),
		evidence: compactList(evidence),
		scope,
		revision,
		cost,
		truncated: Boolean(truncated),
		next_actions: compactList(next_actions, 4)
	};
	if (reason_code) out.reason_code = String(reason_code);
	if (data !== void 0) {
		out.data = data;
		out.data_digest = contentDigest(data);
	}
	return normalizeJsonValue(out);
}

export function makeHarnessReceipt({ operator, accepted, summary, reason_code, alternatives = [], scope, revision, data }) {
	return makeObservation({
		operator,
		status: accepted ? "ok" : "rejected",
		summary,
		reason_code,
		scope,
		revision,
		data,
		next_actions: alternatives.slice(0, 2)
	});
}

export function observationSchema() {
	return {
		type: "object",
		additionalProperties: true,
		properties: {
			observation_version: { type: "string", required: true },
			operator: { type: "string", required: true },
			status: { type: "string", required: true },
			summary: { type: "string", required: true },
			evidence: { type: "array", required: true },
			scope: { type: "object", required: true, additionalProperties: true },
			revision: { type: "object", required: true, additionalProperties: true },
			cost: { type: "object", required: true, additionalProperties: true },
			truncated: { type: "boolean", required: true },
			next_actions: { type: "array", required: true },
			reason_code: { type: "string" },
			data: { type: "object", additionalProperties: true },
			data_digest: { type: "string" }
		}
	};
}
