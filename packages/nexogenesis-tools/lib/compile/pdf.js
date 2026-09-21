import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMPILE_RESOURCE_LIMITS } from "./limits.js";

export class PdfExtractionError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/**
 * Extract the PDF text layer through Poppler's pdftotext.
 *
 * The bundled runtime already supplies this executable. A short-lived file is
 * necessary because this Poppler version does not accept PDF bytes on stdin.
 * No source copy is retained after extraction.
 */
export function extractPdf(buffer) {
	if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
		throw new PdfExtractionError("invalid_pdf", "文件不是有效的 PDF 容器。");
	}
	const directory = mkdtempSync(join(tmpdir(), "nexogenesis-pdf-"));
	const input = join(directory, "source.pdf");
	try {
		writeFileSync(input, buffer);
		const result = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", input, "-"], {
			encoding: "utf8", maxBuffer: COMPILE_RESOURCE_LIMITS.maxProcessOutputBytes,
			timeout: COMPILE_RESOURCE_LIMITS.processTimeoutMs, killSignal: "SIGKILL", windowsHide: true
		});
		if (result.error?.code === "ENOENT") {
			throw new PdfExtractionError("pdf_extractor_unavailable", "当前运行环境缺少 pdftotext，无法读取 PDF 文本层。");
		}
		if (result.error?.code === "ETIMEDOUT") throw new PdfExtractionError("pdf_extraction_timeout", "PDF 文本提取超过时间上限，子进程已终止。");
		if (result.error) throw new PdfExtractionError("pdf_extraction_failed", result.error.message);
		if (result.status !== 0) {
			throw new PdfExtractionError("pdf_extraction_failed", String(result.stderr || "pdftotext 未能读取该 PDF。").trim());
		}
		const pages = String(result.stdout ?? "").replace(/\r\n?/g, "\n").split("\f")
			.map((text) => text.trim()).filter(Boolean);
		if (!pages.length) {
			throw new PdfExtractionError("pdf_no_text_layer", "PDF 没有可提取的文本层，需先 OCR 后才能忠实编译。");
		}
		const firstLine = pages[0].split("\n").map((line) => line.trim()).find(Boolean) ?? "";
		return { title: firstLine.slice(0, 180), pages };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
