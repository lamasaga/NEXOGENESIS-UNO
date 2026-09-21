import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInstanceContext, createKnowledgeInstance, unregisterKnowledgeInstance } from '../packages/nexogenesis-tools/lib/instances/registry.js';
import { createProjectRecord, patchConversationExt, setMetaInstanceId, readMeta } from '../packages/nexogenesis-web-host/lib/meta.js';
import { projectKnowledge, saveProjectKnowledge, conversationKnowledge, collectProjectKnowledge, resolveKnowledgeRef } from '../packages/nexogenesis-web-host/lib/project-knowledge.js';
import { handleCardGet } from '../packages/nexogenesis-web-host/lib/graph.js';

test('项目多库选择持久化、隔离、去重、空选和无效库校验', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uno-linked-')), previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'runtime'); setMetaInstanceId('legacy');
  mkdirSync(join(root, '01-Cards'));
  const registry = join(root, '.nexogenesis/instances.json');
  configureInstanceContext({ registryPath: registry, fallbackRoot: root });
  const other = createKnowledgeInstance(registry, join(root, 'instances'), '对照知识库');
  const p = createProjectRecord('研究项目'), q = createProjectRecord('其他项目');
  patchConversationExt('chat', { project_id: p.id });
  try {
    assert.deepEqual(projectKnowledge(root, p.id).knowledge_instance_ids, ['legacy']);
    assert.equal(conversationKnowledge(root, 'chat'), null);
    saveProjectKnowledge(root, p.id, ['legacy', other.id, other.id]);
    assert.deepEqual(projectKnowledge(root, q.id).knowledge_instance_ids, ['legacy']);
    assert.deepEqual(readMeta().projects[p.id].knowledge_instance_ids, ['legacy', other.id]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'runtime/nexogenesis-meta.json'), 'utf8')).projects[p.id].knowledge_instance_ids, ['legacy', other.id]);
    assert.throws(() => saveProjectKnowledge(root, p.id, ['../outside']), /已登记/);
    assert.throws(() => saveProjectKnowledge(root, 'missing', []), /不存在/);
    const selection = conversationKnowledge(root, 'chat');
    saveProjectKnowledge(root, p.id, []);
    assert.equal(selection.length, 2, '本轮已捕获的范围不受下一轮设置影响');
    let reads = 0;
    assert.deepEqual(await collectProjectKnowledge(root, '查询', 'explain', conversationKnowledge(root, 'chat'), () => { reads++; return []; }), []);
    assert.equal(reads, 0);
    for (const [dir, text] of [[root, '甲库的信用机制'], [other.root, '乙库的信用机制']]) {
      writeFileSync(join(dir, '01-Cards/same.md'), `---\nid: same\ntitle: 信用机制\ntags: [机制]\nsummary: ${text}\nrelations:\n  - target: detail\n    type: supplement\n    note: 补充来源条件\n---\n${text}\n`);
      writeFileSync(join(dir, '01-Cards/detail.md'), '---\nid: detail\ntitle: 信用条件\ntags: [观点]\n---\n信用的条件。');
    }
    const packets = await collectProjectKnowledge(root, '信用', 'explain', selection);
    assert.ok(packets.some(c => c.id === 'kb:legacy:same' && c.text.includes('甲库')));
    assert.ok(packets.some(c => c.id === `kb:${other.id}:same` && c.text.includes('乙库')));
    assert.ok(packets.every(c => c.links.every(l => l.from.startsWith(`kb:${c.knowledge_base.id}:`) && l.to.startsWith(`kb:${c.knowledge_base.id}:`))));
    const bounded = await collectProjectKnowledge(root, '', 'explain', selection, () => Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: '标题', text: 'x'.repeat(1700) })));
    assert.ok(JSON.stringify(bounded).length <= 22000);
    assert.deepEqual(bounded.slice(0, 2).map(c => c.knowledge_base.id), ['legacy', other.id]);
    assert.equal(resolveKnowledgeRef(root, `kb:${other.id}:same`).root, other.root);
    let detail;
    await handleCardGet(null, null, { writeHead() {}, end(s) { detail = JSON.parse(s); } }, [], root, `kb:${other.id}:same`);
    assert.equal(detail.id, `kb:${other.id}:same`); assert.match(detail.body, /乙库/);
    assert.equal(detail.relations[0].target, `kb:${other.id}:detail`);
    saveProjectKnowledge(root, p.id, [other.id]);
    const one = await collectProjectKnowledge(root, '信用', 'explain', conversationKnowledge(root, 'chat'));
    assert.ok(one.length > 0); assert.ok(one.every(c => c.knowledge_base.id === other.id));
    unregisterKnowledgeInstance(registry, other.id);
    assert.throws(() => conversationKnowledge(root, 'chat'), /已移除/);
    assert.throws(() => resolveKnowledgeRef(root, `kb:${other.id}:same`), /已移除/);
  } finally { previousHome === undefined ? delete process.env.DSH_HOME : process.env.DSH_HOME = previousHome; }
});
