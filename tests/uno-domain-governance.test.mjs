import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitCard, loadCards } from '../packages/nexogenesis-tools/lib/cards.js';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { listDomainsV2 } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { unoCardRef, unoRevision } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { buildDomainGovernancePackage, domainCheckpointDue, readDomainGovernanceState, recordDomainUnit,
  synchronizeUnassignedPool, validateDomainGovernanceResult } from '../packages/nexogenesis-tools/lib/uno/domain-governance.js';
import { runDomainGovernanceCheckpoint } from '../packages/nexogenesis-web-host/lib/book-compile.js';
import { readCompileJob, saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';

function fixture(t) { const root=mkdtempSync(join(tmpdir(),'uno-domain-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'01-Cards'),{recursive:true});return root; }
function card(id,domains=[]){return {id,title:'国家治理机制 '+id,type:'mechanism',domains,origin:'system',maturity:'growing',lifecycle:'active',sources:['source-'+id],relations:[],created:'2026-09-18',updated:'2026-09-18',body:'## 核心机制\n权力配置改变信息与执行激励。\n\n## 成立条件\n组织拥有明确授权。\n\n## 失效边界\n不适用于没有正式组织的情形。\n\n## 来源与证据边界\n仅概括本材料。'};}

test('unassigned pool is a rebuildable projection and checkpoint waits for a meaningful batch',t=>{
  const root=fixture(t);for(let i=0;i<10;i++)commitCard(root,card('card-'+i));
  const state=synchronizeUnassignedPool(root,{});assert.equal(Object.keys(state.unassigned).length,10);
  const job={domain_catalog:[],book_outcomes:{}};for(let i=0;i<9;i++)recordDomainUnit(job,{unit_ref:'u'+i,card_ids:['card-'+i],unassigned_card_ids:['card-'+i]});
  assert.equal(domainCheckpointDue(job),null);recordDomainUnit(job,{unit_ref:'u9',card_ids:['card-9'],unassigned_card_ids:['card-9']});
  assert.equal(domainCheckpointDue(job),'effective-unit-threshold');assert.equal(readDomainGovernanceState(root).schema,'domain-governance-v1');
});

test('governance package sends at most five complete bodies and validates exhaustive model disposition',t=>{
  const root=fixture(t);for(let i=0;i<12;i++)commitCard(root,card('card-'+i));
  const pack=buildDomainGovernancePackage(root,Array.from({length:12},(_,i)=>'card-'+i));
  assert.equal(pack.cards.length,12);assert.ok(pack.cards.filter(row=>row.delivery==='full').length<=5);
  const result=validateDomainGovernanceResult({assignments:[],proposals:[{id:'state-governance',title:'国家治理与组织制度',summary:'研究组织中的权力、信息与执行。',core_questions:['权力如何影响执行？'],includes:['正式组织的授权与激励'],excludes:['单一机构名录'],parents:[],representative_card_ids:['card-0'],member_card_ids:pack.cards.map(row=>row.id),closest_domains:[],why_new:'当前目录为空且成员形成稳定问题群。',alternative:'继续留在未组织池。'}],unassigned:[]},pack);
  assert.equal(result.proposals[0].member_card_ids.length,12);
});

test('governance validation enforces per-card candidates and rejects duplicate proposal identities',t=>{
  const root=fixture(t);for(let i=0;i<8;i++)commitCard(root,card('card-'+i));
  const gateway=new HarnessGateway(root),cards=loadCards(root),revision=id=>unoRevision(root,unoCardRef(root,cards.get(id)));
  for(const id of ['state','finance'])gateway.applyDomainGovernance({key:'seed-'+id,create_domains:[{id,title:id,summary:id+' 的稳定问题空间',core_questions:[id+' 的核心问题？'],includes:[id+' 相关机制'],excludes:['无关名录'],parents:[],representative_card_ids:['card-0']}],assignments:[{card_id:'card-0',domains:[id]}],expected_cards:{'card-0':revision('card-0')},expected_domains:{}});
  const pack=buildDomainGovernancePackage(root,['card-1','card-2','card-3','card-4','card-5','card-6','card-7']);pack.cards[0].candidate_domain_ids=['state'];
  assert.throws(()=>validateDomainGovernanceResult({assignments:[{card_id:'card-1',domains:['finance']}],proposals:[],unassigned:pack.cards.slice(1).map(row=>({card_id:row.id,reason:'暂缓'}))},pack),/候选列表/);
  assert.throws(()=>validateDomainGovernanceResult({assignments:[],proposals:[{proposal_id:'same',id:'new-a',title:'A',summary:'A',core_questions:['A?'],includes:['A'],excludes:['not A'],parents:[],member_card_ids:['card-1','card-2','card-3'],representative_card_ids:[],closest_domains:[],why_new:'需要',alternative:'暂缓'},{proposal_id:'same',id:'new-b',title:'B',summary:'B',core_questions:['B?'],includes:['B'],excludes:['not B'],parents:[],member_card_ids:['card-4','card-5','card-6'],representative_card_ids:[],closest_domains:[],why_new:'需要',alternative:'暂缓'}],unassigned:[{card_id:'card-7',reason:'暂缓'}]},pack),/提案 ID/);
});

test('Gateway creates a domain and assigns all members in one idempotent revision-checked transaction',t=>{
  const root=fixture(t);for(let i=0;i<3;i++)commitCard(root,card('card-'+i));
  const cards=loadCards(root),expected=Object.fromEntries([...cards].map(([id,value])=>[id,unoRevision(root,unoCardRef(root,value))]));
  const input={key:'domain-review/test',create_domains:[{id:'state-governance',title:'国家治理与组织制度',summary:'研究组织如何分配权力、信息和执行责任。',core_questions:['中央与地方如何分配信息与执行权？'],includes:['官僚体制与行政发包'],excludes:['单一政策或部门名录'],parents:[],representative_card_ids:['card-0']}],assignments:Object.keys(expected).map(card_id=>({card_id,domains:['state-governance']})),expected_cards:expected,expected_domains:{}};
  const gateway=new HarnessGateway(root),receipt=gateway.applyDomainGovernance(input),replay=gateway.applyDomainGovernance(input);
  assert.equal(receipt.input_hash,replay.input_hash);assert.deepEqual(receipt.domain_ids,['state-governance']);assert.equal(listDomainsV2(root).length,1);
  for(const value of loadCards(root).values())assert.deepEqual(value.meta.domains,['state-governance']);
});

test('membership governance preserves legacy metadata instead of silently migrating the card',t=>{
  const root=fixture(t),legacy=card('legacy-card');
  const legacyPath=join(root,'01-Cards','legacy-card.md');
  writeFileSync(legacyPath,`---\nid: legacy-card\ntitle: \"历史卡\"\ntype: mechanism\ndomains: []\ntags: [\"旧机制标签\"]\ntopics: [\"旧主题\"]\norigin: system\nmaturity: growing\nlifecycle: active\nsources: [\"source-legacy-card\"]\ncreated: \"2026-09-18\"\nupdated: \"2026-09-18\"\n---\n\n${legacy.body}`,'utf8');
  const before=loadCards(root).get('legacy-card'),revision=unoRevision(root,unoCardRef(root,before));
  new HarnessGateway(root).applyDomainGovernance({key:'domain-review/legacy',create_domains:[{id:'state-governance',title:'国家治理与组织制度',summary:'研究组织如何分配权力、信息和执行责任。',core_questions:['权力如何影响执行？'],includes:['官僚体制与授权'],excludes:['单一部门名录'],parents:[],representative_card_ids:['legacy-card']}],assignments:[{card_id:'legacy-card',domains:['state-governance']}],expected_cards:{'legacy-card':revision},expected_domains:{}});
  const after=loadCards(root).get('legacy-card');assert.deepEqual(after.meta.domains,['state-governance']);assert.deepEqual(after.meta.tags,['旧机制标签']);assert.deepEqual(after.meta.topics,['旧主题']);
});

test('stale member revision rejects the whole domain transaction without a partial formal domain',t=>{
  const root=fixture(t);for(let i=0;i<3;i++)commitCard(root,card('card-'+i));
  const cards=loadCards(root),expected=Object.fromEntries([...cards].map(([id,value])=>[id,unoRevision(root,unoCardRef(root,value))]));
  commitCard(root,{...card('card-0'),title:'外部更新后的标题'});
  assert.throws(()=>new HarnessGateway(root).applyDomainGovernance({key:'domain-review/stale',create_domains:[{id:'state-governance',title:'国家治理与组织制度',summary:'稳定问题空间。',core_questions:['如何治理？'],includes:['组织制度'],excludes:['临时关键词'],parents:[],representative_card_ids:['card-0']}],assignments:Object.keys(expected).map(card_id=>({card_id,domains:['state-governance']})),expected_cards:expected,expected_domains:{}}),/版本已变化/);
  assert.equal(existsSync(join(root,'01-Cards/_meta/domains/state-governance.md')),false);
  assert.deepEqual(loadCards(root).get('card-1').meta.domains,[]);
});

test('compile checkpoint persists a review proposal and never creates a formal domain before approval',async t=>{
  const root=fixture(t);for(let i=0;i<10;i++)commitCard(root,card('card-'+i));synchronizeUnassignedPool(root,{});
  const job={id:'job',mode:'compile',workflow:'uno-unit-compile-v3',compile_profile:'unit-cards-v3',status:'running',phase:'read',session_id:'s1',owner_session_id:'s1',
    model_selection:{provider:'test',model:'test'},workflow_reasoning:{domain:'low'},domain_catalog:[],book_outcomes:{},book_units:[],book_focus_refs:[],calls:[],receipts:[],touched:[],failures:[],version:0};
  for(let i=0;i<10;i++)recordDomainUnit(job,{unit_ref:'u'+i,card_ids:['card-'+i],unassigned_card_ids:['card-'+i]});saveCompileJob(root,job);
  const generate=async(_ctx,_root,_job,request)=>{assert.equal(request.nexoPrompt.phase,'domain-governance');return JSON.stringify({assignments:[],proposals:[{id:'state-governance',title:'国家治理与组织制度',summary:'研究组织中的权力、信息与执行。',core_questions:['权力如何影响执行？'],includes:['正式组织中的授权与激励'],excludes:['单一机构名录'],parents:[],representative_card_ids:['card-0'],member_card_ids:Array.from({length:10},(_,i)=>'card-'+i),closest_domains:[],why_new:'十张卡形成稳定问题群。',alternative:'暂留未组织池。'}],unassigned:[]});};
  assert.equal(await runDomainGovernanceCheckpoint({},root,job,new AbortController().signal,'effective-unit-threshold',generate),true);
  const saved=readCompileJob(root,'job');assert.equal(saved.status,'review');assert.equal(saved.phase,'domain_review');assert.equal(saved.domain_governance.pending_proposals.length,1);
  assert.equal(listDomainsV2(root).length,0);assert.equal(readDomainGovernanceState(root).proposals[saved.domain_governance.pending_proposals[0].proposal_id].status,'proposed');
});

test('explicit automatic approval creates a validated domain atomically and continues the compile',async t=>{
  const root=fixture(t);for(let i=0;i<10;i++)commitCard(root,card('card-'+i));synchronizeUnassignedPool(root,{});
  const job={id:'automatic-job',mode:'compile',workflow:'uno-unit-compile-v3',compile_profile:'unit-cards-v3',domain_approval_mode:'automatic',status:'running',phase:'read',session_id:'s1',owner_session_id:'s1',
    model_selection:{provider:'test',model:'test'},workflow_reasoning:{domain:'low'},domain_catalog:[],book_outcomes:{},book_units:[],book_focus_refs:[],calls:[],receipts:[],touched:[],failures:[],version:0};
  for(let i=0;i<10;i++)recordDomainUnit(job,{unit_ref:'u'+i,card_ids:['card-'+i],unassigned_card_ids:['card-'+i]});saveCompileJob(root,job);
  const generate=async()=>JSON.stringify({assignments:[],proposals:[{id:'state-governance',title:'国家治理与组织制度',summary:'研究组织中的权力、信息与执行。',core_questions:['权力如何影响执行？'],includes:['正式组织中的授权与激励'],excludes:['单一机构名录'],parents:[],representative_card_ids:['card-0'],member_card_ids:Array.from({length:10},(_,i)=>'card-'+i),closest_domains:[],why_new:'十张卡形成稳定问题群。',alternative:'暂留未组织池。'}],unassigned:[]});
  assert.equal(await runDomainGovernanceCheckpoint({},root,job,new AbortController().signal,'effective-unit-threshold',generate),false);
  const saved=readCompileJob(root,'automatic-job'),proposal=Object.values(readDomainGovernanceState(root).proposals)[0];
  assert.equal(saved.status,'running');assert.equal(saved.phase,'read');assert.deepEqual(saved.domain_governance.pending_proposals,[]);
  assert.equal(saved.domain_catalog.length,1);assert.equal(listDomainsV2(root)[0].id,'state-governance');assert.equal(proposal.status,'applied');
  assert.equal(saved.receipts.length,1);assert.equal(saved.domain_governance.open_unassigned,0);
  for(const value of loadCards(root).values())assert.deepEqual(value.meta.domains,['state-governance']);
});
