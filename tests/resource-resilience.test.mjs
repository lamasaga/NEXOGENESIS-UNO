import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscribeGraphEvents, broadcastGraphEvent, graphEventStats } from '../packages/nexogenesis-web-host/lib/events-bus.js';
import { searchKnowledge, sparseIndexStats } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { invalidateKnowledgeSnapshot } from '../packages/nexogenesis-tools/lib/cards.js';
import { PromptStore } from '../packages/nexogenesis-web-host/lib/prompt-inspector.js';

class Response extends EventEmitter {
  frames=[];destroyed=false;
  constructor(slow=false){super();this.slow=slow;}
  write(text){this.frames.push(text);return !this.slow;}
  destroy(){this.destroyed=true;this.emit('close');}
}
test('慢 SSE 客户端有界断开，不阻断其他客户端，drain 后继续',()=>{
  const slow=new Response(true),fast=new Response(),off1=subscribeGraphEvents('bounded',slow),off2=subscribeGraphEvents('bounded',fast);
  for(let i=0;i<1000;i++)broadcastGraphEvent('bounded',{type:'test',payload:{i}});
  assert.equal(slow.frames.length,1);assert.equal(slow.destroyed,true);assert.equal(fast.frames.length,1000);
  assert.ok(graphEventStats().queued_bytes<=256*1024);off1();off2();
  const draining=new Response(true),off=subscribeGraphEvents('drain',draining);
  broadcastGraphEvent('drain',{type:'one'});broadcastGraphEvent('drain',{type:'two'});assert.equal(draining.frames.length,1);
  draining.slow=false;draining.emit('drain');assert.equal(draining.frames.length,2);off();
});
test('事件历史有全局预算，游标只能在相同代次重放',()=>{
  for(let i=0;i<1000;i++)broadcastGraphEvent('session-'+i,{type:'test',payload:{value:'x'.repeat(4096)}});
  assert.ok(graphEventStats().sessions<=256);assert.ok(graphEventStats().history_bytes<=4*1024*1024);
  const initial=new Response(),off=subscribeGraphEvents('cursor',initial);broadcastGraphEvent('cursor',{type:'one'});broadcastGraphEvent('cursor',{type:'two'});off();
  const epoch=/^id: ([^:]+):/.exec(initial.frames[0])[1],replay=new Response(),stop=subscribeGraphEvents('cursor',replay,{epoch,after:1});assert.equal(replay.frames.length,1);stop();
  const old=new Response(),stopOld=subscribeGraphEvents('cursor',old,{epoch:'old',after:1});assert.equal(old.frames.length,0);stopOld();
});
test('单卡修改只重新分词该卡，索引写盘失败不丢失可用检索',()=>{
  const root=mkdtempSync(join(tmpdir(),'uno-incremental-')),dir=join(root,'01-Cards');mkdirSync(dir);
  const card=(id,body)=>`---\nid: ${id}\ntitle: ${id}\ntype: claim\n---\n${body}`;
  for(let i=0;i<20;i++)writeFileSync(join(dir,`${i}.md`),card('card'+i,'检索测试正文'));
  searchKnowledge(root,{query:'检索'});assert.equal(sparseIndexStats(root).tokenized_documents,20);
  writeFileSync(join(dir,'0.md'),card('card0','新的文本可检索'));invalidateKnowledgeSnapshot(root);
  searchKnowledge(root,{query:'新的文本'});assert.equal(sparseIndexStats(root).tokenized_documents,1);
  mkdirSync(join(root,'.nexogenesis','uno-sparse-index.json.tmp'));
  writeFileSync(join(dir,'1.md'),card('card1','保存失败仍能检索'));invalidateKnowledgeSnapshot(root);
  const result=searchKnowledge(root,{query:'保存失败'});assert.ok(result.items.length);assert.equal(result.cache_warning,'SPARSE_INDEX_PERSIST_FAILED');
});
test('增量输出不重复保存大输入，终态保存且旧格式仍可读取',()=>{
  const root=mkdtempSync(join(tmpdir(),'uno-input-once-')),store=new PromptStore(root);
  const writes=[],write=store.write.bind(store);store.write=(file,value)=>{writes.push([file,JSON.stringify(value).length]);write(file,value);};
  const record=store.begin({provider:'test',model:'test',messages:[{role:'user',content:'x'.repeat(100000)}]},{});
  for(let i=0;i<10;i++){record.output.blocks=[{type:'text',text:'answer'.repeat(i+1)}];store.save(record);}
  assert.equal(writes.filter(([file])=>file.endsWith('.input')).length,1);
  assert.ok(writes.filter(([file])=>file===record.id+'.json').every(([,size])=>size<1000));
  assert.equal(new PromptStore(root).get(record.id).input.messages[0].content.length,100000);
});
