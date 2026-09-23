import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unoPreparation } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';

test('compile preparation measures Inbox files before deciding whether they can be selected',t=>{
  const root=mkdtempSync(join(tmpdir(),'uno-inbox-compilation-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'00-Inbox'),{recursive:true});
  writeFileSync(join(root,'00-Inbox','small.epub'),Buffer.alloc(1024));
  writeFileSync(join(root,'00-Inbox','large.epub'),Buffer.alloc(0));
  truncateSync(join(root,'00-Inbox','large.epub'),50*1024*1024+1);

  const preparation=unoPreparation({settings:{get:()=>({})}},root);
  const small=preparation.sources.find(source=>source.path==='small.epub');
  const large=preparation.sources.find(source=>source.path==='large.epub');

  assert.equal(small.size,1024);
  assert.equal(small.compile_available,true);
  assert.equal(small.compile_unavailable_reason,undefined);
  assert.equal(large.size,50*1024*1024+1);
  assert.equal(large.compile_available,false);
  assert.match(large.compile_unavailable_reason,/50 MiB/);
});
