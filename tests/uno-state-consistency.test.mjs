import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCompileJob, saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';

test('stale executor checkpoints preserve newer monotonic control flags',t=>{
  const root=mkdtempSync(join(tmpdir(),'uno-state-control-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const job={id:'job',status:'running',detail:'start',stop_after_batch:false};saveCompileJob(root,job);
  const stale=structuredClone(job),control=readCompileJob(root,'job');control.stop_after_batch=true;saveCompileJob(root,control);
  stale.detail='checkpoint';saveCompileJob(root,stale);
  const saved=readCompileJob(root,'job');assert.equal(saved.detail,'checkpoint');assert.equal(saved.stop_after_batch,true);assert.ok(saved.version>control.version);
});

test('compare-and-swap rejects a stale command snapshot',t=>{
  const root=mkdtempSync(join(tmpdir(),'uno-state-cas-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const job={id:'job',status:'paused'};saveCompileJob(root,job);
  const stale=structuredClone(job),current=readCompileJob(root,'job');current.detail='newer';saveCompileJob(root,current);
  assert.throws(()=>saveCompileJob(root,stale,{expectedVersion:stale.version}),error=>error.code==='UNO_JOB_VERSION_CONFLICT');
  assert.equal(readCompileJob(root,'job').detail,'newer');
});
