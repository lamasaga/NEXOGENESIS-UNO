import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMPILE_RESOURCE_LIMITS } from "./limits.js";

const FIGURE_LABEL_RE = /(?:^|\s)(Figure|Fig\.?|图)\s*([0-9]+(?:\.[0-9]+)*(?:[A-Za-z])?)/giu;

function digest(value, length = 16) {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function compactContext(text, index, length) {
	const start = Math.max(0, index - 180);
	const end = Math.min(text.length, index + length + 360);
	return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 520);
}

/** Find caption-like figure anchors in extracted PDF pages without pretending to understand the image. */
function embeddedImagePages(buffer) {
	if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) return [];
	const directory = mkdtempSync(join(tmpdir(), "nexogenesis-image-index-"));
	const input = join(directory, "source.pdf");
	try {
		writeFileSync(input, buffer);
		const result = spawnSync("pdfimages", ["-list", input], {
			encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
			timeout: COMPILE_RESOURCE_LIMITS.figureProcessTimeoutMs, killSignal: "SIGKILL", windowsHide: true
		});
		if (result.error || result.status !== 0) return [];
		const pages = new Set();
		for (const line of String(result.stdout).split(/\r?\n/)) {
			const columns = line.trim().split(/\s+/);
			if (!/^\d+$/.test(columns[0] ?? "") || !/^\d+$/.test(columns[3] ?? "") || !/^\d+$/.test(columns[4] ?? "")) continue;
			const width = Number(columns[3]);
			const height = Number(columns[4]);
			if (width >= 280 && height >= 180) pages.add(Number(columns[0]));
		}
		return [...pages].sort((left, right) => left - right);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export function detectPdfFigureCandidates(pages, pdfBuffer) {
	const candidates = [];
	const seen = new Set();
	for (let pageIndex = 0; pageIndex < (pages ?? []).length; pageIndex += 1) {
		const text = String(pages[pageIndex] ?? "");
		for (const match of text.matchAll(FIGURE_LABEL_RE)) {
			const prefix = /^图$/u.test(match[1]) ? "图" : "Figure";
			const label = `${prefix} ${match[2]}`;
			const key = `${pageIndex + 1}:${label.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			candidates.push({
				id: `figure-${digest(key)}`,
				kind: "figure",
				page: pageIndex + 1,
				label,
				summary: compactContext(text, match.index ?? 0, match[0].length),
				source_locator: `PDF page ${pageIndex + 1}`,
				candidate_method: "caption",
				visual_status: "candidate"
			});
		}
	}
	for (const page of embeddedImagePages(pdfBuffer)) {
		if (candidates.some((item) => item.page === page)) continue;
		const key = `${page}:embedded-image`;
		candidates.push({
			id: `figure-${digest(key)}`, kind: "figure", page, label: "页面图像",
			summary: String(pages?.[page - 1] ?? "").replace(/\s+/g, " ").trim().slice(0, 520),
			source_locator: `PDF page ${page}`, candidate_method: "embedded-image", visual_status: "candidate"
		});
	}
	candidates.sort((left, right) => left.page - right.page || left.label.localeCompare(right.label));
	return candidates;
}
