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
import { randomUUID } from "node:crypto";

const DEFAULT_META = { projects: {}, conversations: {}, deleted: {} };

let cache = null;
let cacheMtime = 0;
let cacheSize = -1;
let cachePath = "";
let activeMetaInstanceId = "legacy";

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
	}
	try {
		const stat = statSync(path);
		if (cache !== null && stat.mtimeMs === cacheMtime && stat.size === cacheSize) return cache;
		cache = JSON.parse(readFileSync(path, "utf8"));
		cacheMtime = stat.mtimeMs;
		cacheSize = stat.size;
	} catch {
		cache = structuredClone(DEFAULT_META);
		cacheMtime = 0;
		cacheSize = -1;
	}
	return cache;
}

/** Persist the cached metadata document. */
export function writeMeta() {
	const path = metaPath();
	cachePath = path;
	mkdirSync(dirname(path), { recursive: true });
	const value = cache ?? readMeta();
	const staging = `${path}.staging-${process.pid}-${Date.now()}`;
	writeFileSync(staging, JSON.stringify(value, null, 2), "utf8");
	renameSync(staging, path);
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
