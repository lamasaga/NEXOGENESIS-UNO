import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(path.join(root, file), 'utf8');
const contract = JSON.parse(read('deploy/clean-agent-distribution.json'));
const relativeLinks = text => [...text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)]
  .map(match => match[1])
  .filter(href => !/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href))
  .map(href => decodeURIComponent(href.split('#')[0].split('?')[0]))
  .filter(Boolean);

test('文档入口、顶层说明和使用文档归档的本地链接有效', () => {
  const files = ['README.md', 'deploy/README.md',
    ...readdirSync(path.join(root, 'docs')).filter(file => file.endsWith('.md')).map(file => `docs/${file}`),
    'docs/history/2026-09-12-模型连接验证.md', 'docs/history/2026-09-16-语音输入验证.md'];
  const missing = [];
  for (const file of files) {
    for (const href of relativeLinks(read(file))) {
      if (!existsSync(path.resolve(root, path.dirname(file), href))) missing.push(`${file} -> ${href}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('干净发行包含使用文档的直接链接目标及启动停止脚本', () => {
  const mapped = new Map(contract.mapped_files.map(item => [item.target, item.source]));
  const included = file => contract.include_files.includes(file) || mapped.has(file)
    || contract.include_trees.some(tree => file === tree || file.startsWith(`${tree}/`));
  const docs = ['README.md', 'docs/README.md', 'docs/UNO-使用指南.md', 'docs/UNO-模型连接.md',
    'docs/UNO-语音输入.md', 'docs/UNO-建构侧重与允许调整.md', 'deploy/README.md'];
  for (const file of [...docs, 'prepare-nexogenesis.ps1', 'start-nexogenesis.cmd', 'start-nexogenesis.ps1',
    'stop-nexogenesis.cmd', 'stop-nexogenesis.ps1']) {
    assert.ok(included(file), `发行缺少 ${file}`);
    assert.ok(existsSync(path.join(root, mapped.get(file) ?? file)), `源文件缺少 ${file}`);
  }
  for (const file of docs) {
    for (const href of relativeLinks(read(mapped.get(file) ?? file))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), href));
      assert.ok(included(target), `发行文档断链：${file} -> ${target}`);
    }
  }
});
