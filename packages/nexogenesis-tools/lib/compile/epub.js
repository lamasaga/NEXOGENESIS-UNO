import { inflateRawSync } from "node:zlib";
import { posix as path } from "node:path";
import { COMPILE_RESOURCE_LIMITS } from "./limits.js";

export class EpubExtractionError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "EpubExtractionError";
		this.code = code;
	}
}

function need(buffer, offset, length, code = "invalid_epub") {
	if (offset < 0 || offset + length > buffer.length) {
		throw new EpubExtractionError(code, "EPUB 压缩包结构不完整。");
	}
}

function u16(buffer, offset) { need(buffer, offset, 2); return buffer.readUInt16LE(offset); }
function u32(buffer, offset) { need(buffer, offset, 4); return buffer.readUInt32LE(offset); }

function decode(buffer) {
	return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function attrs(raw) {
	const out = {};
	for (const match of String(raw).matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
		out[match[1].toLowerCase()] = match[3];
	}
	return out;
}

function xmlText(raw) {
	return decodeEntities(String(raw)
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim());
}

function decodeEntities(value) {
	return String(value)
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function findEocd(buffer) {
	const floor = Math.max(0, buffer.length - 0xFFFF - 22);
	for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
		if (buffer.readUInt32LE(offset) === 0x06054B50) return offset;
	}
	throw new EpubExtractionError("invalid_epub", "找不到 EPUB 的 ZIP 目录。");
}

/** Read the ordinary ZIP entries used by EPUB without introducing a runtime dependency. */
export function zipEntries(buffer, limits = COMPILE_RESOURCE_LIMITS) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034B50) {
		throw new EpubExtractionError("invalid_epub", "文件不是可读取的 EPUB ZIP 容器。");
	}
	const eocd = findEocd(buffer);
	const count = u16(buffer, eocd + 10);
	if (count > limits.maxArchiveEntries) {
		throw new EpubExtractionError("epub_resource_limit", `EPUB 条目数超过安全上限（${limits.maxArchiveEntries}）。`);
	}
	const directoryOffset = u32(buffer, eocd + 16);
	if (count === 0xFFFF || directoryOffset === 0xFFFFFFFF) {
		throw new EpubExtractionError("zip64_not_supported", "该 EPUB 使用 ZIP64，当前解析器暂不支持。");
	}
	const entries = new Map();
	entries.resourceLimits = limits;
	let expandedBytes = 0;
	let cursor = directoryOffset;
	for (let index = 0; index < count; index += 1) {
		need(buffer, cursor, 46);
		if (buffer.readUInt32LE(cursor) !== 0x02014B50) {
			throw new EpubExtractionError("invalid_epub", "EPUB 的 ZIP 目录记录无效。");
		}
		const flags = u16(buffer, cursor + 8);
		const compression = u16(buffer, cursor + 10);
		const compressedSize = u32(buffer, cursor + 20);
		const uncompressedSize = u32(buffer, cursor + 24);
		const nameLength = u16(buffer, cursor + 28);
		const extraLength = u16(buffer, cursor + 30);
		const commentLength = u16(buffer, cursor + 32);
		const localOffset = u32(buffer, cursor + 42);
		if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
			throw new EpubExtractionError("zip64_not_supported", "该 EPUB 使用 ZIP64，当前解析器暂不支持。");
		}
		if (uncompressedSize > limits.maxArchiveEntryBytes) {
			throw new EpubExtractionError("epub_resource_limit", `EPUB 条目解压后超过安全上限：${uncompressedSize} 字节。`);
		}
		expandedBytes += uncompressedSize;
		if (expandedBytes > limits.maxArchiveExpandedBytes) {
			throw new EpubExtractionError("epub_resource_limit", `EPUB 解压总量超过安全上限（${limits.maxArchiveExpandedBytes} 字节）。`);
		}
		if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)) {
			throw new EpubExtractionError("epub_resource_limit", `EPUB 条目压缩比超过安全上限（${limits.maxCompressionRatio}:1）。`);
		}
		need(buffer, cursor + 46, nameLength + extraLength + commentLength);
		const name = decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
		entries.set(name, { flags, compression, compressedSize, uncompressedSize, localOffset });
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function entryBytes(buffer, entries, name) {
	const entry = entries.get(name);
	if (!entry) throw new EpubExtractionError("missing_epub_entry", `EPUB 缺少必要文件：${name}`);
	if (entry.flags & 0x1) throw new EpubExtractionError("encrypted_epub", "加密 EPUB 不能在本地可靠读取。");
	need(buffer, entry.localOffset, 30);
	if (buffer.readUInt32LE(entry.localOffset) !== 0x04034B50) {
		throw new EpubExtractionError("invalid_epub", `EPUB 条目 ${name} 的本地记录无效。`);
	}
	const nameLength = u16(buffer, entry.localOffset + 26);
	const extraLength = u16(buffer, entry.localOffset + 28);
	const start = entry.localOffset + 30 + nameLength + extraLength;
	need(buffer, start, entry.compressedSize);
	const compressed = buffer.subarray(start, start + entry.compressedSize);
	const limits = entries.resourceLimits ?? COMPILE_RESOURCE_LIMITS;
	try {
		let output;
		if (entry.compression === 0) output = Buffer.from(compressed);
		else if (entry.compression === 8) output = inflateRawSync(compressed, { maxOutputLength: limits.maxArchiveEntryBytes });
		else throw new EpubExtractionError("unsupported_epub_compression", `EPUB 条目 ${name} 使用了不支持的压缩方式。`);
		if (output.length !== entry.uncompressedSize) {
			throw new EpubExtractionError("corrupt_epub_entry", `EPUB 条目 ${name} 的解压大小与目录记录不一致。`);
		}
		return output;
	} catch (error) {
		if (error instanceof EpubExtractionError) throw error;
		throw new EpubExtractionError("corrupt_epub_entry", `EPUB 条目 ${name} 无法解压：${error.message}`);
	}
}

function resolveEntry(base, href) {
	const clean = String(href ?? "").split(/[?#]/, 1)[0].replaceAll("\\", "/");
	const resolved = path.normalize(path.join(base, clean)).replace(/^\.\//, "");
	if (!clean || resolved === ".." || resolved.startsWith("../") || path.isAbsolute(resolved)) {
		throw new EpubExtractionError("unsafe_epub_path", "EPUB 内含越界资源路径。");
	}
	return resolved;
}

function tableMarkdown(raw) {
	const rows = [];
	for (const row of String(raw).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
		const cells = [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)\s*>/gi)]
			.map((cell) => xmlText(cell[1]).replaceAll("|", "\\|"));
		if (cells.length) rows.push(cells);
	}
	if (!rows.length) return "";
	const width = Math.max(...rows.map((row) => row.length));
	const normalize = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")];
	const header = normalize(rows[0]);
	const body = rows.slice(1).map(normalize);
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map((row) => `| ${row.join(" | ")} |`)
	].join("\n");
}

export function xhtmlToMarkdown(raw) {
	let html = String(raw ?? "")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
	html = html.replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi, (_, table) => `\n\n${tableMarkdown(table)}\n\n`);
	html = html.replace(/<img\b([^>]*)\/?\s*>/gi, (_, rawAttrs) => {
		const image = attrs(rawAttrs);
		const source = image.src ?? "";
		return source ? `\n![${image.alt ?? "插图"}](${source})\n` : "";
	});
	html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, body) => `\n\n${"#".repeat(Number(level))} ${xmlText(body)}\n\n`);
	html = html.replace(/<li\b[^>]*>/gi, "\n- ");
	html = html.replace(/<br\s*\/?>/gi, "\n");
	html = html.replace(/<\/(?:p|div|section|article|blockquote|ul|ol|figure|figcaption|header|footer)\s*>/gi, "\n\n");
	html = html.replace(/<[^>]+>/g, " ");
	const lines = decodeEntities(html)
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
		.map((line) => line.trim() === "" ? "" : line)
		.filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""));
	return lines.join("\n").trim();
}

function epubTitle(opf) {
	const title = /<(?:[\w-]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?title\s*>/i.exec(opf);
	return title ? xmlText(title[1]) : "";
}

function xhtmlTitle(raw) {
	const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(raw);
	return title ? xmlText(title[1]) : "";
}

function usefulChapterTitle(value, bookTitle) {
	const title = String(value ?? "").trim();
	if (!title) return "";
	const normalized = title.toLocaleLowerCase();
	if (["non nommé", "untitled", "unknown", "chapter"].includes(normalized)) return "";
	if (normalized === String(bookTitle ?? "").trim().toLocaleLowerCase()) return "";
	return title;
}

function relinkEpubImages(text, xhtmlPath) {
	const base = path.dirname(xhtmlPath);
	return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, source) => {
		if (/^(?:https?:|data:|epub-resource:)/i.test(source)) return whole;
		try {
			return `![${alt}](epub-resource:${resolveEntry(base, source)})`;
		} catch {
			return whole;
		}
	});
}

function tocLabels(buffer, entries, rootfile, manifest, opf) {
	const spineMatch = /<spine\b([^>]*)>/i.exec(opf);
	const spineAttrs = spineMatch ? attrs(spineMatch[1]) : {};
	const ncxItem = manifest.get(spineAttrs.toc) ?? [...manifest.values()].find((item) => /(?:ncx|dtbncx)/i.test(item["media-type"] ?? ""));
	if (!ncxItem?.href) return new Map();
	try {
		const ncxPath = resolveEntry(path.dirname(rootfile), ncxItem.href);
		const ncx = decode(entryBytes(buffer, entries, ncxPath));
		const labels = new Map();
		for (const match of ncx.matchAll(/<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text\s*>[\s\S]*?<content\b([^>]*)\/?\s*>/gi)) {
			const label = xmlText(match[1]);
			const source = attrs(match[2]).src;
			if (!label || !source) continue;
			const entryPath = resolveEntry(path.dirname(ncxPath), source);
			if (!labels.has(entryPath)) labels.set(entryPath, label);
		}
		return labels;
	} catch {
		return new Map();
	}
}

/**
 * Extract an EPUB into an in-memory chapter text. The caller owns caching and
 * persistence; this function never writes a second copy of the source file.
 */
export function extractEpub(buffer, { limits = COMPILE_RESOURCE_LIMITS } = {}) {
	const entries = zipEntries(buffer, limits);
	const container = decode(entryBytes(buffer, entries, "META-INF/container.xml"));
	const rootfileMatch = /<rootfile\b([^>]*)\/?\s*>/i.exec(container);
	const rootfile = rootfileMatch ? attrs(rootfileMatch[1])["full-path"] : "";
	if (!rootfile) throw new EpubExtractionError("missing_epub_package", "EPUB 缺少 OPF 书目文件。");
	const opf = decode(entryBytes(buffer, entries, rootfile));
	const manifest = new Map();
	for (const match of opf.matchAll(/<item\b([^>]*)\/?\s*>/gi)) {
		const item = attrs(match[1]);
		if (item.id) manifest.set(item.id, item);
	}
	const spine = [...opf.matchAll(/<itemref\b([^>]*)\/?\s*>/gi)]
		.map((match) => attrs(match[1]).idref)
		.filter(Boolean);
	if (!spine.length) throw new EpubExtractionError("missing_epub_spine", "EPUB 的目录顺序为空，无法定位正文。");
	const base = path.dirname(rootfile);
	const labels = tocLabels(buffer, entries, rootfile, manifest, opf);
	const title = epubTitle(opf);
	const chapters = [];
	for (const idref of spine) {
		const item = manifest.get(idref);
		if (!item || !item.href || /\bnav\b/i.test(item.properties ?? "") || !/html/i.test(item["media-type"] ?? "")) continue;
		const entryPath = resolveEntry(base, item.href);
		if (!entries.has(entryPath)) continue;
		const raw = decode(entryBytes(buffer, entries, entryPath));
		const text = relinkEpubImages(xhtmlToMarkdown(raw), entryPath);
		if (!text) continue;
		const heading = /^(#{1,6})\s+(.+)$/m.exec(text);
		const chapterTitle = usefulChapterTitle(heading?.[2], title)
			|| usefulChapterTitle(labels.get(entryPath), title)
			|| usefulChapterTitle(xhtmlTitle(raw), title)
			|| path.basename(item.href).replace(/\.[^.]+$/, "");
		chapters.push({ title: chapterTitle, text, source_locator: `EPUB spine ${chapters.length + 1} / ${entryPath}` });
	}
	if (!chapters.length) throw new EpubExtractionError("empty_epub_spine", "EPUB 目录中没有可读取的 XHTML 正文。");
	return { title, chapters };
}
