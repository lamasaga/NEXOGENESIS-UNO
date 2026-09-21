/**
 * Force-directed graph layout (ported from the original Python
 * `nexogenesis/runtime/layout.py`, with a browser-map-specific balance).
 *
 * Deterministic layout: unique-neighbor springs, distance-limited repulsion
 * and weak centering, with collisions matching the visible node bodies.
 *
 * Positions are cached to `<root>/.nexogenesis/graph/layout.json` so repeat
 * loads are instant and the map stays stable as cards grow (incremental
 * relaxation: new nodes seeded near their domain centroid, old ones soft-pinned).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { simulate as simulateGraph, topology } from "../../nexogenesis-tools/lib/graph-simulation.js";

const LAYOUT_REL = join(".nexogenesis", "graph", "layout.json");
// 调整力参数时递增：旧坐标是旧平衡的结果，不能继续当作新布局使用。
export const LAYOUT_VERSION = 9;

const FULL_ITERS = 400;
const GROW_ITERS = 240;

export function layoutFingerprint(nodes, edges) {
	const graph = topology(nodes, edges);
	return createHash("sha256").update(JSON.stringify({
		nodes: graph.nodes.map(node => [node.id, [...(node.domains ?? [])].sort()]),
		edges: graph.edges.map(edge => [edge.from, edge.to]),
	})).digest("hex");
}

/** Deterministic [0,1) hash (stable across processes). */
function hash01(seed, salt) {
	const h = createHash("md5").update(`${seed}:${salt}`, "utf8").digest("hex");
	return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}

// Preserve the backend's existing deterministic seeds and cached layout behavior.
export function simulate(nodes, edges, iterations, initial, softPin) {
	return simulateGraph(nodes, edges, iterations, initial, softPin, { hash01 });
}

/**
 * Read the cached layout, incrementally relax missing nodes, persist the
 * result. Returns { id: { x, y } } for every node.
 */
export function ensureLayout(root, nodes, edges) {
	const path = join(root, LAYOUT_REL);
	let cached = {};
	let saved;
	const fingerprint = layoutFingerprint(nodes, edges);
	try {
		if (existsSync(path)) {
			saved = JSON.parse(readFileSync(path, "utf8"));
			cached = saved?.positions && typeof saved.positions === "object"
				? saved.positions
				: {};
		}
	} catch { /* treat unreadable cache as empty */ }

	const ids = new Set(nodes.map((n) => n.id));
	const pos = {};
	for (const [cid, p] of Object.entries(cached)) {
		if (ids.has(cid) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
			pos[cid] = { x: p.x, y: p.y };
		}
	}
	const missing = nodes.filter((n) => !(n.id in pos));
	if (missing.length === 0 && saved?.layout_version === LAYOUT_VERSION && saved.fingerprint === fingerprint) return pos;

	let result;
	if (Object.keys(pos).length === 0) {
		// First layout: full simulation.
		result = simulate(nodes, edges, FULL_ITERS, void 0, void 0);
	} else {
		// Incremental: new nodes seeded near their domain centroid; old soft-pinned.
		const domainOf = {};
		for (const n of nodes) domainOf[n.id] = (n.domains !== void 0 && n.domains.length > 0) ? n.domains[0] : "_none";
		const centers = {};
		const counts = {};
		for (const [cid, p] of Object.entries(pos)) {
			const d = domainOf[cid] ?? "_none";
			if (centers[d] === void 0) centers[d] = [0.0, 0.0];
			centers[d][0] += p.x;
			centers[d][1] += p.y;
			counts[d] = (counts[d] ?? 0) + 1;
		}
		for (const d of Object.keys(centers)) {
			centers[d][0] /= counts[d];
			centers[d][1] /= counts[d];
		}
		const initial = {};
		for (const [cid, p] of Object.entries(pos)) initial[cid] = [p.x, p.y];
		for (const n of missing) {
			const d = domainOf[n.id] ?? "_none";
			const c = centers[d] ?? [0.0, 0.0];
			const ang = hash01(n.id, "grow-a") * Math.PI * 2;
			const r = 20.0 + 30.0 * hash01(n.id, "grow-r");
			initial[n.id] = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
		}
		const upgrading = saved?.layout_version !== LAYOUT_VERSION;
		const softPin = !upgrading && missing.length > 0 && missing.length < nodes.length * 0.1 ? new Set(Object.keys(pos)) : undefined;
		result = simulate(nodes, edges, upgrading ? FULL_ITERS : GROW_ITERS, initial, softPin);
	}

	const temporary = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (saved?.layout_version !== LAYOUT_VERSION && existsSync(path)) copyFileSync(path, `${path}.previous`);
		writeFileSync(temporary, JSON.stringify({ layout_version: LAYOUT_VERSION, fingerprint, positions: result }, null, 1), "utf8");
		renameSync(temporary, path);
	} catch { try { unlinkSync(temporary); } catch { /* cache write is best-effort */ } }
	return result;
}

const pendingLayouts = new Map();

/**  同实例串行重排；缓存命中立即返回，计算在工作线程中进行。 */
export async function ensureLayoutAsync(root, nodes, edges) {
	const fingerprint = layoutFingerprint(nodes, edges);
	try {
		const saved = JSON.parse(readFileSync(join(root, LAYOUT_REL), "utf8"));
		if (saved.layout_version === LAYOUT_VERSION && saved.fingerprint === fingerprint
			&& nodes.every(node => Number.isFinite(saved.positions?.[node.id]?.x) && Number.isFinite(saved.positions?.[node.id]?.y))) {
			return Object.fromEntries(nodes.map(node => [node.id, saved.positions[node.id]]));
		}
	} catch { /* rebuild absent or invalid cache */ }
	const previous = pendingLayouts.get(root);
	if (previous?.fingerprint === fingerprint) return previous.promise;
	const promise = (previous?.promise ?? Promise.resolve()).catch(() => {}).then(() => new Promise((resolve, reject) => {
		const worker = new Worker(new URL(import.meta.url), { workerData: { kind: "nexo-layout", root, nodes, edges } });
		let received = false;
		worker.once("message", result => { received = true; resolve(result); });
		worker.once("error", reject);
		worker.once("exit", code => { if (!received) reject(new Error(`Layout worker exited without a result (${code})`)); });
	}));
	pendingLayouts.set(root, { fingerprint, promise });
	try { return await promise; }
	finally { if (pendingLayouts.get(root)?.promise === promise) pendingLayouts.delete(root); }
}

if (!isMainThread && workerData?.kind === "nexo-layout") {
	parentPort.postMessage(ensureLayout(workerData.root, workerData.nodes, workerData.edges));
}
