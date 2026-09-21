import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { parseCardFile } from '../cards.js';
import { unoPath, unoRevision, sha, expect, transaction, readUnoReceipt } from '../harness/uno-storage.js';
import { inspectBookUnit } from './book-sources.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function assertIdle(root) {
  const dir = unoPath(root, '.nexogenesis/uno-jobs');
  if (existsSync(dir) && readdirSync(dir).filter(n => n.endsWith('.json')).some(n => JSON.parse(readFileSync(unoPath(root, '.nexogenesis/uno-jobs/' + n), 'utf8')).status === 'running'))
    fail('TASK_RUNNING', '知识库仍有运行中的任务，不能迁移原文。');
}
function removeEmptyFolders(root, base) {
  for (const ref of [base + '/units', base + '/assets', base]) {
    const path = unoPath(root, ref);
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  }
}
export function migrateBookMaterialStorage(root, { catalog_ref, revision, check_only = false }) {
  const match = /^03-Archive\/books\/([a-f0-9]{64})\/([a-f0-9]{64})\/catalog\.md$/.exec(catalog_ref ?? '');
  if (!match || !/^[a-f0-9]{64}$/.test(revision ?? '')) fail('INVALID_ARGUMENTS', '迁移需要现有图书目录路径与版本。');
  const base = catalog_ref.slice(0, -'/catalog.md'.length), key = 'book-storage-buffer-v1:' + sha(catalog_ref + ':' + revision);
  const input = { catalog_ref, revision }, previous = readUnoReceipt(root, key);
  if (previous) {
    for (const file of previous.files) {
      if (unoRevision(root, file.to) !== file.revision || existsSync(unoPath(root, file.from))) fail('STORAGE_CONFLICT', '迁移后文件已变化，不能沿用旧收据。');
    }
    if (!check_only) removeEmptyFolders(root, base);
    return previous;
  }
  const plan = () => {
    assertIdle(root); expect(root, { [catalog_ref]: revision });
    const catalog = parseCardFile(unoPath(root, catalog_ref));
    if (catalog.meta.kind !== 'uno-book-catalog-v1' || catalog.meta.source_revision !== match[1] || catalog.meta.extraction_revision !== match[2]
      || !Array.isArray(catalog.meta.units) || !catalog.meta.units.length || unoRevision(root, catalog.meta.source_ref) !== match[1]) fail('STALE_EVIDENCE', '图书目录或原件未通过版本核验。');
    const expected = new Map([[catalog_ref, revision]]);
    for (const unit of catalog.meta.units) {
      if (!unit.ref.startsWith(base + '/units/')) fail('SCOPE_VIOLATION', '目录包含其他提取版本的单元。');
      const actual = inspectBookUnit(root, { book_units: catalog.meta.units }, unit.ref);
      expected.set(unit.ref, actual.revision);
    }
    for (const asset of catalog.meta.assets ?? []) {
      if (typeof asset.ref !== 'string' || !asset.ref.startsWith(base + '/assets/') || unoRevision(root, asset.ref) !== asset.sha256) fail('STALE_EVIDENCE', '提取图片未通过范围或版本核验。');
      expected.set(asset.ref, asset.sha256);
    }
    const walk = ref => readdirSync(unoPath(root, ref), { withFileTypes: true }).flatMap(entry => {
      const child = ref + '/' + entry.name; unoPath(root, child);
      return entry.isDirectory() ? walk(child) : [child];
    });
    if (walk(base).some(ref => !expected.has(ref))) fail('UNEXPECTED_FILE', '提取目录含未登记文件，不能自动移动。');
    const files = [...expected].map(([from, revision]) => ({ from, to: from.replace(/^03-Archive\//, '05-Buffer/'), revision }));
    const writes = new Map();
    for (const file of files) {
      expect(root, { [file.from]: file.revision });
      const target = unoRevision(root, file.to);
      if (target !== null && target !== file.revision) fail('STORAGE_CONFLICT', 'Buffer 已有不同版本文件：' + file.to);
      writes.set(file.to, readFileSync(unoPath(root, file.from))); writes.set(file.from, null);
    }
    return { writes, result: { summary: `整理图书材料：${catalog.meta.title}`, title: catalog.meta.title,
      catalog_ref, target_catalog_ref: catalog_ref.replace(/^03-Archive\//, '05-Buffer/'), files,
      file_count: files.length, unit_count: catalog.meta.units.length, card_ids: [], storage_layout: 'buffer-book-units-v1' } };
  };
  if (check_only) return plan().result;
  const receipt = transaction(root, key, input, plan);
  removeEmptyFolders(root, base);
  return receipt;
}
