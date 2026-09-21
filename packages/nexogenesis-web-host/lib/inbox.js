/**
 * /api/inbox compatibility handler: multipart upload into 00-Inbox/.
 * Parses the multipart body by boundary, guards the filename against
 * path traversal, and saves each part under 00-Inbox/.
 */
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { listInbox } from "../../nexogenesis-tools/lib/cards.js";
import { currentInstanceRegistry } from "../../nexogenesis-tools/lib/instances/registry.js";
import { HttpError, json } from "./rpc.js";

export const MAX_INBOX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_INBOX_BYTES = MAX_INBOX_FILE_BYTES + 2 * 1024 * 1024;
const SAFE_NAME = /[\\/:*?"<>|\x00-\x1f]/g;

function materialType(path) {
	const extension = extname(path).toLowerCase();
	if (extension === ".pdf") return "pdf";
	if (extension === ".epub") return "epub";
	if ([".md", ".markdown", ".txt", ".text", ".html", ".htm", ".csv", ".json", ".yaml", ".yml"].includes(extension)) return "text";
	return "other";
}

/** GET /api/inbox → files that can be selected as one compile scope. */
export async function handleInboxList(_ctx, _req, res, _trustedHosts, projectRoot) {
	const documents = listInbox(projectRoot).flatMap(({ path }) => {
		try {
			const stat = statSync(join(projectRoot, "00-Inbox", path));
			return [{ path, doc_type: materialType(path), size: stat.size, modified_at: stat.mtimeMs }];
		} catch {
			return [];
		}
	}).sort((left, right) => right.modified_at - left.modified_at || left.path.localeCompare(right.path, "zh"));
	json(res, 200, { documents });
}

/** Parse a multipart/form-data body into { filename, content } parts. */
export function parseMultipart(body, contentType) {
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
	if (!match) throw new HttpError(400, "缺少 multipart boundary");
	const boundaryText = (match[1] ?? match[2]).trim();
	if (boundaryText.length === 0 || boundaryText.length > 200 || /[\r\n\x00-\x1f]/.test(boundaryText)) {
		throw new HttpError(400, "multipart boundary 非法");
	}
	const boundary = Buffer.from(`--${boundaryText}`, "ascii");
	const separator = Buffer.from(`\r\n--${boundaryText}`, "ascii");
	const headerSeparator = Buffer.from("\r\n\r\n", "ascii");
	const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
	const parts = [];
	let cursor = source.indexOf(boundary);
	if (cursor !== 0) throw new HttpError(400, "multipart 正文起始边界非法");
	while (cursor >= 0) {
		cursor += boundary.length;
		if (source.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
		if (!source.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) throw new HttpError(400, "multipart 边界格式非法");
		const headersStart = cursor + 2;
		const headerEnd = source.indexOf(headerSeparator, headersStart);
		if (headerEnd < 0) throw new HttpError(400, "multipart 文件头不完整");
		const headers = source.subarray(headersStart, headerEnd).toString("latin1");
		const contentStart = headerEnd + headerSeparator.length;
		const nextBoundary = source.indexOf(separator, contentStart);
		if (nextBoundary < 0) throw new HttpError(400, "multipart 结束边界缺失");
		const filenameMatch = /filename="([^"]*)"/i.exec(headers);
		if (!filenameMatch) { cursor = nextBoundary + 2; continue; }
		// Browsers send filename in UTF-8; the latin1 pass must be reversed.
		const filename = Buffer.from(filenameMatch[1], "latin1").toString("utf8");
		if (filename !== "") parts.push({ filename, content: source.subarray(contentStart, nextBoundary) });
		cursor = nextBoundary + 2;
	}
	return parts;
}

function safeFilename(filename) {
	let safe = filename.replace(SAFE_NAME, "_").trim().replace(/[. ]+$/g, "");
	const extension = extname(safe).slice(0, 20);
	if (safe.length > 180) safe = safe.slice(0, 180 - extension.length) + extension;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
	if (safe === "" || safe === "." || safe === "..") throw new HttpError(400, "没有可保存的文件名");
	return safe;
}

/** POST /api/inbox: independent file receipts; a failed file never rolls back its neighbours. */
export async function handleInboxUpload(ctx, req, res, _trustedHosts, projectRoot) {
	const expectedInstance = req.headers["x-nexogenesis-instance"];
	if (expectedInstance && expectedInstance !== currentInstanceRegistry(projectRoot).active_instance_id) {
		throw new HttpError(409, "当前知识库已变化，未导入本批文件；请切回原知识库后重试");
	}
	const contentType = req.headers["content-type"];
	if (typeof contentType !== "string" || !contentType.includes("multipart/form-data")) {
		throw new HttpError(415, "需要 multipart/form-data");
	}
	const declaredHeader=req.headers["content-length"];
	const declared=declaredHeader===undefined?null:Number(declaredHeader);
	if(declared!==null&&(!Number.isSafeInteger(declared)||declared<0))throw new HttpError(400,"Content-Length 非法");
	if(declared!==null&&declared>MAX_INBOX_BYTES)throw new HttpError(413,"单次上传超过 258 MiB；单个文件最多 256 MiB");
	const chunks = [];
	const allocated=declared===null?null:Buffer.allocUnsafe(declared);
	let received = 0;
	for await (const chunk of req) {
		const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
		received += bytes.length;
		if (received > MAX_INBOX_BYTES) throw new HttpError(413, "单次上传超过 258 MiB；单个文件最多 256 MiB");
		if(allocated)bytes.copy(allocated,received-bytes.length);else chunks.push(bytes);
	}
	if(declared!==null&&received!==declared)throw new HttpError(400,"上传正文长度与 Content-Length 不一致");
	const parts = parseMultipart(allocated??Buffer.concat(chunks), contentType);
	if (parts.length === 0) throw new HttpError(400, "没有可保存的文件");
	const dir = join(projectRoot, "00-Inbox");
	mkdirSync(dir, { recursive: true });
	const existing = new Map(readdirSync(dir).map((name) => [name.toLocaleLowerCase("zh-CN"), name]));
	const saved = [];
	const items = [];
	for (const [index, part] of parts.entries()) {
		let target, fd, created = false;
		try {
			if (part.content.length > MAX_INBOX_FILE_BYTES) throw new Error("单个文件超过 256 MiB，请拆分后导入");
			const safe = safeFilename(part.filename);
			const previous = existing.get(safe.toLocaleLowerCase("zh-CN"));
			if (previous) {
				const previousPath = join(dir, previous);
				const stat = lstatSync(previousPath);
				if (stat.isFile() && !stat.isSymbolicLink() && stat.size === part.content.length && readFileSync(previousPath).equals(part.content)) {
					items.push({ index, name: part.filename, status: "existing", path: previous });
					continue;
				}
				throw new Error(`同名文件内容不同，未覆盖原文件：${previous}；请改名后导入`);
			}
			target = join(dir, safe);
			fd = openSync(target, "wx"); created = true;
			writeFileSync(fd, part.content); closeSync(fd); fd = undefined;
			existing.set(safe.toLocaleLowerCase("zh-CN"), safe);
			saved.push(safe);
			items.push({ index, name: part.filename, status: "saved", path: safe });
		} catch (error) {
			if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original error */ } }
			if (created) { try { unlinkSync(target); } catch { /* only this newly created partial file */ } }
			items.push({ index, name: part.filename, status: "failed", detail: error?.code === "EEXIST" ? "目标文件刚刚被占用，请重试核对" : String(error?.message ?? error) });
		}
	}
	json(res, 200, { saved, items });
}

export { HttpError };
