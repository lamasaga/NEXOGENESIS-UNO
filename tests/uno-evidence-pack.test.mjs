import {prepareSourceFixture} from './fixtures/uno-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {sha,readUnoUnit,unoMarkdown,unoRevision} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {readCompileJob,saveCompileJob,jobRef} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {runConstructionTool,batchTask} from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import {readDraft} from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import {buildEvidencePack,confirmEvidencePackDelivery,observeEvidencePackDelivery,EVIDENCE_PACK_PROFILE} from '../packages/nexogenesis-tools/lib/uno/evidence-pack.js';
import {executeConstruction} from '../packages/nexogenesis-web-host/lib/construction-host.js';

function fixture(t,body='作者甲认为，决策权与意见表达不同。\n\n数字 987654，仅限本地样本。反例：未授权参与时不适用。') {
  const root=mkdtempSync(join(tmpdir(),'uno-evidence-pack-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'00-Inbox'));writeFileSync(join(root,'00-Inbox/a.md'),body);
  const gateway=new HarnessGateway(root),info=prepareSourceFixture(root,{source:'00-Inbox/a.md',theme:'样例',
    prepared:{fingerprint:sha(body),format:'md',material_kind:'book',classification_reason:'选定本章',source_metadata:'作者甲',
      chapters:[{title:'第一章',text:body,locator:'第一章'}]}}),ref=info.units[0].ref;
  mkdirSync(join(root,'01-Cards'));writeFileSync(join(root,'01-Cards/a.md'),unoMarkdown({schema:'uno-card-v4',id:'a',title:'参与范围',summary:'表达与决策的区别',type:'claim',domains:[],boundary:'仅限当前样本',sources:[ref]},body));
  saveCompileJob(root,{id:'pack-test',workflow:'uno-compile-v3',execution_profile:EVIDENCE_PACK_PROFILE,
    status:'running',session_id:'author',sessions:['author'],mode:'construct',role:'author',phase:'read',batch_index:0,
    batches:[['a']],sources:[info],calls:[],budget:{calls:100},receipts:[],issues:[],touched:[],outcomes:{},reviewed:{},
    checkpoint:'保留反例，当前没有写入',requirements:{notes:'保留数字、适用条件和不同立场',long_term:'',preferences:{delivery:'auto'}}});
  const job=()=>readCompileJob(root,'pack-test'),update=patch=>saveCompileJob(root,{...job(),...patch});
  const tool=(name,args={})=>runConstructionTool(root,job(),name,args);
  const draft=(id='a',extra={})=>{tool('compile_read_card',{id});return tool('compile_edit',{operation_id:'create-'+id,id,revision:unoRevision(root,'01-Cards/'+id+'.md'),title:'参与范围',summary:'表达与决策的区别',
    type:'claim',domains:[],boundary:'仅限当前样本',sources:[ref],body,...extra});};
  const request=packet=>({sessionId:job().session_id,messages:[{role:'user',content:[{type:'text',text:packet.text}]}]});
  const confirm=(packet,req=request(packet),chunk={type:'text-delta',text:'收到本章'})=>confirmEvidencePackDelivery(root,packet,req,chunk);
  return {root,ref,body,info,gateway,job,update,tool,draft,request,confirm};
}

test('build is read-only; only exact text dispatched with model content credits the author',t=>{
  const f=fixture(t),before=readFileSync(join(f.root,jobRef('pack-test')),'utf8'),packet=buildEvidencePack(f.root,f.job());
  assert.equal(readFileSync(join(f.root,jobRef('pack-test')),'utf8'),before);
  const pack=JSON.parse(packet.text),source=pack.evidence.find(e=>e.kind==='card');
  assert.equal(source.text,f.body);assert.equal(source.complete,true);assert.equal(source.next_offset,null);
  assert.match(pack.task.checkpoint,/保留反例/);assert.equal(f.job().card_reads,undefined);
  assert.equal(f.tool('compile_finish',{phase:'organize'}).ready,false);
  assert.equal(f.confirm(packet).confirmed,true);
  assert.deepEqual(f.job().card_reads.a.intervals,[[0,Array.from(f.body).length]]);
  assert.equal(f.tool('compile_finish',{phase:'organize'}).ready,true);
  assert.equal(f.job().calls.length,0);assert.equal(f.job().budget.calls,100);
});

test('legacy and selection phases are not migrated or credited',t=>{
  const f=fixture(t);f.update({execution_profile:undefined});assert.equal(buildEvidencePack(f.root,f.job()),null);
  f.update({execution_profile:EVIDENCE_PACK_PROFILE,phase:'select'});assert.equal(buildEvidencePack(f.root,f.job()),null);
  assert.equal(f.job().card_reads,undefined);
});

test('bytes are bounded and Unicode pagination never claims an omitted tail',t=>{
  const f=fixture(t,'😀汉字反例。'.repeat(2500)+'最后限制条件不可忽略'),packet=buildEvidencePack(f.root,f.job(),{maxBytes:4096});
  assert.ok(packet.bytes<=4096);assert.equal(packet.bytes,Buffer.byteLength(packet.text));
  const source=JSON.parse(packet.text).evidence[0];assert.ok(source.end>0);assert.equal(source.next_offset,source.end);
  assert.equal(source.complete,false);assert.equal(source.text,Array.from(f.body).slice(0,source.end).join(''));
  f.confirm(packet);assert.equal(f.job().card_reads.a.intervals[0][1],source.end);
  assert.equal(f.tool('compile_finish',{phase:'organize'}).ready,false);
});

test('queue acceptance, empty frames, usage and failed finishes do not credit reading',t=>{
  const f=fixture(t),packet=buildEvidencePack(f.root,f.job());
  for(const chunk of [{type:'block-start',blockType:'text'},{type:'text-delta',text:''},{type:'usage',usage:{inputTokens:10}},{type:'finish',reason:{kind:'error'}}])
    assert.equal(f.confirm(packet,f.request(packet),chunk).confirmed,false);
  assert.equal(f.job().card_reads,undefined);
});

test('missing, changed, assistant-only and auxiliary request text are not delivery',t=>{
  const f=fixture(t),packet=buildEvidencePack(f.root,f.job());
  for(const request of [{sessionId:'wrong',messages:f.request(packet).messages},
    {sessionId:'author',messages:[{role:'user',content:[{type:'text',text:packet.text+' changed'}]}]},
    {sessionId:'author',messages:[{role:'assistant',content:[{type:'text',text:packet.text}]}]},
    {...f.request(packet),purpose:'compaction'}])assert.equal(f.confirm(packet,request).confirmed,false);
  assert.equal(f.job().card_reads,undefined);
  assert.throws(()=>f.confirm({...packet}),/本宿主/);
});

test('cancelled requests and paused jobs cannot acknowledge or contaminate a new session',t=>{
  const f=fixture(t),packet=buildEvidencePack(f.root,f.job()),controller=new AbortController();controller.abort();
  assert.throws(()=>f.confirm(packet,{...f.request(packet),signal:controller.signal}),/abort/i);
  f.update({pause_requested:true});assert.throws(()=>f.confirm(packet),/停止|交接/);
  f.update({pause_requested:false,session_id:'new-author',sessions:['author','new-author']});
  assert.throws(()=>f.confirm(packet,{...f.request(packet),sessionId:'author'}),/已经变化/);
  assert.equal(f.job().card_reads,undefined);
  const fresh=buildEvidencePack(f.root,f.job());assert.equal(f.confirm(fresh).confirmed,true);
});

test('source version changes between build and response reject the entire acknowledgement',t=>{
  const f=fixture(t),packet=buildEvidencePack(f.root,f.job());
  writeFileSync(join(f.root,'01-Cards/a.md'),unoMarkdown({schema:'uno-card-v4',id:'a',title:'参与范围',summary:'表达与决策的区别',type:'claim',domains:[],boundary:'仅限当前样本',sources:[f.ref]},f.body+'\n新的限制条件'));
  assert.throws(()=>f.confirm(packet),/发生变化/);assert.equal(f.job().card_reads,undefined);
  assert.equal(f.job().evidence_pack_deliveries,undefined);
});

test('delivery is idempotent within one stage; a fresh context must receive its own evidence',t=>{
  const f=fixture(t),packet=buildEvidencePack(f.root,f.job());f.confirm(packet);
  const before=readFileSync(join(f.root,jobRef('pack-test')),'utf8');assert.equal(f.confirm(packet).replayed,true);
  assert.equal(readFileSync(join(f.root,jobRef('pack-test')),'utf8'),before);assert.equal(buildEvidencePack(f.root,f.job()),null);
  f.update({session_id:'resumed',sessions:['author','resumed']});assert.ok(buildEvidencePack(f.root,f.job()));
});

test('reviewer receives actual drafts and sources but gains no review verdict or author authority',t=>{
  const f=fixture(t);f.draft();f.update({role:'reviewer',phase:'organize',session_id:'reviewer',sessions:['author','reviewer']});
  const packet=buildEvidencePack(f.root,f.job()),pack=JSON.parse(packet.text);
  assert.equal(pack.evidence.find(e=>e.kind==='card').draft,true);
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'尚未交付'}),/完整读回/);
  const authorReads=structuredClone(f.job().card_reads);f.confirm(packet);assert.equal(f.job().reading,undefined);assert.deepEqual(f.job().card_reads,authorReads);
  assert.deepEqual(f.job().reviewed,{});assert.ok(f.job().review_reads.a);assert.ok(f.job().review_evidence[f.ref]);
  assert.equal(f.job().review_reads.a.session_id,'reviewer');
  f.tool('compile_review',{ids:['a'],note:'核对当前来源与反例'});assert.ok(f.job().reviewed.a);
});

test('a changed draft cannot reuse the unacknowledged packet revision',t=>{
  const f=fixture(t);f.draft();f.update({role:'reviewer',phase:'organize',session_id:'reviewer'});
  const packet=buildEvidencePack(f.root,f.job()),draft=readDraft(f.root,batchTask(f.job()),'a');
  f.gateway.stageUnoKnowledge({task:batchTask(f.job()),key:'changed-draft',id:'a',action:'patch',revision:draft.revision,title:'新标题'});
  assert.throws(()=>f.confirm(packet),/发生变化/);assert.equal(f.job().review_reads,undefined);
});

test('construct packs credit only the current selected cards and keep full-read gates',t=>{
  const f=fixture(t);mkdirSync(join(f.root,'01-Cards'),{recursive:true});
  for(const id of ['a','outside'])writeFileSync(join(f.root,'01-Cards',id+'.md'),unoMarkdown({schema:'uno-card-v4',id,title:id,summary:'摘要',
    type:'claim',domains:[],sources:[f.ref],boundary:'当前样本',lifecycle:'active'},f.body));
  f.update({mode:'construct',construct_contract:'scoped-review-v1',scope:['a'],batches:[['a']]});
  const packet=buildEvidencePack(f.root,f.job()),pack=JSON.parse(packet.text);
  assert.deepEqual(pack.evidence.map(e=>e.id),['a']);f.confirm(packet);
  assert.equal(f.job().card_reads.a.revision,unoRevision(f.root,'01-Cards/a.md'));assert.equal(f.job().card_reads.outside,undefined);
  assert.equal(f.job().card_reads.a.session_id,'author');
  assert.equal(f.tool('compile_finish',{phase:'organize',summary:'已检查'}).ready,true);
});

test('budget admission and late over-budget responses never reset or extend the budget',t=>{
  const f=fixture(t);f.update({budget:{calls:1}});const packet=buildEvidencePack(f.root,f.job());
  f.update({calls:[{}]});assert.equal(f.confirm(packet).confirmed,true);
  f.update({session_id:'next',calls:[{}]});assert.throws(()=>buildEvidencePack(f.root,f.job()),/预算不足/);
  f.update({calls:[]});const next=buildEvidencePack(f.root,f.job());f.update({calls:[{},{}]});
  assert.throws(()=>f.confirm(next),/超过累计预算/);assert.equal(f.job().budget.calls,1);
});

test('stream acknowledgement happens before a tool-call chunk reaches the native loop',async t=>{
  const f=fixture(t),packet=buildEvidencePack(f.root,f.job());
  async function* stream(){yield {type:'usage',usage:{inputTokens:10}};yield {type:'tool-call-delta',name:'compile_finish',argumentsDelta:'{}'};}
  const iterator=observeEvidencePackDelivery(f.root,packet,f.request(packet),stream());
  assert.equal((await iterator.next()).value.type,'usage');assert.equal(f.job().card_reads,undefined);
  assert.equal((await iterator.next()).value.type,'tool-call-delta');assert.ok(f.job().card_reads.a);
  await iterator.return();
});

test('old-context card intervals cannot become a new-context full-read proof',t=>{
  const f=fixture(t);f.draft();f.update({role:'reviewer',phase:'organize',session_id:'reviewer'});
  const draft=readDraft(f.root,batchTask(f.job()),'a');
  f.update({review_reads:{a:{revision:draft.revision,intervals:[[0,Array.from(f.body).length]],session_id:'old-reviewer'}}});
  const packet=buildEvidencePack(f.root,f.job(),{maxCharsPerItem:10});f.confirm(packet);
  assert.deepEqual(f.job().review_reads.a.intervals,[[0,10]]);assert.equal(f.job().review_reads.a.session_id,'reviewer');
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'新窗口仍未完整读回'}),/完整读回/);
});

test('native host sends one intact pack per context, preserves checkpoint, and disposes listeners',async t=>{
  const f=fixture(t),listeners=new Map(),prompts=[],created=[];
  const oldFetch=globalThis.fetch,oldHome=process.env.DSH_HOME;process.env.DSH_HOME=f.root;
  t.after(()=>{globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;});
  f.update({needs_fresh_context:true,owner_session_id:'owner',title:'合成首包验证',model_selection:{provider:'custom',model:'synthetic'},
    selected_sources:[],preparation_cursor:0,failures:[],requirements:{...f.job().requirements,preferences:{delivery:'manual'}}});
  const ctx={webServer:{port:9999},on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name).delete(fn);}};
  const emit=(sessionId,type,data)=>{for(const fn of [...(listeners.get('session/event')??[])])fn({id:sessionId},{type,data});};
  globalThis.fetch=async(_url,init)=>{
    const request=JSON.parse(init.body);let value={};
    if(request.method==='session.create'){value={sessionId:'fresh-'+created.length};created.push(value.sessionId);}
    if(request.method==='session.prompt')setImmediate(async()=>{
      const {sessionId,content}=request.payload;prompts.push(request.payload);
      try {
        assert.equal(content.length,2);assert.doesNotMatch(content[0].text,/先用 compile_task/);
        const pack=JSON.parse(content[1].text);assert.match(pack.task.checkpoint,/保留反例/);
        assert.equal(f.job().evidence_pack_deliveries?.[`${sessionId}:0:${f.job().role}:${f.job().phase}`],undefined);
        emit(sessionId,'step/start',{step:1});
        const options={sessionId,messages:[{role:'user',content}]};
        async function* response(){yield {type:'text-delta',text:'开始判断当前材料'};}
        let stream=()=>response();
        for(const listener of [...(listeners.get('llm/stream')??[])].reverse()){const next=stream;stream=()=>listener(options,next);}
        for await(const _chunk of stream()){};
        const job=f.job();
        if(job.role==='author'){
          assert.ok(job.card_reads.a);f.draft();
          f.tool('compile_finish',{phase:'organize',summary:'首轮结束，保留反例待审核'});
        }else{
          assert.equal(job.review_reads.a.session_id,sessionId);assert.ok(job.review_evidence[f.ref]);
          f.tool('compile_review',{ids:['a'],note:'已核对正文、来源与限定'});
          f.tool('compile_finish',{phase:'complete',summary:'审核完成'});
        }
        emit(sessionId,'assistant/message',{message:{content:[]}});emit(sessionId,'turn/end',{reason:{kind:'completed'}});
      }catch(error){emit(sessionId,'turn/end',{reason:{kind:'error',message:error.stack}});}
    });
    return {json:async()=>({type:'server-response',result:{ok:true,value}})};
  };
  await executeConstruction(ctx,f.root,f.job(),new AbortController());
  const job=f.job();assert.equal(job.status,'review',job.detail);assert.equal(prompts.length,2);
  assert.notEqual(prompts[0].sessionId,prompts[1].sessionId);assert.equal(job.calls.length,2);
  assert.equal(Object.keys(job.evidence_pack_deliveries).length,2);assert.equal(job.budget.calls,100);
  assert.equal(listeners.get('llm/stream').size,0);assert.equal(listeners.get('session/event').size,0);
});
