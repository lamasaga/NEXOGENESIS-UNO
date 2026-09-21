import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/uno-knowledge.mjs';
import { readPreferences,savePreferences,freezePreferences } from '../packages/nexogenesis-tools/lib/uno/preferences.js';
import { publicAddress,downloadImage } from '../packages/nexogenesis-tools/lib/uno/assets.js';
import { readDraft,validateSource } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { unoRevision,unoMarkdown,transaction } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { loadCards } from '../packages/nexogenesis-tools/lib/cards.js';
import { handleCardGet } from '../packages/nexogenesis-web-host/lib/graph.js';
import { handleUnoApi } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import { preprocessSource } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';

test('写入中断恢复回滚未完成批次，不覆盖外部变化',t=>{
 const f=fixture(t);f.put('01-Cards/recover.md','after');
 const record=(before,after)=>JSON.stringify({key:'interrupted',rows:[{ref:'01-Cards/recover.md',before:Buffer.from(before).toString('base64'),after:Buffer.from(after).toString('base64')}]});
 f.put('.nexogenesis/uno-transactions/crash.json',record('before','after'));
 transaction(f.root,'trigger',{},()=>({writes:new Map(),result:{}}));assert.equal(readFileSync(join(f.root,'01-Cards/recover.md'),'utf8'),'before');
 f.put('.nexogenesis/uno-transactions/crash.json',record('original','staged'));
 assert.throws(()=>transaction(f.root,'other',{},()=>({writes:new Map(),result:{}})),/外部修改/);
 assert.equal(readFileSync(join(f.root,'01-Cards/recover.md'),'utf8'),'before');
});

test('建构刷新外部正文和版本，发布沿用真实文件名',async t=>{
 const f=fixture(t),info=await f.prep(),source=info.units[0].ref;
 f.put('01-Cards/旧文件名.md',unoMarkdown({id:'a',title:'原卡',summary:'原摘要',tags:['机制'],boundary:'仅限样例',sources:[source],relations:[]},'原始正文'));
 loadCards(f.root);const stale=unoRevision(f.root,'01-Cards/旧文件名.md');
 f.put('01-Cards/旧文件名.md',readFileSync(join(f.root,'01-Cards/旧文件名.md'),'utf8')+'\n外部新增的条件。');
 assert.throws(()=>f.commit({key:'stale',id:'a',action:'patch',revision:stale,title:'新名'}),/变化/);
 f.commit({key:'current',id:'a',action:'patch',revision:unoRevision(f.root,'01-Cards/旧文件名.md'),title:'新名'});
 assert.equal(existsSync(join(f.root,'01-Cards/a.md')),false);assert.match(loadCards(f.root).get('a').body,/外部新增/);
});

test('来源修改或旧审核版本使发布失败，失败批次没有半张正式卡',async t=>{
 const f=fixture(t),info=await f.prep(),source=info.units[0].ref;
 for(const id of ['a','b'])f.gateway.stageUnoKnowledge({task:'test',key:'stage-'+id,id,title:id,summary:'摘要',type:'case',domains:[],boundary:'仅限样例',body:'需要保留完整正文',sources:[source]});
 const a=readDraft(f.root,'test','a'),b=readDraft(f.root,'test','b');
 assert.throws(()=>f.gateway.publishUnoKnowledge({task:'test',key:'wrong',ids:['a','b'],reviews:{a:{revision:a.revision,issues:[]},b:{revision:'wrong',issues:[]}}}),/对应版本/);
 assert.equal(loadCards(f.root).size,0);
 const physical=(await import('../packages/nexogenesis-tools/lib/harness/uno-storage.js')).readUnoUnit(f.root,source).physical_ref;
 f.put(physical,readFileSync(join(f.root,physical),'utf8')+'\n新证据');
 assert.throws(()=>f.gateway.publishUnoKnowledge({task:'test',key:'changed',ids:['a'],reviews:{a:{revision:a.revision,issues:[]}}}),/来源内容已变化/);
 assert.equal(loadCards(f.root).size,0);
});

test('旧编译草稿不能绕过只读任务通过共享发布入口写卡',async t=>{
 const f=fixture(t),info=await f.prep();
 saveCompileJob(f.root,{id:'old',mode:'compile',workflow:'uno-compile-v3',batch_index:0,status:'running'});
 f.gateway.stageUnoKnowledge({task:'old-b0',key:'old-stage',id:'a',title:'旧稿',summary:'摘要',type:'case',domains:[],boundary:'样例',body:'旧稿',sources:[info.units[0].ref]});
 const d=readDraft(f.root,'old-b0','a');
 assert.throws(()=>f.gateway.publishUnoKnowledge({task:'old-b0',key:'old-publish',ids:['a'],reviews:{a:{revision:d.revision,issues:[]}}}),/旧编译草稿只读/);
 assert.equal(loadCards(f.root).size,0);
});

test('新图书字符来源可供建构发布；越界或篡改的来源会拒绝',async t=>{
 const f=fixture(t);f.put('00-Inbox/new.md','# 新章节\n\n经济约束😀需要区分成立条件。');
 const info=f.gateway.prepareBookSource({source:'00-Inbox/new.md',prepared:await preprocessSource(f.root,'00-Inbox/new.md',undefined,true,'book')});
 const unit=info.units[0],ref=unit.ref+'#char-0-'+unit.chars;
 assert.equal(validateSource(f.root,ref).file,unit.ref);
 assert.throws(()=>validateSource(f.root,unit.ref+'#char-0-99999'),/字符范围/);
 f.write('new',[ref]);f.commit({key:'revise-new',id:'new',action:'patch',revision:unoRevision(f.root,'01-Cards/new.md'),title:'经济约束的成立条件'});
 assert.equal(loadCards(f.root).get('new').meta.title,'经济约束的成立条件');
 f.put(unit.ref,readFileSync(join(f.root,unit.ref),'utf8')+'\n被改动');assert.throws(()=>validateSource(f.root,ref),/已变化/);
});

test('新归档图片仅在卡片正文显式引用时展示，图片路径逃逸与私网下载拒绝',async t=>{
 const f=fixture(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=','base64');
 f.put('00-Inbox/image.png',png);f.put('00-Inbox/visual.md','图示来源。\n![合成图像](image.png)');
 const info=f.gateway.prepareBookSource({source:'00-Inbox/visual.md',prepared:await preprocessSource(f.root,'00-Inbox/visual.md',undefined,true,'book')});
 assert.equal(info.assets.length,1);f.write('visual',[info.units[0].ref+'#char-0-'+info.units[0].chars],{body:`材料中的图像只在本卡明确使用时展示。\n\n![合成图像](${info.assets[0].ref})`});
 let card;await handleCardGet({},null,{writeHead(){},end(v){card=JSON.parse(v);}},[],f.root,'visual');assert.equal(card.assets.length,1);
 let data;await handleUnoApi({}, {url:card.assets[0].url,method:'GET'}, {setHeader(){},end(v){data=v;}},f.root);assert.deepEqual(data,png);
 await assert.rejects(handleUnoApi({}, {url:'/api/uno/assets?ref=03-Archive/assets/../../../../secret.png',method:'GET'}, {setHeader(){},end(){}},f.root));
 for(const ip of ['127.0.0.1','10.0.0.1','::1','::ffff:127.0.0.1','169.254.169.254'])assert.equal(publicAddress(ip),false);
 await assert.rejects(downloadImage('http://127.0.0.1/x'),/公开网络/);
});
test('长偏好冻结、并发修订检测、超预算原文不裁剪',async t=>{
 const f=await fixture(t),old=readPreferences(f.root);savePreferences(f.root,{...old,prompt:'保留关键案例'});assert.throws(()=>savePreferences(f.root,{...old,prompt:'覆盖'}),/已变化/);
 const snapshot=await freezePreferences(f.root,{notes:'保留相反立场'},'unknown',f.root);assert.equal(snapshot.long_term,'保留关键案例');assert.equal(snapshot.notes,'保留相反立场');assert.equal(snapshot.usage.exact,false);
 await assert.rejects(freezePreferences(f.root,{notes:'中'.repeat(3001)},'unknown',f.root),/超过 3000/);assert.equal(readPreferences(f.root).prompt,'保留关键案例');
});
