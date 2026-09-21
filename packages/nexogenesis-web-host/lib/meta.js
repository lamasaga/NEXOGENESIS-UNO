/**
 * Runtime metadata for the compatibility layer: projects, conversation
 * extensions (pinned / task_kind), and soft-deletes. DSH has no native
 * project or pinned concept, so the compatibility layer owns this state in a
 * small JSON file under $DSH_HOME (user-level, alongside settings.yaml).
 * M7 will scope this per user for multi-tenant deployments.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";

const DEFAULT_META = { projects: {}, conversations: {}, deleted: {} };

let cache = null;
let cacheMtime = 0;
let cacheSize = -1;
let cachePath = "";
let activeMetaInstanceId = "legacy";
let diskDigest;
let readFailure = null;
const digest = text => createHash('sha256').update(text).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function validateMeta(value) {
	if (!record(value) || !['projects','conversations','deleted'].every(key => record(value[key]))
		|| !Object.values(value.projects).every(p => record(p) && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.conversations))
		|| !Object.values(value.conversations).every(record) || !Object.values(value.deleted).every(v => typeof v === 'boolean')) {
		throw Object.assign(new Error('项目元数据结构无效，原文件已保留。'), { code: 'META_INVALID_SCHEMA' });
	}
	return value;
}
function metaError(error) {
	const code = error.code?.startsWith('META_') ? error.code : error instanceof SyntaxError ? 'META_INVALID_JSON' : 'META_READ_FAILED';
	return Object.assign(new Error('无法安全读取项目元数据，请重试或从已验证备份恢复；不会初始化覆盖原文件。'), { code, cause: error });
}

function metaPath() {
	const suffix = activeMetaInstanceId === "legacy" ? "" : `.${activeMetaInstanceId}`;
	return join(process.env.DSH_HOME ?? homedir(), `nexogenesis-meta${suffix}.json`);
}

/** Select isolated conversation and task metadata for the active knowledge instance. */
export function setMetaInstanceId(instanceId) {
	const normalized = String(instanceId ?? "legacy").replace(/[^a-z0-9_-]/gi, "-") || "legacy";
	if (normalized === activeMetaInstanceId) return;
	activeMetaInstanceId = normalized;
	cache = null;
	cacheMtime = 0;
	cacheSize = -1;
	cachePath = "";
	diskDigest = undefined;
	readFailure = null;
}

/**
 * Read (and cache) the metadata document.
 * The cache is invalidated when the file changes out-of-band (mtime/size),
 * so external edits (backup, restore, tests) are never clobbered by a stale
 * in-memory copy — the file is the single source of truth.
 */
export function readMeta() {
	const path = metaPath();
	if (cachePath !== path) {
		cache = null;
		cacheMtime = 0;
		cacheSize = -1;
		cachePath = path;
		diskDigest = undefined;
		readFailure = null;
	}
	try {
		const stat = statSync(path);
		if (!readFailure && cache !== null && stat.mtimeMs === cacheMtime && stat.size === cacheSize) return cache;
		const text = readFileSync(path, 'utf8');
		cache = validateMeta(JSON.parse(text));
		diskDigest = digest(text);
		readFailure = null;
		cacheMtime = stat.mtimeMs;
		cacheSize = stat.size;
	} catch (error) {
		if (error.code !== 'ENOENT') { readFailure = metaError(error); throw readFailure; }
		cache = structuredClone(DEFAULT_META);
		diskDigest = null;
		readFailure = null;
		cacheMtime = 0;
		cacheSize = -1;
	}
	return cache;
}

/** Persist the cached metadata document. */
export function writeMeta() {
	const path = metaPath();
	if (cachePath !== path || diskDigest === undefined) readMeta();
	if (readFailure) throw readFailure;
	const value = validateMeta(cache ?? readMeta());
	let original = null;
	try { original = readFileSync(path, 'utf8'); validateMeta(JSON.parse(original)); }
	catch (error) { if (error.code !== 'ENOENT') { readFailure = metaError(error); throw readFailure; } }
	if ((original === null ? null : digest(original)) !== diskDigest) {
		cache = null;
		throw Object.assign(new Error('项目元数据已在其他位置改变，请重新读取后操作。'), { code: 'META_CONFLICT' });
	}
	mkdirSync(dirname(path), { recursive: true });
	const staging = `${path}.staging-${process.pid}-${Date.now()}`;
	const serialized = JSON.stringify(value, null, 2);
	writeFileSync(staging, serialized, "utf8");
	renameSync(staging, path);
	diskDigest = digest(serialized);
	const stat = statSync(path);
	cacheMtime = stat.mtimeMs;
	cacheSize = stat.size;
}

/** Create a project record. */
export function createProjectRecord(name) {
	const meta = readMeta();
	const id = randomUUID();
	meta.projects[id] = { id, name: name ?? "未命名项目", created_at: new Date().toISOString(), conversations: [] };
	writeMeta();
	return meta.projects[id];
}

/** Ensure the default project exists and return it. */
export function ensureDefaultProject() {
	const meta = readMeta();
	const existing = Object.values(meta.projects)[0];
	if (existing !== void 0) return existing;
	return createProjectRecord("Nexogenesis 知识库");
}

/** Mark a conversation soft-deleted. */
export function softDeleteConversation(id) {
	const meta = readMeta();
	meta.deleted[id] = true;
	writeMeta();
}

/** Conversation extension state (pinned / task_kind / project_id), or defaults. */
export function archivePipelineConversation(id, replacementId) {
	const meta = readMeta();
	meta.conversations[id] = { ...meta.conversations[id], pinned: false, archived_at: new Date().toISOString(), replaced_by: replacementId };
	// Reuse the existing visibility fence; retain the full DSH event log and run files.
	meta.deleted[id] = true;
	writeMeta();
}

/** Conversation extension state (pinned / task_kind / project_id), or defaults. */
export function conversationExt(id) {
	const meta = readMeta();
	return { ...(meta.conversations[id] ?? {}), pinned: meta.conversations[id]?.pinned ?? false, deleted: meta.deleted[id] === true };
}

/** Only sessions explicitly registered by this Nexogenesis surface are addressable. */
export function isNexogenesisConversation(id, projectId) {
	if (typeof id !== "string" || id === "") return false;
	const meta = readMeta();
	const ext = meta.conversations[id];
	if (!ext || meta.deleted[id] === true) return false;
	return projectId === void 0 || ext.project_id === projectId;
}

/** Patch one conversation's extension state. */
export function patchConversationExt(id, patch) {
	const meta = readMeta();
	meta.conversations[id] = { ...(meta.conversations[id] ?? {}), ...patch };
	writeMeta();
}
