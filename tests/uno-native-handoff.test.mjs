import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Context} from '../packages/nexogenesis-web-host/node_modules/@deepseek-ai/cordis/lib/index.js';
import {apply} from '../packages/nexogenesis-tools/lib/uno/agent.js';
import {taskProgress} from '../packages/nexogenesis-tools/lib/uno/context.js';
import {saveCompileJob,readCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {unoMarkdown,unoRevision} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';

// Use the same installed native runtime as the UNO tool plugin, without adding
// another runtime version to the application or requiring global PATH aliases.
const nativeRequire=createRequire(new URL('../packages/nexogenesis-tools/lib/uno/agent.js',import.meta.url));
const nativeTools=nativeRequire.resolve('@deepseek-ai/dsh-tools');
const {ToolRuntime}=await import(pathToFileURL(nativeTools));
const {SystemPrompt}=await import(pathToFileURL(createRequire(nativeTools).resolve('@deepseek-ai/dsh-system-prompt')));
const {createScope}=await import(pathToFileURL(createRequire(nativeTools).resolve('@deepseek-ai/dsh-scope')));

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'uno-native-handoff-')),ref='00-Inbox/chapter.md';
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'00-Inbox'));writeFileSync(join(root,ref),'A bounded synthetic chapter.');mkdirSync(join(root,'01-Cards'));writeFileSync(join(root,'01-Cards/a.md'),unoMarkdown({id:'a',title:'A',tags:['观点'],sources:[ref]},'A bounded synthetic card.'));
  const sessionId='handoff-session',agent={session:{id:sessionId,header:{cwd:root}}};
  saveCompileJob(root,{id:'handoff-test',workflow:'uno-compile-v3',mode:'construct',status:'running',phase:'read',role:'author',
    session_id:sessionId,sessions:[sessionId],construct_contract:'scoped-review-v1',scope:['a'],batches:[['a']],batch_index:0,calls:[],budget:{calls:20},
    receipts:[],sources:[],issues:[],touched:[],outcomes:{},reviewed:{},requirements:{notes:'Synthetic test only',preferences:{}}});
  const ctx=new Context();new SystemPrompt(ctx,{includeHarnessIdentity:false});const runtime=new ToolRuntime(ctx);
  const scope=createScope(ctx,agent);t.after(()=>scope.dispose());
  apply(scope.ctx,{projectRoot:root,instanceRegistry:''});
  const job=()=>readCompileJob(root,'handoff-test'),update=patch=>saveCompileJob(root,{...job(),...patch});
  let count=0;
  const call=(name,args={},signal=new AbortController().signal)=>runtime.execute({callId:'call-'+(++count),name,arguments:args,agent,signal});
  return {root,ref,ctx,runtime,agent,job,update,call};
}


test('retired compilation tools are absent from native registration',t=>{
 const f=fixture(t);
 for(const name of ['compile_sources','compile_select','compile_prepare','compile_settle','compile_buffer','compile_inspect'])assert.equal(f.runtime.get(name,f.agent),undefined,name);
 assert.ok(f.runtime.get('compile_edit',f.agent));
});
test('native construction finish concludes only after current cards have been read and reviewed',async t=>{
 const f=fixture(t);let result=await f.call('compile_finish',{phase:'organize',summary:'Current selected content has been inspected.'});
 assert.equal(result.concludesTurn,undefined);assert.equal(f.job().handoff_requested,undefined);
 await f.call('compile_read_card',{id:'a'});result=await f.call('compile_finish',{phase:'organize',summary:'Current selected content has been inspected.'});
 assert.equal(result.concludesTurn,true);assert.equal(f.job().handoff_requested,true);
 f.update({role:'reviewer',phase:'organize',handoff_requested:false});result=await f.call('compile_finish',{phase:'complete',summary:'Review recorded.'});
 assert.equal(result.concludesTurn,undefined);
 await f.call('compile_read_card',{id:'a'});await f.call('compile_review',{ids:['a'],note:'Current content is unchanged and limited to the synthetic source.'});
 result=await f.call('compile_finish',{phase:'complete',summary:'Review recorded.'});assert.equal(result.concludesTurn,true);assert.equal(f.job().finish_requested,true);
});
test('errors, ordinary JSON and cancelled calls cannot conclude a native turn',async t=>{
 const f=fixture(t),bad=await f.call('compile_read_card',{id:'missing'});assert.equal(bad.concludesTurn,undefined);
 const ordinary=await f.call('compile_task',{view:'status'});assert.equal(ordinary.concludesTurn,undefined);
 const controller=new AbortController();controller.abort(new Error('User cancelled'));
 const cancelled=await f.call('compile_finish',{phase:'organize',summary:'Current selected content has been inspected.'},controller.signal);assert.equal(cancelled.concludesTurn,undefined);assert.equal(f.job().handoff_requested,undefined);
});
test('pause racing a persisted construction handoff takes precedence over completion',async t=>{
 const f=fixture(t);await f.call('compile_read_card',{id:'a'});
 const definition=f.runtime.get('compile_finish',f.agent),controller=new AbortController();let concluded=0;
 const running=definition.execute({phase:'organize',summary:'Current selected content has been inspected.'},{agent:f.agent,signal:controller.signal,concludeTurn(){concluded++;},deferContext(){}});
 controller.abort(new Error('User cancelled after persistence'));
 await assert.rejects(running,/cancelled/);assert.equal(concluded,0);assert.equal(f.job().handoff_requested,true);
});
test('batch prevalidation rejects retired operations before executing valid items',async t=>{
 const f=fixture(t),result=await f.call('compile_batch',{operations:[{tool:'compile_read_card',args:{id:'a'}},{tool:'compile_select',args:{action:'begin'}}]});
 assert.equal(result.concludesTurn,undefined);assert.equal(f.job().card_reads,undefined);assert.equal(f.job().selection_request,undefined);
});
test('retired compilation sessions cannot call retained construction tools',async t=>{
 const f=fixture(t);f.update({mode:'compile'});const before=JSON.stringify(f.job());
 const output=await f.call('compile_edit',{operation_id:'forbidden',id:'a',title:'Do not write'});assert.equal(output.concludesTurn,undefined);assert.match(JSON.stringify(output),/退役|历史|只读|不再|停止执行|LEGACY|RETIRED/);assert.equal(JSON.stringify(f.job()),before);
});
