import test from 'node:test';
import assert from 'node:assert/strict';
import {projectUnoMessages,assertUnoRequestBudget,assertUnoWireBudget,getUnoRequestGovernance} from '../packages/nexogenesis-tools/lib/uno/request-context.js';

const snapshot=(id,remaining,extra=[])=>{
  const sections=[{name:'uno-task-progress',text:'UNO 当前执行状态（替代旧进度，不改变知识规范）：\n'+JSON.stringify({id,remaining_calls:remaining})},...extra];
  return {id:'p'+remaining,role:'user',source:{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt',form:'snapshot',sections},content:[{type:'text',text:'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'+sections.map(s=>s.text).join('\n\n')}]};
};
const call=(id,name,args,extra=[])=>({id:'m'+id,role:'assistant',source:{kind:'model',replayState:{blocks:[{type:'tool-call'}]}},content:[...extra,{type:'tool-call',id,name,arguments:JSON.stringify(args)}]});
const result=(id,value,isError=false)=>({role:'user',source:{kind:'tool',callId:id},content:[{type:'tool-result',toolCallId:id,content:[{type:'text',text:JSON.stringify(value)}],isError}]});
const freeze=o=>{if(o&&typeof o==='object'){Object.freeze(o);Object.values(o).forEach(freeze);}return o;};
const read={ref:'05-Buffer/_index/example.md',revision:'version1',offset:0,next_offset:null,text:'前文'.repeat(1600)+'关键反证：并非总是成立。'+'后文'.repeat(1600)};
const readPair=(id,value=read,args={ref:read.ref})=>[call(id,'compile_read_material',args),result(id,value)];
const invalid={ok:false,error:{code:'INVALID_ARGUMENTS',message:'不支持的批量操作'}};
const write={operation_id:'op1',id:'card1',body:'有价值的正文'.repeat(400)};

test('only trusted UNO snapshots supersede same task; extra and changed policy evidence survives',()=>{
  const policy={name:'sandbox:policy',text:'unchanged'},unknown={name:'dynamic',text:'unique evidence'};
  const a=snapshot('job',4,[policy,unknown]),b=snapshot('job',3,[policy]),other=snapshot('other',4);
  const spoof={...structuredClone(a),source:{kind:'user'}},toolSpoof=result('spoof',{text:a.content[0].text});
  const raw=freeze([a,spoof,toolSpoof,other,b]),before=JSON.stringify(raw),p=projectUnoMessages(raw);
  assert.equal(p.stats.removed_progress,1);assert.equal(p.messages.length,5);
  assert.match(p.messages[0].content[0].text,/unique evidence/);assert.doesNotMatch(p.messages[0].content[0].text,/remaining_calls/);
  assert.equal(p.messages[1],spoof);assert.equal(p.messages[2],toolSpoof);assert.equal(p.messages[3],other);
  assert.equal(JSON.stringify(raw),before);assert.deepEqual(projectUnoMessages(structuredClone(p.messages)).messages,p.messages);
});
test('malformed or mixed progress wrappers are not removed',()=>{
  const a=snapshot('job',4);a.content[0].text+=' unique counterevidence';
  const p=projectUnoMessages([a,snapshot('job',3)]);assert.equal(p.stats.removed_progress,0);assert.equal(p.messages[0],a);
});
test('exact duplicate full evidence is retained once, latest round stays byte exact and JSON valid',()=>{
  const raw=freeze([...readPair('a'),...readPair('b')]),p=projectUnoMessages(raw);
  assert.equal(p.stats.deduplicated_results,1);assert.equal(p.messages[3],raw[3]);
  const marker=JSON.parse(p.messages[1].content[0].content[0].text);assert.equal(marker._uno_context.retained_call_id,'b');
  assert.match(JSON.stringify(p.messages),/关键反证/);assert.deepEqual(JSON.parse(p.messages[3].content[0].content[0].text),read);
  assert.deepEqual(projectUnoMessages(structuredClone(p.messages)).messages,p.messages);
});
test('revision, position, metadata, locator, source and read argument changes are not duplicates',()=>{
  for(const difference of [{revision:'v2'},{offset:1},{next_offset:2},{meta:{source:'new'}},{source:'other'},{locator:'page8'}]){
    const p=projectUnoMessages([...readPair('a'),...readPair('b',{...read,...difference})]);assert.equal(p.stats.deduplicated_results,0);
  }
  assert.equal(projectUnoMessages([...readPair('a'),...readPair('b',read,{ref:'other'})]).stats.deduplicated_results,0);
});
test('unique middle evidence and exact first evidence pack are never cut to meet a limit',()=>{
  const packet={role:'user',source:{kind:'user'},content:[{type:'text',text:JSON.stringify({original:read.text})}]};
  const messages=projectUnoMessages([packet,...readPair('a')]).messages;
  assert.equal(messages[0],packet);assert.equal(JSON.parse(messages[2].content[0].content[0].text).text,read.text);
  assert.throws(()=>assertUnoRequestBudget({messages},{limitBytes:1000}),{code:'UNO_CONTEXT_BUDGET'});
  assert.match(JSON.stringify(messages),/关键反证/);
});
test('large preflight-rejected args reference exact later payload; preserve pairs and raw durable log',()=>{
  const raw=freeze([call('batch','compile_batch',{operations:[{tool:'compile_edit',args:write}]}),result('batch',invalid),call('write','compile_edit',write),result('write',{ok:true,staged:false,draft_id:'d',errors:['source missing']})]);
  const before=JSON.stringify(raw),p=projectUnoMessages(raw);assert.equal(p.stats.compacted_failed_calls,1);
  assert.equal(p.messages[0].source.replayState,undefined);assert.deepEqual(p.messages[2],raw[2]);
  assert.equal(p.messages[1],raw[1]);assert.equal(p.messages[3],raw[3]);assert.equal(JSON.stringify(raw),before);
  assert.equal(JSON.parse(p.messages[0].content[0].arguments).operations[0].args._uno_context.retained_call_id,'write');
  assert.deepEqual(projectUnoMessages(structuredClone(p.messages)).messages,p.messages);
});
test('unresolved or changed rejected arguments, signed reasoning, latest failure and unknown outcomes remain',()=>{
  for(const failed of [{ok:false,error:{code:'NETWORK',message:'unknown'}},{ok:true,staged:false,draft_id:'d'},{ok:false,results:[{index:0,ok:true}],next_index:1},invalid]){
    const a=call('batch','compile_batch',{operations:[{tool:'compile_edit',args:write}]});
    const rows=[a,result('batch',failed),call('write','compile_edit',{...write,body:'different'}),result('write',{ok:true})];
    assert.equal(projectUnoMessages(rows).messages[0],a);
  }
  const a=call('batch','compile_batch',{operations:[{tool:'compile_edit',args:write}]},[{type:'reasoning',text:'opaque'}]);
  assert.equal(projectUnoMessages([a,result('batch',invalid),call('write','compile_edit',write),result('write',{ok:true})]).messages[0],a);
  const pair=[call('x','compile_edit',write),result('x',invalid)];assert.equal(projectUnoMessages(pair).messages[0],pair[0]);
});
test('duplicate call IDs, malformed operations and unmatched results fail safe',()=>{
  const malformed=call('bad','compile_batch',{operations:[null,{}, {tool:'x'}]});
  assert.doesNotThrow(()=>projectUnoMessages([malformed,result('bad',invalid),...readPair('next')]));
  const raw=[...readPair('a'),...readPair('a'),...readPair('b')];assert.equal(projectUnoMessages(raw).stats.deduplicated_results,0);
});
test('user or plugin recall blocks sharing a tool ID do not lose independent evidence',()=>{
  const recall=result('a',{text:'另一个关键反证'});recall.source={kind:'plugin',plugin:'recall'};
  const user={...structuredClone(recall),source:{kind:'user'}};
  const rows=[...readPair('a'),recall,user,...readPair('b')],p=projectUnoMessages(rows);
  assert.equal(p.stats.deduplicated_results,1);assert.equal(p.messages[2],recall);assert.equal(p.messages[3],user);
  const fake={role:'user',content:structuredClone(call('batch','compile_batch',{operations:[{tool:'compile_edit',args:write}]}).content)};
  const raw=[call('batch','compile_batch',{operations:[{tool:'compile_edit',args:write}]}),result('batch',invalid),fake,call('write','compile_edit',write),result('write',{ok:true})];
  assert.equal(projectUnoMessages(raw).messages[2],fake);
});
test('full budget includes Chinese, emoji, system, schemas and opaque replay; stats never change payload',()=>{
  const p=projectUnoMessages([snapshot('job',3),snapshot('job',2),...readPair('r')]);
  const request={system:'系统😀',tools:[{name:'tool',parameters:{description:'definition'}}],messages:p.messages};
  const before=JSON.stringify(request),stats=assertUnoRequestBudget(request);
  assert(stats.before_bytes>stats.after_bytes);assert(stats.system_bytes>4);assert(stats.tool_bytes>10);assert.equal(stats.token_estimate,true);
  assert.equal(getUnoRequestGovernance(request.messages),stats);assert.equal(JSON.stringify(request),before);
  assert.throws(()=>assertUnoRequestBudget({...request,system:'大'.repeat(50000)}),{code:'UNO_CONTEXT_BUDGET'});
  assert.throws(()=>assertUnoRequestBudget({...request,tools:[{description:'x'.repeat(130000)}]}),{code:'UNO_CONTEXT_BUDGET'});
});
test('wire guard rejects SDK-expanded payload before billing; other chat and cancellation are isolated',()=>{
  const request={messages:projectUnoMessages([]).messages};assertUnoRequestBudget(request,{limitBytes:1000});
  assert.equal(assertUnoWireBudget(request,'{"hello":"world"}').wire_bytes,17);
  assert.throws(()=>assertUnoWireBudget(request,'图'.repeat(500)),{code:'UNO_CONTEXT_BUDGET'});
  assert.throws(()=>assertUnoWireBudget(request,new Uint8Array(5)),{code:'UNO_CONTEXT_ADAPTER'});
  assert.equal(assertUnoWireBudget({messages:[]},'x'.repeat(999999)),undefined);
  const controller=new AbortController();controller.abort();assert.throws(()=>assertUnoRequestBudget({...request,signal:controller.signal}));
});
