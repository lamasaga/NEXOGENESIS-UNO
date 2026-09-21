import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { auditSourceCoverage, inspectSourceMap, readSourceSlice } from "../packages/nexogenesis-tools/lib/compile/source-ledger.js";

function storedZip(entries) {
	let offset = 0;
	const localRecords = [];
	const directoryRecords = [];
	for (const [name, value, compression = 0] of entries) {
		const nameBytes = Buffer.from(name, "utf8");
		const original = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
		const body = compression === 8 ? deflateRawSync(original) : original;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034B50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(compression, 8);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(original.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);
		localRecords.push(local, nameBytes, body);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014B50, 0);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(0, 8);
		directory.writeUInt16LE(compression, 10);
		directory.writeUInt32LE(body.length, 20);
		directory.writeUInt32LE(original.length, 24);
		directory.writeUInt16LE(nameBytes.length, 28);
		directory.writeUInt32LE(offset, 42);
		directoryRecords.push(directory, nameBytes);
		offset += local.length + nameBytes.length + body.length;
	}
	const directory = Buffer.concat(directoryRecords);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054B50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localRecords, directory, end]);
}

const source = `# 总论

  这是一段用于说明研究问题、论证范围和关键限制的长段落。它包含 2025 年的观察数据，也说明结论不能无条件外推到所有情况。为了形成语义清单，这段文字需要达到足够长度并成为独立 passage。

## 证据

| 指标 | 数值 |
|---|---|
| 样本 | 128 |

![关键机制图](figures/mechanism.png)
`;

const map = inspectSourceMap(source);
assert.equal(map.format.parseable, true);
assert.match(map.fingerprint, /^[a-f0-9]{64}$/, "来源清单必须返回可供 Harness 核验的完整 SHA-256");
assert.ok(map.items.some((item) => item.kind === "passage"));
assert.ok(map.items.some((item) => item.kind === "figure"));
assert.ok(map.items.some((item) => item.kind === "table-row"));
const required = map.items.filter((item) => ["passage", "figure", "table-row"].includes(item.kind));
const partial = auditSourceCoverage(map, [required[0].id]);
assert.equal(partial.complete, false);
const complete = auditSourceCoverage(map, required.map((item) => item.id));
assert.equal(complete.complete, true);
const slice = readSourceSlice(source.repeat(100), 0, 50000);
assert.ok(slice.content.length <= 6000, "按需读取硬上限为 6000 字");

const epub = storedZip([
	["mimetype", "application/epub+zip"],
	["META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`],
	["OEBPS/content.opf", `<?xml version="1.0"?><package><metadata><dc:title xmlns:dc="urn:test">测试书</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="nav"/><itemref idref="chapter-1"/></spine></package>`, 8],
	["OEBPS/nav.xhtml", "<html><body><nav>目录</nav></body></html>"],
	["OEBPS/chapter-1.xhtml", `<html><body><h1>第一章 货币机制</h1><p>这一章说明中央银行如何通过最后贷款人机制稳定金融体系，并同时保留流动性约束、资产负债表风险和制度边界，避免把短期救助误写成无条件担保。</p><table><tr><th>工具</th><th>作用</th></tr><tr><td>贴现窗口</td><td>提供流动性</td></tr></table><img src="images/figure-1.png" alt="流动性机制图"/></body></html>`, 8],
	["OEBPS/images/figure-1.png", Buffer.from([0x89, 0x50, 0x4E, 0x47])]
]);
const epubMap = inspectSourceMap(epub, { path: "book.epub" });
assert.equal(epubMap.format.kind, "epub");
assert.equal(epubMap.format.parseable, true, JSON.stringify(epubMap.format));
assert.equal(epubMap.title, "测试书");
assert.equal(epubMap.chapters.length, 1, "nav 不应被当作正文");
assert.ok(epubMap.items.some((item) => item.kind === "heading" && item.source_locator?.includes("OEBPS/chapter-1.xhtml")));
assert.ok(epubMap.items.some((item) => item.kind === "figure" && item.source === "epub-resource:OEBPS/images/figure-1.png"));
assert.ok(epubMap.items.some((item) => item.kind === "table-row"));
const epubSlice = readSourceSlice(epub, 0, 6000, { path: "book.epub" });
assert.match(epubSlice.content, /最后贷款人机制/);
assert.deepEqual(epubSlice.source_locators, ["EPUB spine 1 / OEBPS/chapter-1.xhtml"]);

const brokenEpub = inspectSourceMap(Buffer.from("PK\x03\x04 not really an epub"), { path: "broken.epub" });
assert.equal(brokenEpub.format.parseable, false);
assert.equal(brokenEpub.format.kind, "epub");
assert.equal(brokenEpub.items.length, 0, "损坏 EPUB 不得产生伪正文索引");

function minimalPdf(text) {
	const stream = `BT\n/F1 16 Tf\n72 720 Td\n(${String(text).replace(/[\\()]/g, "\\$&")}) Tj\nET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index += 1) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "utf8");
}

const pdf = minimalPdf("PDF text layer proves that page-level evidence can be read.");
const pdfMap = inspectSourceMap(pdf, { path: "text-layer.pdf" });
assert.equal(pdfMap.format.kind, "pdf");
assert.equal(pdfMap.format.parseable, true, JSON.stringify(pdfMap.format));
assert.equal(pdfMap.chapters.length, 1);
assert.equal(pdfMap.chapters[0].source_locator, "PDF page 1");
const pdfSlice = readSourceSlice(pdf, 0, 6000, { path: "text-layer.pdf" });
assert.match(pdfSlice.content, /PDF text layer proves/);
assert.deepEqual(pdfSlice.source_locators, ["PDF page 1"]);
console.log("PASS source ledger: 文本索引、EPUB/PDF 提取、来源定位、覆盖审计、按需读取硬上限");
