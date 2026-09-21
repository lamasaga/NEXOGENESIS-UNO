/**
 * Local registry for independent DSH knowledge instances.
 *
 * The registry is runtime configuration, not knowledge: every instance keeps
 * its Markdown directories as its own semantic source of truth.  The initial
 * DSH workspace is registered as a legacy writable instance without changing
 * its existing files; newly created instances receive a small manifest.
 */
import { randomUUID } from "node:crypto";
import {
	existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
	statSync, writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import YAML from "yaml";

const INSTANCE_MANIFEST = "nexogenesis.instance.yml";
const INSTANCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INSTANCE_DIRECTORIES = [
	"00-Inbox", "01-Cards", "02-Profile", "03-Archive", "04-OutBox", "05-Buffer", "06-Journal", "07-Conversations"
];
const subscribers = new Set();
let context = null;
export function activeInstanceIdentity() { return context?.active?.id ?? null; }
export function instanceSynchronizationReady() { return !context?.active?.warnings?.length; }

function normalizeName(value) {
	const name = typeof value === "string" ? value.trim() : "";
	if (name === "") throw new Error("知识实例名称不能为空");
	if (name.length > 80) throw new Error("知识实例名称不能超过 80 个字符");
	if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error("知识实例名称不能包含控制字符");
	return name;
}

function canonicalDirectory(path) {
	const resolved = resolve(path);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`知识实例目录不存在：${resolved}`);
	return realpathSync(resolved);
}

function emptyRegistry() {
	return { schema_version: 1, active_instance_id: null, instances: [] };
}

function readManifest(root) {
	const path = join(root, INSTANCE_MANIFEST);
	if (!existsSync(path)) return null;
	const value = YAML.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || !INSTANCE_ID.test(String(value.id ?? ""))) {
		throw new Error(`知识实例清单格式错误：${path}`);
	}
	return { id: String(value.id), name: normalizeName(value.name), root, legacy: false };
}

function normalizeRecord(record) {
	if (!record || !INSTANCE_ID.test(String(record.id ?? '')) || typeof record.root !== 'string' || !record.root.trim()) throw new Error('知识实例登记记录无效');
	const registered = { id: record.id, name: normalizeName(record.name), root: resolve(record.root), legacy: record.legacy === true };
	let root;
	try { root = canonicalDirectory(registered.root); }
	catch { return { ...registered, status: 'unavailable', reason: '目录不可访问，请重新连接或定位。' }; }
	let manifest;
	try { manifest = readManifest(root); }
	catch { return { ...registered, status: 'invalid_manifest', reason: '实例清单无法读取或格式错误。' }; }
	if (manifest) {
		if (record.id !== manifest.id) return { ...registered, status: 'invalid_manifest', reason: '登记 ID 与实例清单不一致。' };
		return { ...manifest, status: 'available' };
	}
	if (record?.legacy !== true || !INSTANCE_ID.test(String(record.id ?? ""))) {
		return { ...registered, status: 'invalid_manifest', reason: '实例清单缺失。' };
	}
	return { ...registered, root, status: 'available' };
}

function assertAvailable(instance) {
	if (instance.status && instance.status !== 'available') throw Object.assign(new Error('知识实例不可用，请重新检查目录或清单。'), { code: 'INSTANCE_UNAVAILABLE' });
}

export function readInstanceRegistry(registryPath) {
	if (!registryPath || !existsSync(registryPath)) return emptyRegistry();
	const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
	if (!parsed || parsed.schema_version !== 1 || !Array.isArray(parsed.instances)) {
		throw new Error(`知识实例登记表格式错误：${registryPath}`);
	}
	const seenIds = new Set();
	const seenRoots = new Set();
	const instances = parsed.instances.map((record) => {
		const instance = normalizeRecord(record);
		const foldedRoot = instance.root.toLocaleLowerCase();
		if (seenIds.has(instance.id)) throw new Error(`知识实例 id 重复：${instance.id}`);
		if (seenRoots.has(foldedRoot)) throw new Error(`知识实例路径重复：${instance.root}`);
		seenIds.add(instance.id);
		seenRoots.add(foldedRoot);
		return instance;
	});
	const activeId = parsed.active_instance_id;
	if (activeId !== null && !instances.some((instance) => instance.id === activeId)) {
		throw new Error(`当前知识实例未登记：${activeId}`);
	}
	return { schema_version: 1, active_instance_id: activeId, instances };
}

function persistRegistry(registryPath, registry) {
	mkdirSync(dirname(registryPath), { recursive: true });
	const staging = `${registryPath}.staging-${process.pid}-${randomUUID()}`;
	writeFileSync(staging, JSON.stringify({
		schema_version: 1,
		active_instance_id: registry.active_instance_id,
		instances: registry.instances.map(({ id, name, root, legacy }) => ({ id, name, root, ...(legacy ? { legacy: true } : {}) }))
	}, null, 2), "utf8");
	renameSync(staging, registryPath);
}

export function ensureInstanceRegistry(registryPath, fallbackRoot) {
	const existing = readInstanceRegistry(registryPath);
	if (existing.instances.length) return existing;
	let root = canonicalDirectory(fallbackRoot);
	if(!existsSync(join(root,'01-Cards'))&&existsSync(join(root,'knowledge-bases','legacy'))){
	  root=join(root,'knowledge-bases','legacy');mkdirSync(root,{recursive:true});
	  for(const dir of INSTANCE_DIRECTORIES)mkdirSync(join(root,dir),{recursive:true});
	  writeFileSync(join(root,INSTANCE_MANIFEST),YAML.stringify({schema_version:1,id:'legacy',name:'主知识库'}));
	}
	// Keep the original metadata filename for the workspace that existed before
	// instance switching, so its existing conversations remain available.
	const initial = readManifest(root)??{ id: "legacy", name: basename(root) || "UNO", root, legacy: true };
	const registry = { schema_version: 1, active_instance_id: initial.id, instances: [initial] };
	persistRegistry(registryPath, registry);
	return registry;
}

function publish(next) {
	context = next;
	const warnings = [];
	for (const subscriber of subscribers) { try { subscriber(next.active); } catch { warnings.push('INSTANCE_SUBSCRIBER_FAILED'); } }
	if (warnings.length) next.active.warnings = warnings;
}

export function configureInstanceContext({ registryPath, fallbackRoot }) {
	const resolvedRegistryPath = resolve(registryPath || join(canonicalDirectory(fallbackRoot), ".nexogenesis", "instances.json"));
	const registry = ensureInstanceRegistry(resolvedRegistryPath, fallbackRoot);
	const active = registry.instances.find((instance) => instance.id === registry.active_instance_id) ?? registry.instances[0];
	if (!active) throw new Error(`没有已登记的知识实例：${registryPath}`);
	assertAvailable(active);
	if (registry.active_instance_id !== active.id) {
		registry.active_instance_id = active.id;
		persistRegistry(resolvedRegistryPath, registry);
	}
	publish({ registryPath: resolvedRegistryPath, registry, active });
	return active;
}

export function subscribeActiveInstance(subscriber) {
	subscribers.add(subscriber);
	return () => subscribers.delete(subscriber);
}

/** Read the host's registered libraries without changing the active write target. */
export function currentInstanceRegistry(fallbackRoot) {
	return context ? readInstanceRegistry(context.registryPath)
		: ensureInstanceRegistry(join(fallbackRoot, '.nexogenesis', 'instances.json'), fallbackRoot);
}

export function activateKnowledgeInstance(registryPath, instanceId) {
	const registry = readInstanceRegistry(registryPath);
	const active = registry.instances.find((instance) => instance.id === instanceId);
	if (!active) throw new Error(`知识实例不存在：${instanceId}`);
	assertAvailable(active);
	registry.active_instance_id = active.id;
	persistRegistry(registryPath, registry);
	publish({ registryPath, registry, active });
	return active;
}

export function createKnowledgeInstance(registryPath, instancesRoot, displayName) {
	const name = normalizeName(displayName);
	const parent = resolve(instancesRoot);
	mkdirSync(parent, { recursive: true });
	const canonicalParent = canonicalDirectory(parent);
	const registry = readInstanceRegistry(registryPath);
	let id;
	do { id = `instance-${randomUUID().slice(0, 8)}`; }
	while (registry.instances.some((instance) => instance.id === id) || existsSync(join(canonicalParent, id)));
	const target = join(canonicalParent, id);
	const staging = join(canonicalParent, `.${id}.staging-${randomUUID()}`);
	mkdirSync(staging);
	try {
		for (const directory of INSTANCE_DIRECTORIES) mkdirSync(join(staging, directory), { recursive: true });
		writeFileSync(join(staging, INSTANCE_MANIFEST), YAML.stringify({ schema_version: 1, id, name }), "utf8");
		writeFileSync(join(staging, "README.md"), `# ${name}\n\n  这是由 DSH 创建的独立知识图谱实例。知识内容以本目录中的 Markdown 文件为唯一语义事实源。\n`, "utf8");
		renameSync(staging, target);
	} catch (error) {
		if (existsSync(staging)) {
			// Staging only contains files created above; retain it for manual recovery rather than deleting user data.
		}
		throw error;
	}
	const instance = { id, name, root: canonicalDirectory(target), legacy: false };
	registry.instances.push(instance);
	if (registry.active_instance_id === null) registry.active_instance_id = id;
	persistRegistry(registryPath, registry);
	return instance;
}

export function registerExistingKnowledgeInstance(registryPath, rootPath, displayName) {
	const root = canonicalDirectory(rootPath);
	if (!existsSync(join(root, "01-Cards"))) throw new Error("登记目录必须包含 01-Cards/");
	const registry = readInstanceRegistry(registryPath);
	if (registry.instances.some((instance) => instance.root.toLocaleLowerCase() === root.toLocaleLowerCase())) {
		throw new Error("该目录已经登记为知识实例");
	}
	const manifest = readManifest(root);
	let instance;
	if (manifest) {
		if (registry.instances.some((item) => item.id === manifest.id)) throw new Error(`知识实例 id 已被其他目录使用：${manifest.id}`);
		instance = manifest;
	} else {
		let id;
		do { id = `external-${randomUUID().slice(0, 8)}`; }
		while (registry.instances.some((item) => item.id === id));
		instance = { id, name: normalizeName(displayName || basename(root)), root, legacy: true };
	}
	registry.instances.push(instance);
	persistRegistry(registryPath, registry);
	return instance;
}

export function renameKnowledgeInstance(registryPath, instanceId, displayName) {
	const name = normalizeName(displayName);
	const registry = readInstanceRegistry(registryPath);
	const instance = registry.instances.find((item) => item.id === instanceId);
	if (!instance) throw new Error(`知识实例不存在：${instanceId}`);
	assertAvailable(instance);
	if (instance.legacy) {
		instance.name = name;
		persistRegistry(registryPath, registry);
		return instance;
	}
	const manifestPath = join(instance.root, INSTANCE_MANIFEST);
	const manifest = YAML.parse(readFileSync(manifestPath, "utf8"));
	manifest.name = name;
	const staging = `${manifestPath}.staging-${process.pid}-${randomUUID()}`;
	writeFileSync(staging, YAML.stringify(manifest), "utf8");
	renameSync(staging, manifestPath);
	return { ...instance, name };
}

export function unregisterKnowledgeInstance(registryPath, instanceId) {
	const registry = readInstanceRegistry(registryPath);
	const instance = registry.instances.find((item) => item.id === instanceId);
	if (!instance) throw new Error(`知识实例不存在：${instanceId}`);
	if (registry.active_instance_id === instanceId) throw new Error("当前知识实例不能移出登记，请先切换到其他实例");
	registry.instances = registry.instances.filter((item) => item.id !== instanceId);
	persistRegistry(registryPath, registry);
	return instance;
}

export function instanceSummary(instance, activeId) {
	let cardCount = null;
	try { if (!instance.status || instance.status === 'available') cardCount = readdirSync(join(instance.root, "01-Cards"), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md")).length; } catch { /* Unavailable counts remain unknown. */ }
	return { id: instance.id, name: instance.name, legacy: instance.legacy === true, active: instance.id === activeId, card_count: cardCount, status: instance.status ?? 'available', ...(instance.reason ? {reason: instance.reason} : {}), ...(instance.warnings ? {warnings: instance.warnings} : {}) };
}
