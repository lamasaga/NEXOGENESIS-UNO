import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {startUnoJob,handleUnoApi} from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import {saveCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';

// The selector + author-check + targeted-review controller is retired.
// Its former execution tests and implementation were removed together.
// Read-only rejection remains a current public contract.
test('harness-first compile creation is rejected before any host or model access',async t=>{
 const root=mkdtempSync(join(tmpdir(),'uno-retired-harness-first-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const ctx=new Proxy({},{get(){throw Error('unexpected host access');}});
 for(const input of [
  {mode:'compile',orchestration_profile:'bounded-workflow-v1',review_policy:'harness-first-v1'},
  {mode:'compile',compile_profile:'unit-cards-v2',review_policy:'harness-first-v1'},
 ])await assert.rejects(startUnoJob(ctx,root,input),error=>[400,409].includes(error.status));
});

test('harness-first historical handoff cannot be resumed or published through the current API',async t=>{
 const root=mkdtempSync(join(tmpdir(),'uno-retired-handoff-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const job={id:'retired-handoff',workflow:'uno-compile-v3',mode:'compile',review_policy:'harness-first-v1',status:'review',phase:'settle',version:0,calls:[],sources:[],failures:[],receipts:[],pending:{cards:[]}};
 saveCompileJob(root,job);const path=join(root,'.nexogenesis/uno-jobs',job.id+'.json'),before=readFileSync(path,'utf8');
 const ctx=new Proxy({},{get(){throw Error('unexpected host access');}});
 for(const action of ['resume','review','retry']){
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({version:job.version,decision:'save'}))]),{url:'/api/uno/jobs/'+job.id+'/'+action,method:'POST',headers:{'content-type':'application/json'}});
  await assert.rejects(handleUnoApi(ctx,req,{writeHead(){},end(){}},root),/历史记录/);
  assert.equal(readFileSync(path,'utf8'),before);
 }
});
