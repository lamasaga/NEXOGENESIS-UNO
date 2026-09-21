import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanCards, loadCards, resetKnowledgeSnapshot } from '../packages/nexogenesis-tools/lib/cards.js';
import { buildCardCatalog } from '../packages/nexogenesis-web-host/lib/graph.js';
import { configureInstanceContext, registerExistingKnowledgeInstance, readInstanceRegistry, activateKnowledgeInstance, unregisterKnowledgeInstance, subscribeActiveInstance } from '../packages/nexogenesis-tools/lib/instances/registry.js';
import { transaction, readUnoReceipt, inspectUnoLock } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
const fixture = () => mkdtempSync(join(tmpdir(), 'uno-resilience-'));

test('元数据损坏和字段错误不能初始化或写回，首次无文件仍可初始化', () => {
  const root=fixture();
  const module=new URL('../packages/nexogenesis-web-host/lib/meta.js',import.meta.url).href;
  const code=`import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import assert from 'node:assert/strict';import {readMeta,writeMeta,ensureDefaultProject} from ${JSON.stringify(module)};
  const file=join(process.env.DSH_HOME,'nexogenesis-meta.json');ensureDefaultProject();
  for(const content of ['{"projects":',JSON.stringify({projects:[],conversations:{},deleted:{}})]) {writeFileSync(file,content);assert.throws(()=>readMeta(),e=>e.code.startsWith('META_'));assert.throws(()=>writeMeta());assert.throws(()=>ensureDefaultProject());assert.equal(readFileSync(file,'utf8'),content);}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,DSH_HOME:root},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('离线登记项不阻断正常库，可移出登记但不可激活', () => {
  const root=fixture(),a=join(root,'a'),b=join(root,'b'),reg=join(root,'registry.json');
  mkdirSync(join(a,'01-Cards'),{recursive:true});mkdirSync(join(b,'01-Cards'),{recursive:true});
  configureInstanceContext({registryPath:reg,fallbackRoot:a});
  const item=registerExistingKnowledgeInstance(reg,b,'B');renameSync(b,b+'-offline');
  const result=readInstanceRegistry(reg);assert.equal(result.instances[0].status,'available');assert.equal(result.instances[1].status,'unavailable');
  assert.throws(()=>activateKnowledgeInstance(reg,item.id),e=>e.code==='INSTANCE_UNAVAILABLE');
  unregisterKnowledgeInstance(reg,item.id);assert.equal(readInstanceRegistry(reg).instances.length,1);assert.ok(existsSync(b+'-offline'));
});

test('订阅者失败不阻止后续身份订阅者接收已经提交的切库', () => {
  const root=fixture(),reg=join(root,'registry.json');mkdirSync(join(root,'01-Cards'));
  configureInstanceContext({registryPath:reg,fallbackRoot:root});let observed;
  const off1=subscribeActiveInstance(()=>{throw Error('fault');}),off2=subscribeActiveInstance(x=>{observed=x.id;});
  try {const active=activateKnowledgeInstance(reg,'legacy');assert.equal(observed,'legacy');assert.deepEqual(active.warnings,['INSTANCE_SUBSCRIBER_FAILED']);} finally {off1();off2();}
});

test('损坏卡片只读可见缺口，严格读取不允许基于部分库写入', () => {
  const root=fixture(),dir=join(root,'01-Cards');mkdirSync(dir);
  writeFileSync(join(dir,'good.md'),'---\nid: good\ntitle: Good\ntype: claim\n---\nbody');
  writeFileSync(join(dir,'bad.md'),'---\nid: [bad\n---\nbody');
  const result=scanCards(root);assert.equal(result.status,'partial');assert.equal(result.cards.size,1);assert.equal(result.diagnostics.failures.length,1);
  assert.throws(()=>loadCards(root),e=>e.code==='KNOWLEDGE_INCOMPLETE');
  const catalog=buildCardCatalog(root);assert.equal(catalog.all_total,1);assert.equal(catalog.snapshot_status,'partial');
  writeFileSync(join(dir,'bad.md'),'---\nid: repaired\n---\nbody');resetKnowledgeSnapshot(root);assert.equal(scanCards(root).status,'complete');
  renameSync(dir,dir+'-offline');resetKnowledgeSnapshot(root);assert.equal(scanCards(root).status,'unavailable');
});

test('owner 写入失败释放自己的空锁，未知属主锁仍拒绝自动删除', () => {
  const root=fixture();
  assert.throws(()=>transaction(root,'owner',{},()=>{}, {checkpoint:stage=>{if(stage==='owner')throw Error('fault');}}));
  assert.equal(inspectUnoLock(root).status,'unlocked');
  mkdirSync(join(root,'.nexogenesis','uno-write-lock'));
  assert.throws(()=>transaction(root,'owner',{},()=>{}),e=>e.code==='WRITE_LOCK_RECOVERY_REQUIRED');
  assert.ok(existsSync(join(root,'.nexogenesis','uno-write-lock')));
});

for(const stage of ['transaction_cleanup','lock_cleanup']) test(`提交后 ${stage} 失败仍返回原收据`, () => {
  const root=fixture();let plans=0;
  const plan=()=>{plans++;return {writes:new Map([['01-Cards/x.md','complete']]),result:{summary:'test'}};};
  const result=transaction(root,stage,{a:1},plan,{checkpoint:name=>{if(name===stage)throw Error('fault');}});
  assert.equal(result.accepted,true);assert.equal(result.cleanup_pending,true);assert.equal(readUnoReceipt(root,stage).accepted,true);
  assert.equal(transaction(root,stage,{a:1},plan).at,result.at);assert.equal(plans,1);
});
