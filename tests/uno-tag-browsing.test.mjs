import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCardCatalog,buildGraphOverview,handleCardGet} from '../packages/nexogenesis-web-host/lib/graph.js';
import {searchKnowledge} from '../packages/nexogenesis-tools/lib/uno/knowledge.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'uno-classification-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'01-Cards/_meta/domains'),{recursive:true});
 writeFileSync(join(root,'01-Cards/_meta/domains/finance.md'),'---\nkind: uno-domain-index\nid: finance\ntitle: 金融\nparents: []\nrepresentative_card_ids: [legacy]\n---\n长期金融问题。');
 writeFileSync(join(root,'01-Cards/_meta/domains/venture-capital.md'),'---\nkind: uno-domain-index\nid: venture-capital\ntitle: 风险投资\nparents: [finance]\nrepresentative_card_ids: [vc]\n---\n风险投资的长期问题。');
 writeFileSync(join(root,'01-Cards/vc.md'),'---\nid: vc\ntitle: 分阶段投资机制\ntype: mechanism\ndomains: [venture-capital]\n---\n分阶段投资改变后续融资选择。');
 writeFileSync(join(root,'01-Cards/method.md'),'---\nid: method\ntitle: 比较方法\ntype: method\ndomains: []\n---\n比较不同制度条件。');
 const legacy='---\nid: legacy\ntitle: 历史标签卡\ntags: [机制, 图像处理]\n---\n历史正文保持原样。';
 writeFileSync(join(root,'01-Cards/legacy.md'),legacy);
 return {root,legacy};
}

test('catalog and graph use one display type plus card-owned domains',()=>{
 const {root,legacy}=fixture({after:()=>{}});
 try{
  assert.deepEqual(buildCardCatalog(root,{type:'mechanism'}).items.map(x=>x.id),['vc']);
  assert.deepEqual(buildCardCatalog(root,{domain:'finance'}).items.map(x=>x.id),['vc'],'parent filter includes child members but not representative-only cards');
  assert.deepEqual(buildCardCatalog(root,{domain:'venture-capital'}).items.map(x=>x.id),['vc']);
  const catalog=buildCardCatalog(root);
  assert.equal(catalog.facets.domains.find(x=>x.value==='venture-capital').count,1);
  assert.equal(catalog.facets.types.find(x=>x.value==='method').count,1);
  assert.equal(catalog.facets.tags,undefined);
  const overview=buildGraphOverview(root),counts=Object.fromEntries(overview.node_types.map(x=>[x.type,x.count]));
  assert.equal(overview.classification_scope,'ordered-single-type-and-domains-v2');
  assert.equal(counts.mechanism,1);assert.equal(counts.method,1);assert.equal(counts.model,1,'legacy tags are only a read compatibility display type');
  assert.equal(readFileSync(join(root,'01-Cards/legacy.md'),'utf8'),legacy);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('browser, detail and agent retrieval agree on type/domain and never expose legacy tags as membership',async t=>{
 const {root,legacy}=fixture(t);
 assert.deepEqual(searchKnowledge(root,{domain:'finance',kind:'card'}).items.map(x=>x.id),['vc']);
 assert.deepEqual(searchKnowledge(root,{type:'method',kind:'card'}).items.map(x=>x.id),['method']);
 let detail;await handleCardGet({},null,{writeHead(){},end(value){detail=JSON.parse(value);}},[],root,'vc');
 assert.equal(detail.type,'mechanism');assert.deepEqual(detail.domains,['venture-capital']);assert.equal(detail.tags,undefined);assert.equal(detail.topics,undefined);
 let legacyDetail;await handleCardGet({},null,{writeHead(){},end(value){legacyDetail=JSON.parse(value);}},[],root,'legacy');
 assert.equal(legacyDetail.type,'model');assert.deepEqual(legacyDetail.domains,[]);assert.equal(legacyDetail.tags,undefined);
 assert.equal(readFileSync(join(root,'01-Cards/legacy.md'),'utf8'),legacy);
});
