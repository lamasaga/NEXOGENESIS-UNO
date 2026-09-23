import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { commitCard, loadCards, parseCardFile } from '../packages/nexogenesis-tools/lib/cards.js';
import { createDomainFromUnassignedCard, deleteUnassignedCard, listUnassignedCards } from '../packages/nexogenesis-tools/lib/uno/card-management.js';
import { readDomainGovernanceState, synchronizeUnassignedPool } from '../packages/nexogenesis-tools/lib/uno/domain-governance.js';
import { unoCardRef, unoMarkdown, unoRevision } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { listDomainsV2 } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { handleUnoApi } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'uno-card-management-'));for(const dir of ['01-Cards/_meta/domains','03-Archive','06-Journal','.nexogenesis'])mkdirSync(join(root,dir),{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function card(id,extra={}){return {id,title:id,type:'claim',maturity:'growing',lifecycle:'active',domains:[],origin:'document',sources:['05-Buffer/_index/unit.md'],relations:[],created:'2026-09-18',updated:'2026-09-18',body:'## 判断\n\n这是一张具有完整判断、依据与边界的测试卡片。',...extra};}

test('unassigned pool lists only explicit governance entries and excludes legacy domains-empty cards',t=>{
  const root=fixture(t);commitCard(root,card('a'));commitCard(root,card('b',{domains:['finance']}));
  assert.deepEqual(listUnassignedCards(root),[]);
  synchronizeUnassignedPool(root,{card_ids:['a']});
  const rows=listUnassignedCards(root);assert.deepEqual(rows.map(row=>row.id),['a']);assert.equal(rows[0].reason,'NO_MATCHING_DOMAIN');assert.match(rows[0].revision,/^[0-9a-f]{64}$/);
});

test('direct deletion archives the card and atomically cleans inbound and domain navigation references',t=>{
  const root=fixture(t);commitCard(root,card('target'));commitCard(root,card('source',{relations:[{target:'target',type:'supplement',note:'补充目标的适用边界。',basis:'source'}]}));
  const domainRef='01-Cards/_meta/domains/finance.md';writeFileSync(join(root,domainRef),unoMarkdown({schema:'uno-domain-v2',kind:'uno-domain-index',id:'finance',title:'金融',summary:'金融资源配置的长期问题空间。',core_questions:['资本如何配置？'],includes:['金融制度与融资'],excludes:['单一公司名录'],parents:[],representative_card_ids:['target'],lifecycle:'active',relations:[]},'金融领域正文。'));
  synchronizeUnassignedPool(root,{});const target=loadCards(root).get('target'),revision=unoRevision(root,unoCardRef(root,target));
  const input={key:'delete/target/'+revision,card_id:'target',expected_revision:revision,confirm_id:'target',reason:'测试删除'};
  const receipt=deleteUnassignedCard(root,input);
  assert.equal(receipt.card_id,'target');assert.equal(existsSync(join(root,'01-Cards/target.md')),false);assert.equal(existsSync(join(root,receipt.archived_ref)),true);
  assert.deepEqual(loadCards(root).get('source').meta.relations,[]);assert.deepEqual(parseCardFile(join(root,domainRef)).meta.representative_card_ids,[]);
  assert.equal(readDomainGovernanceState(root).unassigned.target,undefined);assert.deepEqual(deleteUnassignedCard(root,input),receipt);
});

test('direct deletion rejects assigned cards and stale confirmations',t=>{
  const root=fixture(t);commitCard(root,card('assigned',{domains:['finance']}));const current=loadCards(root).get('assigned'),revision=unoRevision(root,unoCardRef(root,current));
  assert.throws(()=>deleteUnassignedCard(root,{key:'delete/assigned',card_id:'assigned',expected_revision:revision,confirm_id:'assigned'}),/只能直接删除未组织池/);
  commitCard(root,card('open'));const open=loadCards(root).get('open'),openRevision=unoRevision(root,unoCardRef(root,open));
  assert.throws(()=>deleteUnassignedCard(root,{key:'delete/open',card_id:'open',expected_revision:openRevision,confirm_id:'wrong'}),/删除确认/);
  assert.throws(()=>deleteUnassignedCard(root,{key:'delete/open/confirmed',card_id:'open',expected_revision:openRevision,confirm_id:'open'}),/不在正式未组织池/);
});

test('manual governance creates a domain from one confirmed seed card through the Gateway',t=>{
  const root=fixture(t);commitCard(root,card('seed',{title:'土地利益分配机制'}));synchronizeUnassignedPool(root,{card_ids:['seed']});
  const revision=unoRevision(root,unoCardRef(root,loadCards(root).get('seed'))),input={key:'manual-domain/seed/request-1',card_id:'seed',expected_revision:revision,domain:{
    title:'土地制度与国家治理',summary:'研究土地制度如何塑造财政、社会结构与国家治理。',core_questions:['土地收益如何影响国家治理？'],includes:['土地制度、财政分配与基层治理'],excludes:['单一王朝事件名录'],
  }};
  const gateway=new HarnessGateway(root),receipt=gateway.createDomainFromUnassignedCard(input),replay=gateway.createDomainFromUnassignedCard(input);
  assert.deepEqual(replay,receipt);assert.deepEqual(receipt.card_ids,['seed']);assert.equal(receipt.domain_ids.length,1);
  assert.deepEqual(loadCards(root).get('seed').meta.domains,receipt.domain_ids);assert.deepEqual(listUnassignedCards(root),[]);
  const domain=listDomainsV2(root).find(row=>row.id===receipt.domain_ids[0]);assert.equal(domain.title,'土地制度与国家治理');assert.deepEqual(domain.representative_card_ids,['seed']);
});

test('manual seed-domain governance rejects card-title copies and generic containers',t=>{
  const root=fixture(t);commitCard(root,card('seed',{title:'土地利益分配机制'}));synchronizeUnassignedPool(root,{card_ids:['seed']});
  const revision=unoRevision(root,unoCardRef(root,loadCards(root).get('seed'))),base={card_id:'seed',expected_revision:revision};
  const definition=title=>({title,summary:'稳定问题空间。',core_questions:['如何演化？'],includes:['制度机制'],excludes:['事件名录']});
  assert.throws(()=>createDomainFromUnassignedCard(root,{...base,key:'manual-domain/copy',domain:definition('土地利益分配机制')}),/不能直接复用卡片标题/);
  assert.throws(()=>createDomainFromUnassignedCard(root,{...base,key:'manual-domain/generic',domain:definition('综合')}),/不能使用/);
});

for(const seedId of ['seed','seed with-space','中文卡片（案例）','literal%20value'])test(`unassigned-card API creates a domain for stable ID ${seedId}`,async t=>{
  const root=fixture(t);commitCard(root,card(seedId,{title:'土地利益分配机制'}));synchronizeUnassignedPool(root,{card_ids:[seedId]});
  const revision=unoRevision(root,unoCardRef(root,loadCards(root).get(seedId))),body={library_id:'legacy',expected_revision:revision,request_id:'request-1',domain:{
    title:'土地制度与国家治理',summary:'研究土地制度如何塑造财政、社会结构与国家治理。',core_questions:['土地收益如何影响国家治理？'],includes:['土地制度与财政分配'],excludes:['单一王朝事件名录']}};
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{url:'/api/uno/unassigned/'+encodeURIComponent(seedId)+'/create-domain',method:'POST',headers:{'content-type':'application/json'}});
  const res={data:'',setHeader(){},writeHead(status){this.status=status;},write(value){this.data+=value;},end(value=''){this.data+=value;}};
  await handleUnoApi({settings:{get:()=>({})}},req,res,root);
  const result=JSON.parse(res.data);assert.equal(res.status,200);assert.deepEqual(result.card_ids,[seedId]);assert.equal(listDomainsV2(root).length,1);
});

test('unassigned-card API decodes deletion target without changing its identity',async t=>{
  const root=fixture(t),id='中文 card%20（案例）';commitCard(root,card(id));synchronizeUnassignedPool(root,{card_ids:[id]});
  const revision=unoRevision(root,unoCardRef(root,loadCards(root).get(id)));
  const body={library_id:'legacy',expected_revision:revision,confirm_id:id};
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{url:'/api/uno/unassigned/'+encodeURIComponent(id),method:'DELETE',headers:{'content-type':'application/json'}});
  let result;await handleUnoApi({},req,{writeHead(status){assert.equal(status,200);},end(value){result=JSON.parse(value);}},root);
  assert.equal(result.card_id,id);assert.equal(loadCards(root).has(id),false);assert.ok(existsSync(join(root,result.archived_ref)));
});

test('unassigned-card routes reject unsafe IDs and malformed encoding before processing',async t=>{
  const root=fixture(t);
  for(const encoded of ['%ZZ','%E4%B8','..%2Foutside','..%5Coutside','%00','CON','trailing%20','trailing.']){
    for(const [method,suffix] of [['POST','/recompile'],['POST','/organize'],['POST','/create-domain'],['DELETE','']]){
      await assert.rejects(handleUnoApi({}, {url:'/api/uno/unassigned/'+encoded+suffix,method}, {},root),error=>error.status===400&&/卡片标识/.test(error.message));
    }
  }
  assert.equal(loadCards(root).size,0);
});
