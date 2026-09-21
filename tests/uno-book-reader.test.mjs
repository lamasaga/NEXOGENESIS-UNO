import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {sha,unoMarkdown} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {handleCardGet} from '../packages/nexogenesis-web-host/lib/graph.js';
import {configureInstanceContext,registerExistingKnowledgeInstance} from '../packages/nexogenesis-tools/lib/instances/registry.js';
import { assetsForBookUnit } from '../packages/nexogenesis-tools/lib/uno/book-sources.js';
import { readBookUnit } from '../packages/nexogenesis-tools/lib/uno/book-sources.js';
import { parseCardFile } from '../packages/nexogenesis-tools/lib/cards.js';
import { handleUnoApi } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import { validateSource } from '../packages/nexogenesis-tools/lib/uno/drafts.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'uno-book-reader-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;
}
function prepare(root,{text='甲😀乙：条件与反例都保留。\n\n第二段说明证据边界。',title='合成图书',assets=[]}={}){
 mkdirSync(join(root,'00-Inbox'),{recursive:true});mkdirSync(join(root,'01-Cards'),{recursive:true});
 const source='00-Inbox/book.pdf',bytes=Buffer.from('synthetic PDF original '+text);writeFileSync(join(root,source),bytes);
 const info=new HarnessGateway(root).prepareBookSource({source,prepared:{fingerprint:sha(bytes),format:'pdf',title,chapters:[{title:'第二章 · 机制边界',locator:'原书第 12–13 页；第二章',physical_pages:[12,13],text}],warnings:[],assets}});
 return {...info,text};
}
async function read(root,id){let payload;await handleCardGet({},null,{writeHead(status){assert.equal(status,200);},end(text){payload=JSON.parse(text);}},[],root,id);return payload;}

test('book source reader returns exact Buffer body, archived original and chapter/page location without a session job',async t=>{
 const root=fixture(t),book=prepare(root),ref=book.units[0].ref;
 assert.equal(existsSync(join(root,'.nexogenesis/uno-jobs')),false);
 const result=await read(root,'book:'+ref+':0');assert.equal(result.body,book.text);assert.equal(result.title,'第二章 · 机制边界');
 assert.equal(validateSource(root,ref+'#char-0-5').revision,book.units[0].revision);
 assert.throws(()=>validateSource(root,ref+'#char-0-99999'),/字符范围无效/);
 assert.match(result.summary,/合成图书/);assert.match(result.summary,/原书第 12–13 页；第二章/);assert.match(result.summary,/章内 Unicode 字符/);
 assert.deepEqual(result.sources,[book.source_ref]);assert.equal(result.type,'source');assert.equal(result.library_id,null);
 assert.equal((await read(root,'book:'+ref+':2')).body,Array.from(book.text).slice(2).join(''));
});

test('legacy Archive units still validate, read and show their own images',async t=>{
 const root=fixture(t),book=prepare(root,{assets:[{name:'figure.png',data:Buffer.from('image').toString('base64'),locator:'物理页 12'}]});
 const oldRef=ref=>ref.replace(/^05-Buffer\/books\//,'03-Archive/books/');
 for(const asset of book.assets){const target=join(root,oldRef(asset.ref));mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(root,asset.ref)));}
 const units=book.units.map(unit=>{
  const ref=oldRef(unit.ref),body=readFileSync(join(root,unit.ref),'utf8').replaceAll('05-Buffer/books/','03-Archive/books/');
  mkdirSync(dirname(join(root,ref)),{recursive:true});writeFileSync(join(root,ref),body);return {...unit,ref,revision:sha(body)};
 });
 const catalog=parseCardFile(join(root,book.catalog_ref));
 writeFileSync(join(root,oldRef(book.catalog_ref)),unoMarkdown({...catalog.meta,units,assets:book.assets.map(a=>({...a,ref:oldRef(a.ref)}))},catalog.body.replaceAll('05-Buffer/books/','03-Archive/books/')));
 const page=readBookUnit(root,{book_units:units},{ref:units[0].ref});assert.equal(page.text,book.text);
 assert.equal(validateSource(root,units[0].ref+'#char-0-5').revision,units[0].revision);
 const result=await read(root,'book:'+units[0].ref+':0');assert.equal(result.body,book.text);assert.equal(result.assets[0].ref,oldRef(book.assets[0].ref));
 assert.deepEqual(result.sources,[book.source_ref]);
});

test('asset endpoint serves Buffer book images but does not expose units, catalogs or arbitrary Buffer files',async t=>{
 const root=fixture(t),book=prepare(root,{assets:[{name:'figure.png',data:Buffer.from('image-bytes').toString('base64'),locator:'物理页 12'}]});
 const fetch=async ref=>{const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(data){this.data=data;}};await handleUnoApi({}, {url:'/api/uno/assets?ref='+encodeURIComponent(ref),method:'GET'},res,root);return res;};
 const image=await fetch(book.assets[0].ref);assert.equal(image.data.toString(),'image-bytes');assert.equal(image.headers['Content-Type'],'image/png');
 assert.equal((await fetch(book.source_ref)).data.toString(),'synthetic PDF original '+book.text);
 for(const ref of [book.units[0].ref,book.catalog_ref,'05-Buffer/_index/private.md',book.assets[0].ref.replace('/assets/','/assets/../')])
  await assert.rejects(fetch(ref),error=>error.status===403);
});

test('image ownership is not card evidence: only explicit card references produce attachments',async t=>{
 const root=fixture(t),book=prepare(root,{assets:[{name:'figure.png',data:Buffer.from('synthetic-image').toString('base64'),locator:'物理页 12'}]});
 for(const [id,body] of [['plain','卡片未使用图片'],['illustrated','图示依据：![]('+book.assets[0].ref+')']])
  writeFileSync(join(root,'01-Cards',id+'.md'),unoMarkdown({id,title:id,tags:['观点'],sources:[book.units[0].ref],relations:[]},body));
 assert.equal((await read(root,'plain')).assets.length,0);
 assert.equal((await read(root,'illustrated')).assets.length,1);
 const unrelated={name:'cover.jpg',ref:'assets/cover.jpg',locator:'EPUB cover.jpg'};
 assert.deepEqual(assetsForBookUnit([unrelated],'正文没有图片',{href:'same-spine.html'}),[]);
 assert.deepEqual(assetsForBookUnit([{name:'a.png',locator:'物理页 12'},{name:'b.png',locator:'物理页 27'}],'正文',{physical_pages:[12,13]}).map(a=>a.name),['a.png']);
});

test('canonical book identifiers refuse unrelated paths, wrong file types and out-of-range offsets',async t=>{
 const root=fixture(t),book=prepare(root),ref=book.units[0].ref;
 for(const id of ['book:'+book.source_ref+':0','book:'+book.catalog_ref+':0','book:01-Cards/private.md:0','book:'+ref.replace('/units/','/units/../../')+':0','book:'+ref.replaceAll('/','\\')+':0','book:'+ref+':-1','book:'+ref+':1.5','book:'+ref+':9007199254740993','book:'+ref+':999999'])
  await assert.rejects(read(root,id),error=>error.status===400);
 await assert.rejects(read(root,'book:'+ref.replace('c0001','c9999')+':0'),error=>error.status===404);
});

test('reader requires catalog membership and matching immutable unit contents',async t=>{
 const root=fixture(t),book=prepare(root),ref=book.units[0].ref,path=join(root,ref),original=readFileSync(path);
 writeFileSync(path,Buffer.concat([original,Buffer.from('\n追加的伪证据')]));
 await assert.rejects(read(root,'book:'+ref+':0'),error=>error.status===409);
 writeFileSync(path,original);unlinkSync(join(root,book.source_ref));
 await assert.rejects(read(root,'book:'+ref+':0'),error=>error.status===404);
});

test('large chapter reads complete physical units within 60000 Unicode characters',async t=>{
 const root=fixture(t),book=prepare(root,{text:'甲😀乙。'.repeat(9000)});assert.equal(book.units.length,1);
 let combined='';for(const unit of book.units){const result=await read(root,'book:'+unit.ref+':0');assert.ok(Array.from(result.body).length<=60000);combined+=result.body;}
 assert.equal(combined,book.text);
});

test('cross-library source lookup retains the selected scope for both text and archived assets',async t=>{
 const parent=fixture(t),primary=join(parent,'primary'),secondary=join(parent,'secondary');
 const first=prepare(primary,{text:'甲库专属材料。'}),second=prepare(secondary,{text:'乙库专属材料。',assets:[{name:'figure.png',data:Buffer.from('synthetic-image').toString('base64'),caption:'原书图一',locator:'物理页 12'}]});
 const registry=join(parent,'instances.json');configureInstanceContext({registryPath:registry,fallbackRoot:primary});const instance=registerExistingKnowledgeInstance(registry,secondary,'第二知识库');
 const scoped='kb:'+instance.id+':book:'+second.units[0].ref+':0',result=await read(primary,scoped);
 assert.equal(result.body,second.text);assert.notEqual(result.body,first.text);assert.equal(result.id,scoped);assert.equal(result.library_id,instance.id);
 assert.equal(result.assets.length,1);assert.match(result.assets[0].url,new RegExp('library_id='+instance.id));assert.ok(result.assets[0].url.includes(encodeURIComponent(second.assets[0].ref)));
 await assert.rejects(read(primary,'book:'+second.units[0].ref+':0'),error=>error.status===404);
 await assert.rejects(read(primary,'kb:missing:book:'+first.units[0].ref+':0'),error=>error.status===404);
 await assert.rejects(read(primary,'kb:'+instance.id+':book:'+first.units[0].ref+':0'),error=>error.status===404);
 writeFileSync(join(secondary,'01-Cards/fixture.md'),unoMarkdown({id:'fixture',title:'合成卡片',sources:[second.units[0].ref],relations:[],tags:['机制']},'测试读者从卡片跳转到真实来源。'));
 const card=await read(primary,'kb:'+instance.id+':fixture');assert.deepEqual(card.sources,[second.units[0].ref]);assert.equal(card.assets.length,0);assert.equal(card.library_id,instance.id);
});
