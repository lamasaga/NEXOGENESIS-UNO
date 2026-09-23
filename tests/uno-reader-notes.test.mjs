import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { commitCard, loadCards } from '../packages/nexogenesis-tools/lib/cards.js';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { readReaderNotes } from '../packages/nexogenesis-tools/lib/uno/reader-notes.js';
import { unoCardRef, unoRevision } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { handleCardWrite } from '../packages/nexogenesis-web-host/lib/card-writing.js';
import { handleCardGet } from '../packages/nexogenesis-web-host/lib/graph.js';

function fixture(t,id='中文 card%20') {
  const root=mkdtempSync(join(tmpdir(),'uno-reader-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const dir of ['01-Cards','03-Archive','06-Journal','.nexogenesis'])mkdirSync(join(root,dir),{recursive:true});
  commitCard(root,{id,title:'激励机制',type:'mechanism',domains:[],sources:['05-Buffer/_index/unit.md'],relations:[],origin:'document',maturity:'growing',body:'## 作用过程\n\n不同的动机，也可能促成相似的行动。'});
  const card=loadCards(root).get(id),ref=unoCardRef(root,card),revision=unoRevision(root,ref);
  return {root,id,ref,revision,card,gateway:new HarnessGateway(root)};
}
const noteInput=f=>({key:'reader/test-request',author:'user',card_id:f.id,operation:'note',text:'需要区分行为和动机。',expected_revision:f.revision,note_id:'note-00000001',expected_note_revision:null,anchor:{block:'不同的动机，也可能促成相似的行动。',block_start:9,quote:'不同的动机',start:0,end:5}});
const response=()=>({data:'',setHeader(){},writeHead(status){this.status=status;},end(data=''){this.data+=data;}});
test('notes are durable Markdown with real receipts, do not change card or become cards, and replay safely',t=>{
  const f=fixture(t),before=readFileSync(join(f.root,f.ref),'utf8'),input=noteInput(f);input.anchor.block_start=f.card.body.indexOf(input.anchor.block);
  const receipt=f.gateway.writeReaderEntry(input);assert.equal(receipt.accepted,true);assert.deepEqual(f.gateway.writeReaderEntry(input),receipt);
  assert.equal(readFileSync(join(f.root,f.ref),'utf8'),before);assert.equal(loadCards(f.root).size,1);
  const notes=readReaderNotes(f.root,f.id);assert.equal(notes.length,1);assert.equal(notes[0].text,input.text);assert.equal(notes[0].author,'user');assert.equal(notes[0].anchor.quote,'不同的动机');
  assert.match(readFileSync(join(f.root,receipt.ref),'utf8'),/kind: uno-reader-note-v1/);
  assert.throws(()=>f.gateway.writeReaderEntry({...input,text:'不同内容'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('body edits preserve sources, domains and relations; archive prior revision and reject stale writes',t=>{
  const f=fixture(t),before=readFileSync(join(f.root,f.ref),'utf8');
  f.gateway.writeReaderEntry({key:'reader/body-1',author:'user',card_id:f.id,operation:'body',text:'## 作用过程\n\n我的补充正文。',expected_revision:f.revision});
  const card=loadCards(f.root).get(f.id);for(const key of ['sources','relations','domains','origin','id','type'])assert.deepEqual(card.meta[key],f.card.meta[key]);
  assert.equal(card.meta.last_edited_by,'user');assert.equal(readFileSync(join(f.root,`03-Archive/card-history/${f.id}/${f.revision}.md`),'utf8'),before);
  assert.throws(()=>f.gateway.writeReaderEntry({...noteInput(f),anchor:null}),e=>e.code==='REVISION_CONFLICT');
});
test('note edits use their own revisions, preserve anchors, and retain history',t=>{
  const f=fixture(t),input={...noteInput(f),anchor:null};const first=f.gateway.writeReaderEntry(input);
  const next={...input,key:'reader/note-next',expected_note_revision:first.revision,text:'重新表达想法。'};
  f.gateway.writeReaderEntry(next);assert.equal(readReaderNotes(f.root,f.id)[0].text,next.text);
  assert.throws(()=>f.gateway.writeReaderEntry({...next,key:'reader/stale-edit'}),e=>e.code==='REVISION_CONFLICT');
  assert.ok(existsSync(join(f.root,'03-Archive/reader-note-history')));
});
test('rejects traversal, unknown operation, invalid anchors and false authors',t=>{
  const f=fixture(t),input=noteInput(f);
  for(const extra of [{card_id:'../oops'},{author:'model'},{operation:'delete'},{note_id:'../../bad'},{anchor:{...input.anchor,block_start:900}}])assert.throws(()=>f.gateway.writeReaderEntry({...input,...extra}));
  assert.equal(readReaderNotes(f.root,f.id).length,0);
});
test('write API requires bound library, supports unicode IDs and returns conflict; card GET exposes durable notes',async t=>{
  const f=fixture(t);let res=response();await handleCardGet({},null,res,[],f.root,f.id);const card=JSON.parse(res.data);assert.equal(card.edit_id,`kb:legacy:${f.id}`);assert.equal(card.revision,f.revision);
  const payload={operation:'note',text:'整卡想法',expected_revision:card.revision,request_id:'request-0001',note_id:'note-00000002',expected_note_revision:null};
  const req=()=>Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]),{headers:{'content-type':'application/json'}});
  await assert.rejects(handleCardWrite(req(),response(),f.root,f.id),e=>e.status===400);
  res=response();await handleCardWrite(req(),res,f.root,card.edit_id);assert.equal(res.status,200);
  res=response();await handleCardGet({},null,res,[],f.root,f.id);assert.equal(JSON.parse(res.data).user_notes[0].text,'整卡想法');
  payload.expected_revision='a'.repeat(64);payload.request_id='request-0002';await assert.rejects(handleCardWrite(req(),response(),f.root,card.edit_id),e=>e.status===409);
});
