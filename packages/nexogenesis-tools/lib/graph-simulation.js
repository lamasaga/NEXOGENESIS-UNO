/** Pure force calculation shared by backend caching and browser preview. */
import { nodeWorldRadius } from './node-geometry.js';

export function normalizeForce(value = 1) {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 1;
}

function stableHash01(seed, salt) {
	let hash = 2166136261;
	for (const char of seed + ':' + salt) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return (hash >>> 0) / 0xffffffff;
}

// Moderate local grouping with repulsion and weak centering.
const REST_LEN = 50.0;        // 连线自然长度（布局单位）
const SPRING_K = 0.05;
const REPEL_K = 400.0;
const REPEL_CUTOFF = 100.0;   // 实际距离截断；网格只用于查找范围内的节点
const REPEL_MAX = 4.0;        // 每对节点每轮的排斥贡献上限
const GRAVITY_K = 0.0025;
const DOMAIN_COHESION_K = 0.0045;
const DOMAIN_SEPARATION_K = 900.0;
const DOMAIN_SEPARATION_CUTOFF = 220.0;
const DOMAIN_SEPARATION_MAX = 1.5;
const DAMPING = 0.85;         // velocity damping
const MAX_STEP = 6.0;         // per-step displacement cap
const SOFT_PIN = 0.7;         // 保留旧地图，但允许拥挤区域充分调整

/**  布局只看无向邻接；方向、重复类型不叠加弹簧强度。 */
export function topology(nodes, edges) {
	const ordered = [...nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const ids = new Set(ordered.map(node => node.id));
	const unique = new Map();
	for (const edge of edges) {
		if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) continue;
		const pair = [edge.from, edge.to].sort();
		unique.set(JSON.stringify(pair), { from: pair[0], to: pair[1] });
	}
	const links = [...unique.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, edge]) => edge);
	return { nodes: ordered, edges: links };
}

/**  哈希圆盘散布，不用输入顺序预先制造环形结构。 */
function initialPositions(nodes, hash01) {
	const n = Math.max(1, nodes.length);
	const ring = 60.0 + 14.0 * Math.sqrt(n);
	const pos = new Map();
	for (let i = 0; i < nodes.length; i++) {
		const nd = nodes[i];
		const a = hash01(nd.id, "init-a") * Math.PI * 2;
		const r = ring * Math.sqrt(hash01(nd.id, "init-r"));
		pos.set(nd.id, [r * Math.cos(a), r * Math.sin(a)]);
	}
	return pos;
}

/**
 * Build stable domain groups once. Membership is presentation metadata, not a
 * graph edge; duplicate and empty values must not increase force strength.
 */
function domainTopology(nodes) {
	const membersByDomain = new Map();
	for (let i = 0; i < nodes.length; i++) {
		const domains = new Set((nodes[i].domains ?? []).filter(domain => typeof domain === "string" && domain.length > 0));
		for (const domain of domains) {
			if (!membersByDomain.has(domain)) membersByDomain.set(domain, []);
			membersByDomain.get(domain).push(i);
		}
	}
	const groups = [...membersByDomain]
		.filter(([, members]) => members.length > 1)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, members]) => ({ id, members }));
	const memberships = nodes.map(() => []);
	for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
		for (const nodeIndex of groups[groupIndex].members) memberships[nodeIndex].push(groupIndex);
	}
	return {
		groups,
		memberships,
		centers: groups.map(() => [0, 0]),
		centerPushes: groups.map(() => [0, 0]),
	};
}

/**
 * Cohere members around their domain centers while gently separating centers.
 * Both passes are aggregated by domain, avoiding same-domain node-pair scans.
 */
function applyDomainForces(points, forces, domainState, domainCohesion, alpha, hash01) {
	const { groups, memberships, centers, centerPushes } = domainState;
	if (groups.length === 0) return;
	for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
		const group = groups[groupIndex], center = centers[groupIndex], centerPush = centerPushes[groupIndex];
		center[0] = 0; center[1] = 0;
		centerPush[0] = 0; centerPush[1] = 0;
		for (const nodeIndex of group.members) {
			center[0] += points[nodeIndex][0];
			center[1] += points[nodeIndex][1];
		}
		center[0] /= group.members.length;
		center[1] /= group.members.length;
	}
	for (let i = 0; i < groups.length; i++) {
		for (let j = i + 1; j < groups.length; j++) {
			let dx = centers[i][0] - centers[j][0], dy = centers[i][1] - centers[j][1];
			if (dx === 0 && dy === 0) {
				const angle = hash01(groups[i].id, groups[j].id) * Math.PI * 2;
				dx = Math.cos(angle) * 0.01;
				dy = Math.sin(angle) * 0.01;
			}
			const d2 = dx * dx + dy * dy;
			if (d2 > DOMAIN_SEPARATION_CUTOFF * DOMAIN_SEPARATION_CUTOFF) continue;
			const distance = Math.sqrt(d2);
			const push = Math.min(DOMAIN_SEPARATION_MAX, DOMAIN_SEPARATION_K / d2) * domainCohesion * alpha;
			const fx = push * dx / distance, fy = push * dy / distance;
			centerPushes[i][0] += fx; centerPushes[i][1] += fy;
			centerPushes[j][0] -= fx; centerPushes[j][1] -= fy;
		}
	}
	for (let nodeIndex = 0; nodeIndex < points.length; nodeIndex++) {
		const nodeMemberships = memberships[nodeIndex];
		if (nodeMemberships.length === 0) continue;
		let centerX = 0, centerY = 0, pushX = 0, pushY = 0;
		for (const groupIndex of nodeMemberships) {
			centerX += centers[groupIndex][0]; centerY += centers[groupIndex][1];
			pushX += centerPushes[groupIndex][0]; pushY += centerPushes[groupIndex][1];
		}
		const weight = 1 / nodeMemberships.length;
		const point = points[nodeIndex], force = forces[nodeIndex];
		force[0] += DOMAIN_COHESION_K * domainCohesion * (centerX * weight - point[0]) * alpha + pushX * weight;
		force[1] += DOMAIN_COHESION_K * domainCohesion * (centerY * weight - point[1]) * alpha + pushY * weight;
	}
}

/** Push overlapping circles apart without adding padding. Stable order and direction preserve determinism. */
function separateCollisions(ids, pos, radii, passes, hash01) {
	const cellSize = 2 * Math.max(...radii.values());
	for (let pass = 0; pass < passes; pass++) {
		const grid = new Map();
		for (let i = 0; i < ids.length; i++) {
			const p = pos.get(ids[i]), key = `${Math.floor(p[0] / cellSize)},${Math.floor(p[1] / cellSize)}`;
			if (!grid.has(key)) grid.set(key, []);
			grid.get(key).push(i);
		}
		let overlap = false;
		for (let i = 0; i < ids.length; i++) {
			const a = pos.get(ids[i]), cx = Math.floor(a[0] / cellSize), cy = Math.floor(a[1] / cellSize);
			for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
				for (const j of grid.get(`${x},${y}`) ?? []) {
					if (j <= i) continue;
					const b = pos.get(ids[j]), dx = b[0] - a[0], dy = b[1] - a[1];
					const distance = Math.hypot(dx, dy), required = radii.get(ids[i]) + radii.get(ids[j]);
					if (distance >= required) continue;
					overlap = true;
					const angle = distance ? Math.atan2(dy, dx) : hash01(ids[i], ids[j]) * Math.PI * 2;
					const shift = (required - distance + 0.000002) / 2;
					const sx = Math.cos(angle) * shift, sy = Math.sin(angle) * shift;
					a[0] -= sx; a[1] -= sy; b[0] += sx; b[1] += sy;
				}
			}
		}
		if (!overlap) break;
	}
}

/** Remove residual contacts after finite relaxation, including coordinate rounding. */
function finalizeCollisions(ids, pos, radii) {
	const cellSize = 2 * Math.max(...radii.values());
	const grid = new Map();
	for (const id of [...ids].sort((a, b) => pos.get(a)[0] - pos.get(b)[0] || a.localeCompare(b))) {
		const p = pos.get(id), radius = radii.get(id);
		p[0] = Math.round(p[0] * 100) / 100; p[1] = Math.round(p[1] * 100) / 100;
		// Only already placed circles in adjacent cells can collide. Re-query after a move.
		for (;;) {
			const cx = Math.floor(p[0] / cellSize), cy = Math.floor(p[1] / cellSize);
			let right = p[0];
			for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
				for (const other of grid.get(x)?.get(y) ?? []) {
					const q = pos.get(other), required = radius + radii.get(other), dy = p[1] - q[1];
					if ((p[0] - q[0]) ** 2 + dy * dy >= required * required) continue;
					right = Math.max(right, Math.ceil((q[0] + Math.sqrt(required * required - dy * dy) + .000002) * 100) / 100);
				}
			}
			if (right === p[0]) break;
			p[0] = right;
		}
		const cx = Math.floor(p[0] / cellSize), cy = Math.floor(p[1] / cellSize);
		if (!grid.has(cx)) grid.set(cx, new Map());
		const column = grid.get(cx);
		if (!column.has(cy)) column.set(cy, []);
		column.get(cy).push(id);
	}
}

/**
 * Force simulation (deterministic: fixed iterations + hash initial + fixed order).
 * @param nodes - [{ id, domains }]
 * @param edges - [{ from, to }]
 * @param initial - optional { id: [x, y] } override (incremental growth).
 * @param softPin - Set of ids that move with SOFT_PIN weight (keep old map stable).
 */
export function simulate(nodes, edges, iterations, initial, softPin, options = {}) {
	({ nodes, edges } = topology(nodes, edges));
	if (!nodes.length) return {};
	const hash01 = options.hash01 ?? stableHash01;
	const strength = value => options.interactive ? Math.expm1(Math.LN2 * normalizeForce(value)) : normalizeForce(value);
	const gravity = options.interactive ? normalizeForce(options.gravity) ** 1.5 : strength(options.gravity);
	const repulsion = strength(options.repulsion);
	const linkAttraction = strength(options.linkAttraction);
	// Domain cohesion is opt-in so existing backend and saved layouts keep their balance.
	const domainCohesion = options.domainCohesion === void 0 ? 0 : strength(options.domainCohesion);
	const damping = options.interactive ? 0.7 : DAMPING;
	const maxStep = options.interactive ? 12 : MAX_STEP;
	// Stronger links visibly shorten their preferred distance as well as resisting stretch.
	const restLength = options.interactive ? REST_LEN / (0.5 + 0.5 * Math.sqrt(linkAttraction)) : REST_LEN;
	const ids = nodes.map((n) => n.id);
	const idxOf = new Map(ids.map((id, i) => [id, i]));
	const pos = initialPositions(nodes, hash01);
	if (initial !== void 0) {
		for (const [cid, p] of Object.entries(initial)) {
			if (pos.has(cid) && Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) pos.set(cid, [p[0], p[1]]);
		}
	}
	const vel = new Map(ids.map((id) => [id, [0, 0]]));
	const pairs = [];
	for (const e of edges) {
		if (idxOf.has(e.from) && idxOf.has(e.to)) pairs.push([idxOf.get(e.from), idxOf.get(e.to)]);
	}
	const degrees = new Map(ids.map(id => [id, 0]));
	for (const [a, b] of pairs) { degrees.set(ids[a], degrees.get(ids[a]) + 1); degrees.set(ids[b], degrees.get(ids[b]) + 1); }
	const radii = new Map(ids.map(id => [id, nodeWorldRadius(degrees.get(id))]));
	const pin = softPin ?? new Set();
	const points = ids.map(id => pos.get(id));
	const velocities = ids.map(id => vel.get(id));
	const forces = ids.map(() => [0, 0]);
	// Keep the default path free of domain bookkeeping when the feature is off.
	const domainState = domainCohesion === 0 ? null : domainTopology(nodes);

	for (let it = 0; it < iterations; it++) {
		const alpha = 1.0 - 0.95 * (it / Math.max(1, iterations));
		for (const f of forces) { f[0] = 0; f[1] = 0; }

		//  网格筛选候选，再按实际距离截断；不计算远处网格的合并排斥。
		const grid = new Map();
		for (const cid of ids) {
			const p = pos.get(cid);
			const cell = `${Math.floor(p[0] / REPEL_CUTOFF)},${Math.floor(p[1] / REPEL_CUTOFF)}`;
			if (!grid.has(cell)) grid.set(cell, []);
			grid.get(cell).push(idxOf.get(cid));
		}
		for (const cid of ids) {
			const i = idxOf.get(cid);
			const p = pos.get(cid);
			const cx = Math.floor(p[0] / REPEL_CUTOFF);
			const cy = Math.floor(p[1] / REPEL_CUTOFF);
			for (let dcx = -1; dcx <= 1; dcx++) {
				for (let dcy = -1; dcy <= 1; dcy++) {
					const cell = grid.get(`${cx + dcx},${cy + dcy}`);
					if (cell === void 0) continue;
					for (const j of cell) {
						if (j <= i) continue;
						const other = ids[j];
						const po = points[j];
						let dx = p[0] - po[0], dy = p[1] - po[1];
						if (dx === 0 && dy === 0) {
							const angle = hash01(cid, other) * Math.PI * 2;
							dx = Math.cos(angle) * 0.01; dy = Math.sin(angle) * 0.01;
						}
						const d2 = dx * dx + dy * dy;
						if (d2 > REPEL_CUTOFF * REPEL_CUTOFF) continue;
						const dist = Math.sqrt(d2);
						const f = Math.min(REPEL_MAX, REPEL_K / d2) * repulsion * alpha;
						const fx = f * dx / dist;
						const fy = f * dy / dist;
						const fa = forces[i];
						const fb = forces[j];
						fa[0] += fx; fa[1] += fy;
						fb[0] -= fx; fb[1] -= fy;
					}
				}
			}
		}

		// Edge springs (strongest).
		for (const [i, j] of pairs) {
			const a = ids[i], b = ids[j];
			const pa = points[i], pb = points[j];
			const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
			const dist = Math.hypot(dx, dy) || 0.01;
			const f = SPRING_K * linkAttraction * (dist - restLength) * alpha;
			const fx = f * dx / dist, fy = f * dy / dist;
			const fa = forces[i], fb = forces[j];
			fa[0] += fx; fa[1] += fy;
			fb[0] -= fx; fb[1] -= fy;
		}

		if (domainState !== null) applyDomainForces(points, forces, domainState, domainCohesion, alpha, hash01);

		// Centroid gravity (weakest).
		let gx = 0, gy = 0;
		for (const cid of ids) {
			const p = pos.get(cid);
			gx += p[0]; gy += p[1];
		}
		gx /= ids.length; gy /= ids.length;
		for (const cid of ids) {
			const p = pos.get(cid);
			const f = forces[idxOf.get(cid)];
			f[0] += GRAVITY_K * gravity * (gx - p[0]) * alpha;
			f[1] += GRAVITY_K * gravity * (gy - p[1]) * alpha;
		}

		// Integrate: damping + step cap + soft pin.
		for (const cid of ids) {
			const w = pin.has(cid) ? SOFT_PIN : 1.0;
			const p = pos.get(cid);
			const f = forces[idxOf.get(cid)];
			const v = velocities[idxOf.get(cid)];
			let vx = (v[0] + f[0]) * damping;
			let vy = (v[1] + f[1]) * damping;
			const step = Math.hypot(vx, vy);
			if (step > maxStep) {
				vx = vx * maxStep / step;
				vy = vy * maxStep / step;
			}
			v[0] = vx; v[1] = vy;
			p[0] += vx * w;
			p[1] += vy * w;
		}
		separateCollisions(ids, pos, radii, 1, hash01);
		if (options.onProgress && (it + 1) % (options.interactive ? 6 : 16) === 0 && it + 1 < iterations) {
			// Correct a copy before displaying it; previews cannot disturb the simulation.
			const preview = new Map(ids.map(id => [id, [...pos.get(id)]]));
			finalizeCollisions(ids, preview, radii);
			options.onProgress(Object.fromEntries(ids.map(id => [id, { x: preview.get(id)[0], y: preview.get(id)[1] }])), (it + 1) / iterations);
		}
	}
	separateCollisions(ids, pos, radii, 80, hash01);
	finalizeCollisions(ids, pos, radii);

	const out = {};
	for (const cid of ids) {
		// JSON 缓存会把 -0 写成 0；首次返回保持同样表示。
		out[cid] = { x: Math.round(pos.get(cid)[0] * 100) / 100 || 0, y: Math.round(pos.get(cid)[1] * 100) / 100 || 0 };
	}
	return out;
}
