const REQUIRED = ["name", "version", "capabilities", "mode", "risk", "cost"];

export class OperatorRegistry {
	constructor() {
		this.entries = new Map();
	}

	register(descriptor) {
		for (const key of REQUIRED) if (descriptor?.[key] === void 0) throw new Error(`Operator 缺少 ${key}`);
		if (this.entries.has(descriptor.name)) throw new Error(`Operator 重复注册: ${descriptor.name}`);
		const frozen = Object.freeze({
			...descriptor,
			capabilities: Object.freeze([...descriptor.capabilities]),
			preconditions: Object.freeze([...(descriptor.preconditions ?? [])]),
			effects: Object.freeze([...(descriptor.effects ?? [])])
		});
		this.entries.set(frozen.name, frozen);
		return frozen;
	}

	get(name) {
		return this.entries.get(name);
	}

	resolve(capability, { allowWrite = false, maxRisk = "medium" } = {}) {
		const ranks = { low: 0, medium: 1, high: 2 };
		const mutating = new Set(["write", "proposal", "runtime-write"]);
		return [...this.entries.values()].filter((entry) =>
			entry.capabilities.includes(capability)
			&& (allowWrite || !mutating.has(entry.mode))
			&& ranks[entry.risk] <= ranks[maxRisk]
		);
	}

	list() {
		return [...this.entries.values()];
	}
}

export const operatorRegistry = new OperatorRegistry();
