import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runConstructionTool} from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import {finalizeConstructionBatch,executeConstruction} from '../packages/nexogenesis-web-host/lib/construction-host.js';
import {saveCompileJob,readCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {pendingBatches,resumeUnfinishedBatch} from '../packages/nexogenesis-tools/lib/uno/recovery.js';
import {recentThinkingMessages} from '../packages/nexogenesis-web-host/lib/quick-thinking.js';
import {collectThinkingContext} from '../packages/nexogenesis-web-host/lib/thinking-routes.js';
import {unoPreparation} from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import {safeCardId,safeId} from '../packages/nexogenesis-tools/lib/uno-contract.js';
import {draftRef,readDraft} from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import {cardVersions} from '../packages/nexogenesis-tools/lib/uno/knowledge.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'uno-construct-contract-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'01-Cards'));mkdirSync(join(root,'03-Archive'));
 writeFileSync(join(root,'03-Archive/source.md'),'---\ntitle: 来源\n---\n对象甲和对象乙的使用条件不同。');
 for(const id of ['a','b'])writeFileSync(join(root,'01-Cards',id+'.md'),`---\nschema: uno-card-v4\nid: ${id}\ntitle: 对象${id}\nsummary: 两种方法。\ntype: method\ndomains: []\nboundary: 限于材料的使用条件。\nsources: [03-Archive/source.md]\n---\n对象${id}的完整正文，包含使用条件和操作。`);
 const job={id:'job',mode:'construct',workflow:'uno-compile-v3',construct_contract:'scoped-review-v1',status:'running',role:'author',phase:'read',session_id:'author',owner_session_id:'author',batch_index:0,batches:[['a']],scope:['a'],budget:{calls:120},calls:[],receipts:[],touched:[],issues:[],failures:[],sources:[],requirements:{preferences:{delivery:'auto'}},continuous:false};
 saveCompileJob(root,job);return {root,job,tool:(name,args={})=>runConstructionTool(root,job,name,args)};
}
function unchangedReview(f){
 f.job.role='reviewer';f.job.session_id='reviewer';f.job.handoff_requested=false;
 f.tool('compile_read_card',{id:'a'});
 f.tool('compile_review',{ids:['a'],note:'正文有使用条件与操作，标签与内容一致，无需修改。'});
}

test('中文旧卡可完整读回、局部修订、独立审核发布并查看历史，保留原 ID',t=>{
 const f=fixture(t),id='“这次不同” 是债务繁荣中的反复叙事';
 const path=join(f.root,'01-Cards',id+'.md');
 const original=readFileSync(join(f.root,'01-Cards/a.md'),'utf8').replace('id: a',`id: ${JSON.stringify(id)}`);
 writeFileSync(path,original);f.job.scope=[id];f.job.batches=[[id]];saveCompileJob(f.root,f.job);
 const read=f.tool('compile_read_card',{id});assert.equal(read.meta.id,id);
 assert.deepEqual(cardVersions(f.root,id),[]);
 const receipt=f.tool('compile_edit',{operation_id:'fix-summary',action:'patch',id,revision:read.revision,summary:'以来源条件为边界，解释债务繁荣叙事。'});
 assert.equal(receipt.staged,true);assert.equal(readFileSync(path,'utf8'),original,'未审核不改正式卡');
 f.job.role='reviewer';f.job.session_id='reviewer';
 f.tool('compile_read_card',{id});f.tool('compile_read_material',{ref:'03-Archive/source.md'});
 f.tool('compile_review',{ids:[id],note:'核对完整正文与来源，保留 ID 和原内容，只调整检索摘要。'});
 finalizeConstructionBatch(f.root,f.job);
 assert.equal(readDraft(f.root,'job-b0',id).state,'published');
 assert.match(readFileSync(path,'utf8'),/解释债务繁荣叙事/);assert.equal(cardVersions(f.root,id).length,1);
 assert.equal(safeId(id),false,'任务 ID 规则不放宽');assert.equal(safeCardId(id),true);
 for(const invalid of ['../x','a/b','a\\b','C:x','x:stream','CON','NUL.md','x.','x ','a\u0000b']){
  assert.equal(safeCardId(invalid),false,invalid);assert.throws(()=>draftRef('job',invalid),/无效/);
 }
});

test('大规模建构状态不重复携带全库 ID，范围可完整分页且未修改授权',t=>{
 const f=fixture(t);f.job.scope=Array.from({length:2600},(_,i)=>`长中文卡片标识-${i}`);
 const before=[...f.job.scope],status=f.tool('compile_task',{view:'status'});
 assert.equal(status.write_scope_count,2600);assert.ok(JSON.stringify(status).length<5000);
 const rows=[];for(let offset=0;offset<2600;offset+=30)rows.push(...f.tool('compile_task',{view:'scope',offset}).items);
 assert.deepEqual(rows,before);assert.deepEqual(f.job.scope,before);
});
test('建构准备接口同时提供主类型与范围审核能力标记',t=>{
 const f=fixture(t),preparation=unoPreparation({},f.root);
 assert.equal(preparation.construct_contract,'scoped-review-v1');
 assert.equal(preparation.construction_repair_scope,'construction-repair-endpoint-scope-v1');
 assert.ok(preparation.types.some(type=>type.id==='method'));
 assert.equal(preparation.cards.filter(card=>card.type==='method').length,2);
});
test('建构可读范围外卡片，但修改、关系起点及合并均受所选范围约束',t=>{
 const f=fixture(t),before=readFileSync(join(f.root,'01-Cards/b.md'),'utf8');
 const b=f.tool('compile_read_card',{id:'b'}),a=f.tool('compile_read_card',{id:'a'});
 assert.throws(()=>f.tool('compile_edit',{operation_id:'outside',action:'link',id:'b',revision:b.revision,link:{target:'a',type:'contrast',note:'条件不同',basis:'source'}}),/范围/);
 assert.throws(()=>f.tool('compile_edit',{operation_id:'merge',action:'patch',id:'a',revision:a.revision,merge:[{id:'b',revision:b.revision}]}),/范围/);
 const result=f.tool('compile_edit',{operation_id:'inside',action:'link',id:'a',revision:a.revision,link:{target:'b',type:'contrast',note:'使用条件不同，可作为对照。',basis:'navigation'}});
 assert.equal(result.staged,true);assert.equal(readFileSync(join(f.root,'01-Cards/b.md'),'utf8'),before);
});
test('无修改建构须逐卡独立读回及说明；内容变化会使旧审核失效',async t=>{
 const f=fixture(t);
 assert.equal(f.tool('compile_finish',{phase:'organize'}).ready,false);
 f.tool('compile_read_card',{id:'a'});assert.equal(f.tool('compile_finish',{phase:'organize'}).ready,true);
 f.job.handoff_requested=false;f.job.role='reviewer';f.job.session_id='reviewer';
 assert.equal(f.tool('compile_finish',{phase:'complete'}).ready,false);
 assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'无需修改'}),/完整读回/);
 unchangedReview(f);
 const file=join(f.root,'01-Cards/a.md');writeFileSync(file,readFileSync(file,'utf8')+'\n新增条件。');
 assert.equal(f.tool('compile_finish',{phase:'complete'}).ready,false);
 unchangedReview(f);assert.equal(f.tool('compile_finish',{phase:'complete',summary:'已检查，保留现状'}).ready,true);
 finalizeConstructionBatch(f.root,f.job);await executeConstruction({},f.root,f.job,new AbortController());
 const done=readCompileJob(f.root,'job');assert.equal(done.status,'completed');assert.match(done.detail,/1 张审核后保留原样/);
 assert.equal(done.batch_records[0].reviewed.a.unchanged,true);
});
test('历史建构领域提案只保留审计记录，不再绕过领域治理写入正式领域',async t=>{
 const f=fixture(t);unchangedReview(f);
 f.job.domain_proposals=[{key:'domain-old',id:'area',title:'使用范围',revision:null}];saveCompileJob(f.root,f.job);
 finalizeConstructionBatch(f.root,f.job);await executeConstruction({},f.root,f.job,new AbortController());
 const done=readCompileJob(f.root,'job');assert.equal(done.status,'completed');assert.equal(pendingBatches(f.root,done).length,0);
 assert.equal(done.legacy_domain_proposals[0].id,'area');assert.equal(done.issues.find(i=>i.id==='area').code,'LEGACY_DOMAIN_PROPOSAL_UNSUPPORTED');
 assert.equal(existsSync(join(f.root,'01-Cards/_meta/domains/area.md')),false);
});
test('保留原卡但有审核疑点时结算为部分完成，并能恢复到独立审核',async t=>{
 const f=fixture(t);unchangedReview(f);f.tool('compile_review',{ids:['a'],note:'需回查原材料中的限制',issues:[{id:'a',detail:'限制条件待核对'}]});
 assert.equal(f.tool('compile_finish',{phase:'complete',summary:'保留疑点'}).ready,true);
 finalizeConstructionBatch(f.root,f.job);await executeConstruction({},f.root,f.job,new AbortController());
 const failed=readCompileJob(f.root,'job');assert.equal(failed.status,'partial');assert.equal(pendingBatches(f.root,failed)[0].cards[0].id,'a');
 assert.equal(resumeUnfinishedBatch(f.root,failed),true);assert.equal(failed.role,'reviewer');
});
test('新对话保留长回答的首尾背景，并能召回单字知识概念',t=>{
 const f=fixture(t),selected={provider:'test',model:'test'};
 const messages=recentThinkingMessages([{role:'user',content:'比较两种方法'},{role:'assistant',content:'开头结论'+'长'.repeat(8200)+'尾部条件',status:'completed'}],selected);
 assert.equal(messages.length,2);const text=JSON.stringify(messages);assert.match(text,/开头结论/);assert.match(text,/尾部条件/);assert.match(text,/已节选/);
 writeFileSync(join(f.root,'01-Cards/entropy.md'),'---\nid: entropy\ntitle: 熵\ntags: [概念]\n---\n这一物理量的定义与适用条件。');
 assert.ok(collectThinkingContext(f.root,'熵','explain').some(c=>c.id==='entropy'));
});
