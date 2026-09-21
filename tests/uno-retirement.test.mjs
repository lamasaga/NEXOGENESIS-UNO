import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {Readable} from 'node:stream';
import {executeUnoJob,launch,handleUnoApi,isCurrentUnoJob} from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import {executeConstruction,finalizeConstructionBatch} from '../packages/nexogenesis-web-host/lib/construction-host.js';
import {saveCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
function fixture(t,mode='compile',workflow='uno-compile-v3') {const root=mkdtempSync(join(tmpdir(),'uno-retirement-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const job={id:'retired',mode,workflow,status:'paused',phase:'read',version:0,calls:[],sources:[],failures:[],receipts:[],batches:[]};saveCompileJob(root,job);const file=join(root,'.nexogenesis/uno-jobs/retired.json'),before=readFileSync(file,'utf8');return{root,job,file,before};}
for(const [mode,workflow] of [['compile','uno-compile-v3'],['compile','uno-compile-v2'],['construct','uno-compile-v2'],['construct',null]])test('retired '+mode+'/'+workflow+' cannot execute, launch, or publish',async t=>{
 const f=fixture(t,mode,workflow),ctx=new Proxy({},{get(){throw Error('No runtime access permitted');}});assert.equal(isCurrentUnoJob(f.job),false);
 await assert.rejects(executeUnoJob(ctx,f.root,f.job,new AbortController()),error=>error.status===409);
 assert.throws(()=>launch(ctx,f.root,f.job),error=>error.status===409);
 await assert.rejects(executeConstruction(ctx,f.root,f.job,new AbortController()),{code:'LEGACY_WORKFLOW_READONLY'});
 assert.throws(()=>finalizeConstructionBatch(f.root,f.job),{code:'LEGACY_WORKFLOW_READONLY'});
 assert.equal(readFileSync(f.file,'utf8'),f.before);assert.equal(existsSync(join(f.root,'01-Cards')),false);
});
test('history can be read but resume, retry and review preserve immutable task data',async t=>{
 const f=fixture(t),ctx={settings:{get:()=>({})}},api=async(method,tail='',body={})=>{let status,data;const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{url:'/api/uno/jobs/retired'+tail,method,headers:{'content-type':'application/json'}});await handleUnoApi(ctx,req,{writeHead(code){status=code;},end(value){data=JSON.parse(value);}},f.root);return{status,data};};
 const read=await api('GET');assert.equal(read.data.readonly,true);assert.match(read.data.readonly_reason,/历史|退役/);assert.equal(readFileSync(f.file,'utf8'),f.before);
 for(const action of ['resume','retry','review']){await assert.rejects(api('POST','/'+action,{version:f.job.version}),error=>error.status===409);assert.equal(readFileSync(f.file,'utf8'),f.before);}
});
test('book and construction retain distinct current dispatch contracts',()=>{
 assert.equal(isCurrentUnoJob({mode:'compile',workflow:'uno-unit-compile-v2'}),true);assert.equal(isCurrentUnoJob({mode:'construct',workflow:'uno-compile-v3'}),true);
 assert.equal(isCurrentUnoJob({mode:'construct',workflow:'uno-unit-compile-v2'}),false);
});
