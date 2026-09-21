/**
 * Convert a tool result into the exact value domain supported by JSON.
 *
 * Optional object fields whose value is undefined are intentionally omitted.
 * Undefined array items and non-JSON values are rejected because silently
 * converting them would change the result's meaning.
 */
export function normalizeJsonValue(value) {
	const seen = new WeakSet();

	function visit(current, path, objectField = false) {
		if (current === undefined) {
			if (objectField) return undefined;
			throw new TypeError(`工具返回值包含 undefined: ${path}`);
		}
		if (current === null || typeof current === "string" || typeof current === "boolean") return current;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) throw new TypeError(`工具返回值包含非有限数字: ${path}`);
			return Object.is(current, -0) ? 0 : current;
		}
		if (typeof current !== "object") throw new TypeError(`工具返回值包含非 JSON 类型 ${typeof current}: ${path}`);
		if (seen.has(current)) throw new TypeError(`工具返回值包含循环引用: ${path}`);
		seen.add(current);
		try {
			if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`));
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError(`工具返回值包含非普通对象: ${path}`);
			}
			if (Object.getOwnPropertySymbols(current).length) throw new TypeError(`工具返回值包含 Symbol 键: ${path}`);
			const out = {};
			for (const [key, item] of Object.entries(current)) {
				const normalized = visit(item, `${path}.${key}`, true);
				if (normalized !== undefined) out[key] = normalized;
			}
			return out;
		} finally {
			seen.delete(current);
		}
	}

	return visit(value, "$", false);
}
