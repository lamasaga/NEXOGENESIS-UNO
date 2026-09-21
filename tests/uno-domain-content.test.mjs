import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/uno-knowledge.mjs';
import { listDomainsV2 } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { loadCards } from '../packages/nexogenesis-tools/lib/cards.js';
import { unoMarkdown } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { buildDomainEdges, domainReadingDetail } from '../packages/nexogenesis-web-host/lib/domain-view.js';
import { buildGraphEdges, handleCardGet, handleGraphGet } from '../packages/nexogenesis-web-host/lib/graph.js';

const definition = id => ({ id, title:'领域 ' + id, summary:'研究组织的信息与责任分配。', core_questions:['信息如何影响授权？'], includes:['授权与信息反馈'], excludes:['仅记录部门名称'] });
const relation = target => ({ target, type:'bridge', note:'从组织授权进入责任划分。', use_when:'需要比较授权之后的责任边界时。', limits:'不同制度的结果不能直接互推。', basis:'navigation', anchor_card_ids:[] });
function setup(t) {
  const f = fixture(t);
  for (const id of ['a','b','c']) f.gateway.writeDomain({ key:'create-' + id, ...definition(id), body:'保留人工说明 ' + id });
  f.put('01-Cards/member.md', unoMarkdown({id:'member',title:'代表卡',type:'concept',domains:['a'],relations:[],lifecycle:'active'},'独立的知识卡正文'));
  const read = id => listDomainsV2(f.root).find(domain => domain.id === id);
  const update = (id, patch, key = 'update-' + id) => f.gateway.writeDomain({ key, id, revision:read(id).revision, ...patch });
  return { ...f, read, update };
}

test('domain-only edits preserve definition and authored body; replay and stale revisions are safe', t => {
  const f=setup(t), before=f.read('a');
  const input={key:'link-a',id:'a',revision:before.revision,relations:[relation('b')]};
  const receipt=f.gateway.writeDomain(input);
  assert.deepEqual(f.gateway.writeDomain(input),receipt);
  const after=f.read('a');
  assert.equal(after.body,before.body);assert.deepEqual(after.core_questions,before.core_questions);
  assert.deepEqual(receipt.domain_ids,['a']);
  assert.equal(readFileSync(join(f.root,'03-Archive/card-history/domain-a',before.revision+'.md'),'utf8').includes('保留人工说明'),true);
  assert.throws(()=>f.gateway.writeDomain({...input,key:'stale',summary:'不能覆盖'}),/版本已变化/);
  f.update('a',{summary:'新的清晰范围'},'content-a');
  assert.deepEqual(f.read('a').relations,[relation('b')]);
});

test('domain A to B to C renders incoming and outgoing links without creating reverse assertions or member edges', async t => {
  const f=setup(t);f.update('a',{relations:[{...relation('b'),anchor_card_ids:['member']}],representative_card_ids:['member']});f.update('b',{relations:[relation('c')]});
  const domains=listDomainsV2(f.root), edges=buildDomainEdges(domains);
  assert.equal(edges.length,2);assert.equal(new Set(edges.map(edge=>edge.id)).size,2);
  assert.deepEqual(edges,buildDomainEdges([...domains].reverse()));
  assert.ok(edges.every(edge=>edge.id&&edge.kind===edge.relation_type&&edge.basis==='navigation'));
  assert.deepEqual(buildGraphEdges(f.root),[]);
  let detail;
  await handleCardGet({},null,{writeHead(){},end(text){detail=JSON.parse(text);}},[],f.root,'domain:b');
  assert.deepEqual(detail.relations.map(row=>[row.direction,row.target]),[['incoming','domain:a'],['outgoing','domain:c']]);
  assert.deepEqual(detail.domain_content.core_questions,['信息如何影响授权？']);
  assert.match(detail.body,/保留人工说明 b/);
  const scoped=domainReadingDetail(f.read('a'),domains,loadCards(f.root),id=>'kb:test:'+id);
  assert.equal(scoped.relations[0].target,'kb:test:domain:b');assert.equal(scoped.relations[0].anchors[0].id,'kb:test:member');
  assert.equal(scoped.domain_content.representative_cards[0].id,'kb:test:member');assert.equal(scoped.domain_content.member_count,1);
  const movedCards=new Map([['member',{meta:{title:'已经移到其他领域',domains:['c'],type:'concept'}}]]);
  assert.deepEqual(domainReadingDetail(f.read('a'),domains,movedCards).relations[0].anchors,[]);
  let graph;
  await handleGraphGet({},null,{writeHead(){},end(text){graph=JSON.parse(text);}},[],f.root);
  assert.equal(graph.edges.length,2);assert.ok(graph.edges.every(edge=>graph.nodes.some(n=>n.id===edge.from)&&graph.nodes.some(n=>n.id===edge.to)));
});

test('invalid domain relations fail without changing Markdown or members', t => {
  const f=setup(t), before=f.read('a').revision;
  const invalid=[{...relation('missing')},{...relation('a')},{...relation('b'),type:'causes'},{...relation('b'),basis:'source'},
    {...relation('b'),use_when:''},{...relation('b'),limits:''},{...relation('b'),anchor_card_ids:['unknown']}];
  invalid.forEach((row,index)=>assert.throws(()=>f.update('a',{relations:[row]},'invalid-'+index),/领域关系/));
  assert.throws(()=>f.update('a',{relations:[relation('b'),relation('b')]},'duplicate'),/重复/);
  assert.equal(f.read('a').revision,before);assert.deepEqual(loadCards(f.root).get('member').meta.domains,['a']);
});

test('definition contract is shared, parent cycles are rejected, hierarchy is separate from domain relations', t => {
  const f=setup(t);
  assert.throws(()=>f.update('a',{core_questions:[]}),/core_questions/);
  f.update('b',{parents:['a']});
  assert.throws(()=>f.update('a',{parents:['b']},'cycle'),/循环/);
  const domains=listDomainsV2(f.root);
  assert.equal(buildDomainEdges(domains)[0].kind,'domain-parent');
  assert.deepEqual(domainReadingDetail(f.read('b'),domains,loadCards(f.root)).relations,[]);
});

test('legacy definitions and short relations are readable and not silently rewritten', async t => {
  const f=setup(t);
  f.put('01-Cards/_meta/domains/legacy.md',unoMarkdown({id:'legacy',title:'历史领域',card_ids:['member'],relations:[{target:'b',type:'adjacent',note:'已有交界'}]},'完整的历史正文'));
  let detail;await handleCardGet({},null,{writeHead(){},end(text){detail=JSON.parse(text);}},[],f.root,'domain:legacy');
  assert.match(detail.body,/完整的历史正文/);assert.deepEqual(detail.domain_content.missing_fields,['summary','core_questions','includes','excludes']);
  assert.equal(detail.relations[0].note,'已有交界');assert.equal(detail.relations[0].use_when,undefined);
  assert.equal(detail.domain_content.representative_cards[0].id,'member');
});

test('retired domains and missing targets do not produce graph edges; a domain with hundreds of members has bounded detail', t => {
  const f=setup(t), domains=listDomainsV2(f.root);
  domains[0].relations=[relation('b'),relation('missing')];domains[1].lifecycle='retired';
  assert.deepEqual(buildDomainEdges(domains),[]);
  const cards=new Map(Array.from({length:600},(_,i)=>['m'+i,{meta:{title:'卡 '+i,domains:['a'],type:'concept'},body:'大段正文'.repeat(1000)}]));
  const detail=domainReadingDetail(domains[0],domains,cards);
  assert.equal(detail.domain_content.member_count,600);assert.ok(JSON.stringify(detail).length<2000);
});
