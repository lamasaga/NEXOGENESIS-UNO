import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handleInboxUpload, MAX_INBOX_BYTES, MAX_INBOX_FILE_BYTES } from '../packages/nexogenesis-web-host/lib/inbox.js';

async function upload(root, files, headers = {}) {
  const form = new FormData();
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  const request = new Request('http://localhost/api/inbox', {method: 'POST', body: form});
  const body=Buffer.from(await request.arrayBuffer()),req = Readable.from([body]);
  req.headers = {'content-type': request.headers.get('content-type'), 'content-length':String(body.length), ...headers};
  let result;
  await handleInboxUpload(null, req, {writeHead(status) { assert.equal(status, 200); }, end(body) { result = JSON.parse(body); }}, [], root);
  return result;
}

test('Inbox upload admits files of at least 200 MiB and retains bounded multipart overhead', () => {
  assert.ok(MAX_INBOX_FILE_BYTES >= 200 * 1024 * 1024);
  assert.equal(MAX_INBOX_FILE_BYTES, 256 * 1024 * 1024);
  assert.equal(MAX_INBOX_BYTES, MAX_INBOX_FILE_BYTES + 2 * 1024 * 1024);
});

test('1,400 small Chinese documents receive individual receipts and identical retry saves no duplicate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uno-upload-many-'));
  try {
    const files = Array.from({length: 1400}, (_, i) => [`第${i}篇_小文档.md`, `合成正文 ${i}\r\n`]);
    const first = await upload(root, files);
    assert.equal(first.saved.length, 1400); assert.equal(first.items.length, 1400);
    assert.equal(readdirSync(join(root, '00-Inbox')).length, 1400);
    const repeat = await upload(root, files);
    assert.equal(repeat.saved.length, 0);
    assert.equal(repeat.items.filter(item => item.status === 'existing').length, 1400);
    assert.equal(readdirSync(join(root, '00-Inbox')).length, 1400);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('a conflicting file, invalid name and long name do not discard other documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uno-upload-partial-'));
  try {
    mkdirSync(join(root, '00-Inbox'));
    writeFileSync(join(root, '00-Inbox', '冲突.md'), '原文件');
    const result = await upload(root, [['好文件.md', '有效正文'], ['冲突.md', '不同正文'], ['...', '无效'], ['很长的标题'.repeat(60) + '.md', '长标题正文']]);
    assert.deepEqual(result.items.map(item => item.status), ['saved', 'failed', 'failed', 'saved']);
    assert.equal(readFileSync(join(root, '00-Inbox', '冲突.md'), 'utf8'), '原文件');
    assert.equal(readFileSync(join(root, '00-Inbox', '好文件.md'), 'utf8'), '有效正文');
    assert.ok(result.saved[1].endsWith('.md')); assert.ok(result.saved[1].length <= 180);
    assert.equal(readdirSync(join(root, '00-Inbox')).length, 3);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('changing libraries does not redirect the remaining upload into the new library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uno-upload-scope-'));
  try {
    await assert.rejects(() => upload(root, [['a.md', 'scope']], {'x-nexogenesis-instance': 'another-library'}), error => error.status === 409);
    assert.ok(!readdirSync(root).includes('00-Inbox'));
  } finally { rmSync(root, {recursive: true, force: true}); }
});
