/** Immutable book evidence. Writes are called only by HarnessGateway. */
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseCardFile } from '../cards.js';
import { sha, unoPath, unoRevision, unoMarkdown, transaction, expect, readUnoReceipt } from '../harness/uno-storage.js';
import { BOOK_STORAGE_LAYOUT, BOOK_UNIT_REF as UNIT_REF } from './book-paths.js';
import { bookEvidencePath, bookEvidenceRevision } from './book-evidence.js';

export const BOOK_WORKFLOW = 'uno-unit-compile-v3';
export const LEGACY_BOOK_WORKFLOW = 'uno-unit-compile-v2';
export const BOOK_WORKFLOWS = Object.freeze([BOOK_WORKFLOW, LEGACY_BOOK_WORKFLOW]);
export const isBookWorkflow = value => BOOK_WORKFLOWS.includes(value);
export const BOOK_UNIT_TARGET_CHARS = 60000;
export const BOOK_UNIT_MAX_BYTES = 240000;
export const BOOK_UNIT_MAX_CHARS = 90000;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const count = text => Array.from(text).length;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function paragraphs(text) {
  const ends = []; let utf16 = 0, unicode = 0;
  for (const match of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
    const end = match.index + match[0].length;
    unicode += count(text.slice(utf16, end)); utf16 = end; ends.push(unicode);
  }
  const total = unicode + count(text.slice(utf16));
  if (ends.at(-1) !== total) ends.push(total);
  return ends;
}

// Physical delivery units preserve the exact text and original chapter identity.
// A paragraph that cannot fit is continued at a sentence boundary or hard cap;
// the author still decides semantic card boundaries across these units.
function splitChapter(chapter, unitCharLimit) {
  const chars = Array.from(chapter.text), ends = paragraphs(chapter.text), parts = [];
  let start = 0, boundary = 0;
  while (start < chars.length) {
    while (ends[boundary] <= start) boundary++;
    let cap = start, bytes = 0;
    while (cap < chars.length && cap - start < unitCharLimit) {
      const cp = chars[cap].codePointAt(0), size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (bytes + size > unitCharLimit * 4) break;
      bytes += size; cap++;
    }
    let end = cap, split_reason = cap === chars.length ? 'chapter-end' : 'hard-limit';
    if (cap < chars.length) {
      let next = boundary;
      while (ends[next + 1] <= cap) next++;
      const paragraphEnd = ends[next], minimum = start + Math.min(2000, Math.floor((cap - start) / 4));
      if (paragraphEnd > minimum && paragraphEnd <= cap) { end = paragraphEnd; split_reason = 'paragraph'; }
      else {
        for (let i = cap - 1; i >= minimum; i--) {
          if (/[。！？]/u.test(chars[i]) || /[.!?]/.test(chars[i]) && (i + 1 === chars.length || /\s/u.test(chars[i + 1]))) {
            end = i + 1; split_reason = 'sentence'; break;
          }
        }
      }
    }
    parts.push({ start, end, text: chars.slice(start, end).join(''), continuation: { from_previous: start > 0, to_next: end < chars.length, split_reason } });
    start = end;
  }
  return parts;
}

function immutableWrite(root, writes, ref, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (existsSync(unoPath(root, ref))) {
    if (!readFileSync(unoPath(root, ref)).equals(bytes)) fail('IMMUTABLE_SOURCE_CONFLICT', '不可变原件或提取版本已经被改写：' + ref);
  } else writes.set(ref, bytes);
}

export function prepareBookSource(root, { source, prepared, unit_char_limit = BOOK_UNIT_TARGET_CHARS }) {
  if (!Number.isInteger(unit_char_limit) || unit_char_limit < 12000 || unit_char_limit > BOOK_UNIT_MAX_CHARS)
    fail('INVALID_SOURCE', `原文单元字符上限须为 12000–${BOOK_UNIT_MAX_CHARS}。`);
  if (typeof source !== 'string' || !source.startsWith('00-Inbox/')) fail('INVALID_SOURCE', '图书必须来自当前知识库 Inbox。');
  const original = readFileSync(unoPath(root, source)), sourceRevision = sha(original);
  if (!prepared || prepared.fingerprint !== sourceRevision) fail('REVISION_CONFLICT', '预处理结果与原书当前版本不一致。');
  if (!Array.isArray(prepared.chapters) || !prepared.chapters.length || prepared.chapters.length > 10000)
    fail('INVALID_SOURCE', '预处理结果缺少章节。');
  const chapters = prepared.chapters.map((row, chapter_index) => {
    if (!row || typeof row.text !== 'string' || !row.text.trim()) fail('INVALID_SOURCE', '章节正文为空：' + (chapter_index + 1));
    const { text, title, locator, ...metadata } = row;
    return { title: String(title || `第 ${chapter_index + 1} 章`), locator: String(locator ?? ''), text, metadata };
  });
  if (chapters.reduce((total, row) => total + count(row.text), 0) > 5000000) fail('INVALID_SOURCE', '提取文本超过 500 万 Unicode 字符。');
  if (prepared.warnings !== undefined && (!Array.isArray(prepared.warnings) || prepared.warnings.some(row => typeof row !== 'string')))
    fail('INVALID_SOURCE', '提取警告须为文字数组。');
  if (prepared.assets !== undefined && (!Array.isArray(prepared.assets) || prepared.assets.length > 64)) fail('INVALID_SOURCE', '图片数量无效。');
  let assetBytes = 0;
  const assets = (prepared.assets ?? []).map((asset, index) => {
    if (!asset || typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data))
      fail('INVALID_SOURCE', '图片数据不是有效的 base64。');
    const bytes = Buffer.from(asset.data, 'base64'); assetBytes += bytes.length;
    if (!bytes.length || assetBytes > 20 * 1024 * 1024) fail('INVALID_SOURCE', '图片为空或总大小超过 20 MiB。');
    const { data, ...metadata } = asset;
    return { metadata, bytes, hash: sha(bytes), name: `${String(index + 1).padStart(3, '0')}-${String(asset.name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_')}` };
  });
  const extension = /^\.[a-zA-Z0-9]{1,10}$/.test(extname(source)) ? extname(source).toLowerCase() : '.bin';
  const sourceRef = `03-Archive/books/${sourceRevision}/original${extension}`;
  const title = String(prepared.title || basename(source, extname(source)));
  const descriptor = canonical({ version: 1, source_ref: sourceRef, title, chapters,
    unit_segmentation: { version: 5, max_chars: unit_char_limit, max_utf8_bytes: unit_char_limit * 4 },
    format: prepared.format ?? '', source_metadata: prepared.source_metadata ?? '',
    segmentation: prepared.segmentation ?? null, changes: prepared.changes ?? {}, incomplete: prepared.incomplete === true,
    warnings: prepared.warnings ?? [], external_images: prepared.external_images ?? [],
    assets: assets.map(({ metadata, hash, name }) => ({ ...metadata, name, hash })) });
  const extractionRevision = sha(JSON.stringify(descriptor));
  const base = `05-Buffer/books/${sourceRevision}/${extractionRevision}`;
  const legacyBase = `03-Archive/books/${sourceRevision}/${extractionRevision}`;
  const existingCatalog = existsSync(unoPath(root, base + '/catalog.md')) ? parseCardFile(unoPath(root, base + '/catalog.md')) : null;
  const legacyRepresentation = existingCatalog?.meta.units?.length > 0
    && existingCatalog.meta.units.every(unit => typeof unit.ref === 'string' && unit.ref.startsWith(legacyBase + '/units/'));
  const archivedAssets = assets.map(({ metadata, hash, name }) => ({ ...metadata, ref: `${base}/assets/${name}`, sha256: hash }));
  const evidenceAssets = legacyRepresentation ? archivedAssets.map(asset => ({ ...asset, ref: asset.ref.replace(base, legacyBase) })) : archivedAssets;
  const warnings = [...descriptor.warnings];
  const records = [], units = [];
  for (const [chapter_index, chapter] of chapters.entries()) {
    const pieces = splitChapter(chapter, unit_char_limit);
    if (pieces.some(piece => ['sentence', 'hard-limit'].includes(piece.continuation.split_reason)))
      warnings.push(`${chapter.title} 含超长段落，已按句尾或物理上限连续分块，完整原文无删减；同章各块需连贯理解。`);
    for (const [index, piece] of pieces.entries()) {
      const id = `c${String(chapter_index + 1).padStart(4, '0')}-p${String(index + 1).padStart(3, '0')}`;
      const ref = `${base}/units/${id}.md`;
      const locator = `${chapter.locator}${chapter.locator ? '；' : ''}章内 Unicode 字符 ${piece.start}–${piece.end}；同章 ${index + 1}/${pieces.length} 段`;
      const metadata = { kind: 'uno-book-unit-v1', unit_id: id, source_ref: sourceRef, source_revision: sourceRevision,
        extraction_revision: extractionRevision, title: chapter.title, locator, chapter_locator: chapter.locator,
        chapter_index, chapter_start: piece.start, chapter_end: piece.end, part: index + 1, parts: pieces.length,
        continuation: { ...piece.continuation, from_previous: piece.continuation.from_previous || chapter.metadata.continuation?.from_previous === true,
          to_next: piece.continuation.to_next || chapter.metadata.continuation?.to_next === true }, utf8_bytes: Buffer.byteLength(piece.text),
        chapter_metadata: chapter.metadata, chars: count(piece.text), content_revision: sha(piece.text),
        format: descriptor.format, source_metadata: descriptor.source_metadata, incomplete: descriptor.incomplete,
        warnings: descriptor.warnings, asset_scope: 'unit', assets: assetsForBookUnit(evidenceAssets, piece.text, chapter.metadata), external_images: descriptor.external_images };
      const markdown = unoMarkdown(metadata, piece.text);
      records.push({ ref, markdown });
      units.push({ id, ref, title: chapter.title, locator, chapter_index, part: index + 1, parts: pieces.length,
        continuation: metadata.continuation, utf8_bytes: metadata.utf8_bytes,
        chapter_start: piece.start, chapter_end: piece.end, chars: metadata.chars, revision: sha(markdown),
        content_revision: metadata.content_revision, source_ref: sourceRef, source_revision: sourceRevision,
        extraction_revision: extractionRevision });
    }
  }
  const catalogRef = `${base}/catalog.md`;
  const catalogUnits = legacyRepresentation ? units.map(unit => ({ ...unit, ref: unit.ref.replace(base, legacyBase) })) : units;
  const catalog = unoMarkdown({ kind: 'uno-book-catalog-v1', source_ref: sourceRef, source_revision: sourceRevision,
    extraction_revision: extractionRevision, title, format: descriptor.format, source_metadata: descriptor.source_metadata,
    warnings, incomplete: descriptor.incomplete, unit_segmentation:descriptor.unit_segmentation,
    assets: evidenceAssets, external_images: descriptor.external_images, units: catalogUnits },
  catalogUnits.map(unit => `- [${unit.title} · ${unit.part}/${unit.parts}](${unit.ref}) — ${unit.locator}`).join('\n'));
  const key = `book-source-buffer-v1:${sourceRevision}:${extractionRevision}:${sha(source).slice(0, 16)}`;
  // Even a replay detects external alteration of a supposedly immutable archive.
  const verify = () => {
    const writes = new Map();
    expect(root, { [source]: sourceRevision });
    immutableWrite(root, writes, sourceRef, original);
    for (const row of records) immutableWrite(root, writes, row.ref, row.markdown);
    assets.forEach((asset, index) => immutableWrite(root, writes, archivedAssets[index].ref, asset.bytes));
    immutableWrite(root, writes, catalogRef, catalog);
    return writes;
  };
  const missing = verify();
  if (readUnoReceipt(root, key) && missing.size) fail('STALE_EVIDENCE', '已保全的图书版本缺少文件，不能把历史回执当作当前原件完整。');
  return transaction(root, key, { source, source_revision: sourceRevision, extraction_revision: extractionRevision }, () => ({
    writes: verify(), result: { summary: `保全图书 ${title} 与 ${units.length} 个原文单元`, card_ids: [], source, storage_layout: BOOK_STORAGE_LAYOUT,
      source_ref: sourceRef, source_revision: sourceRevision, extraction_revision: extractionRevision,
      title, units, warnings, assets: archivedAssets, external_images: descriptor.external_images,
      incomplete: descriptor.incomplete, catalog_ref: catalogRef }
  }));
}

export function bookUnitDescriptor(job, ref) {
  const units = Array.isArray(job?.book_units) ? job.book_units : [];
  return units.find(unit => (typeof unit === 'string' ? unit : unit?.ref) === ref);
}

export function inspectBookUnit(root, job, ref) {
  const expected = bookUnitDescriptor(job, ref), match = typeof ref === 'string' && UNIT_REF.exec(ref);
  if (!expected || !match) fail('SCOPE_VIOLATION', '来源不在本任务图书范围内：' + ref);
  const parsed = parseCardFile(bookEvidencePath(root, ref)), revision = bookEvidenceRevision(root, ref), contentRevision = sha(parsed.body);
  if (parsed.meta.kind !== 'uno-book-unit-v1' || parsed.meta.source_revision !== match[1]
    || parsed.meta.extraction_revision !== match[2] || parsed.meta.unit_id !== match[3]
    || parsed.meta.content_revision !== contentRevision || parsed.meta.chars !== count(parsed.body)
    || expected.revision && expected.revision !== revision
    || expected.content_revision && expected.content_revision !== contentRevision)
    fail('STALE_EVIDENCE', '图书原文版本或定位已变化：' + ref);
  if (typeof parsed.meta.source_ref !== 'string' || !parsed.meta.source_ref.startsWith(`03-Archive/books/${match[1]}/`)
    || unoRevision(root, parsed.meta.source_ref) !== match[1]) fail('STALE_EVIDENCE', '图书原件已变化或缺失。');
  return { ...parsed, ref, revision, content_revision: contentRevision };
}

export function readBookUnit(root, job, { ref, offset = 0, limit = 18000 }) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000)
    fail('INVALID_ARGUMENTS', '原文 offset 须为非负整数，limit 为 1–24000 Unicode 字符。');
  const row = inspectBookUnit(root, job, ref), chars = Array.from(row.body), end = Math.min(chars.length, offset + limit);
  if (offset > chars.length) fail('INVALID_ARGUMENTS', '原文 offset 超出正文。');
  return { ref, title: row.meta.title, locator: row.meta.locator, revision: row.revision,
    content_revision: row.content_revision, source_ref: row.meta.source_ref,
    source_revision: row.meta.source_revision, extraction_revision: row.meta.extraction_revision,
    text: chars.slice(offset, end).join(''), offset, end, total: chars.length, total_chars: chars.length,
    next_offset: end < chars.length ? end : null, unit: 'Unicode characters',
    chapter_index: row.meta.chapter_index, part: row.meta.part, parts: row.meta.parts,
    chapter_start: row.meta.chapter_start, chapter_end: row.meta.chapter_end, continuation: row.meta.continuation,
    chapter_metadata: row.meta.chapter_metadata, warnings: row.meta.warnings ?? [],
    incomplete: row.meta.incomplete, assets: row.meta.assets ?? [], external_images: row.meta.external_images ?? [] };
}

/** A book owns its image inventory; that does not make every image chapter evidence. */
export function assetsForBookUnit(assets, body, metadata = {}) {
 const pages = new Set(metadata.physical_pages ?? []);
 const links = [...String(body).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1]);
 return assets.filter(asset=> {
  const imagePages=[...String(asset.locator??'').matchAll(/(?:物理页|PDF(?: physical)? page)\s*(\d+)/g)].map(m=>Number(m[1]));
  return imagePages.some(p=>pages.has(p)) || links.some(link=>link===asset.ref || link===asset.name || link.split('/').at(-1)===asset.name);
 });
}
