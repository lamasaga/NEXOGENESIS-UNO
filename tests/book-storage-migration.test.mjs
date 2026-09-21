import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {unoMarkdown,unoRevision,sha} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {parseCardFile} from '../packages/nexogenesis-tools/lib/cards.js';
import {readBookUnit} from '../packages/nexogenesis-tools/lib/uno/book-sources.js';
import {validateSource} from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import {handleCardGet} from '../packages/nexogenesis-web-host/lib/graph.js';
import {handleUnoApi} from '../packages/nexogenesis-web-host/lib/uno-jobs.js';

function fixture(t){
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'uno-storage-migration-'));
 t.after(()=>{assert.ok(resolve(root).startsWith(parent+sep));rmSync(root,{recursive:true,force:true});});
 const put=(ref,data)=>{mkdirSync(dirname(join(root,ref)),{recursive:true});writeFileSync(join(root,ref),data);};
 const source='00-Inbox/book.md',text='旧任务的完整章节正文。',prepared={fingerprint:sha(text),format:'markdown',title:'样本',chapters:[{title:'第一章',text,physical_pages:[1]}],assets:[{name:'a.png',data:Buffer.from('image').toString('base64'),locator:'物理页 1'}]};
 put(source,text);const gateway=new HarnessGateway(root),modern=gateway.prepareBookSource({source,prepared});
 const legacy=ref=>ref.replace(/^05-Buffer\//,'03-Archive/');
 for(const asset of modern.assets){put(legacy(asset.ref),readFileSync(join(root,asset.ref)));unlinkSync(join(root,asset.ref));}
 const units=modern.units.map(unit=>{const body=readFileSync(join(root,unit.ref),'utf8').replaceAll('05-Buffer/books/','03-Archive/books/');put(legacy(unit.ref),body);unlinkSync(join(root,unit.ref));return {...unit,ref:legacy(unit.ref),revision:sha(body)};});
 const catalog=parseCardFile(join(root,modern.catalog_ref)),catalog_ref=legacy(modern.catalog_ref);
 put(catalog_ref,unoMarkdown({...catalog.meta,units,assets:catalog.meta.assets.map(a=>({...a,ref:legacy(a.ref)}))},catalog.body.replaceAll('05-Buffer/books/','03-Archive/books/')));unlinkSync(join(root,modern.catalog_ref));
 unlinkSync(join(root,'.nexogenesis/uno-receipts',sha(modern.key)+'.json'));
 put('01-Cards/sample.md',unoMarkdown({id:'sample',title:'既有卡',type:'claim',domains:[],sources:[units[0].ref+'#char-0-8'],relations:[]},'使用图示 ![]('+legacy(modern.assets[0].ref)+')'));
 put('.nexogenesis/uno-jobs/old.json',JSON.stringify({id:'old',status:'paused',book_units:units}));
 return {root,put,source,prepared,gateway,modern,units,catalog_ref,revision:unoRevision(root,catalog_ref)};
}
async function read(root,id){let value;await handleCardGet({},null,{writeHead(){},end(data){value=JSON.parse(data);}},[],root,id);return value;}

test('move immutable materials to Buffer without changing cards, task hashes or old source URLs; reprepare reuses them',async t=>{
 const f=fixture(t),input={catalog_ref:f.catalog_ref,revision:f.revision};
 const untouched=['01-Cards/sample.md','.nexogenesis/uno-jobs/old.json',f.modern.source_ref].map(ref=>[ref,unoRevision(f.root,ref)]);
 const preview=f.gateway.migrateBookMaterialStorage({...input,check_only:true});assert.equal(preview.file_count,3);
 const receipt=f.gateway.migrateBookMaterialStorage(input);
 for(const file of receipt.files){assert.equal(existsSync(join(f.root,file.from)),false);assert.equal(unoRevision(f.root,file.to),file.revision);}
 assert.equal(existsSync(join(f.root,f.catalog_ref.replace('/catalog.md',''))),false);
 for(const [ref,revision] of untouched)assert.equal(unoRevision(f.root,ref),revision);
 const page=readBookUnit(f.root,{book_units:f.units},{ref:f.units[0].ref});assert.equal(page.text,f.prepared.chapters[0].text);
 assert.equal(validateSource(f.root,f.units[0].ref+'#char-0-8').revision,f.units[0].revision);
 assert.equal((await read(f.root,'book:'+f.units[0].ref+':0')).body,page.text);
 const card=await read(f.root,'sample');assert.equal(card.assets.length,1);
 let image;await handleUnoApi({}, {url:card.assets[0].url,method:'GET'}, {setHeader(){},end(v){image=v;}},f.root);assert.equal(image.toString(),'image');
 const prepared=f.gateway.prepareBookSource({source:f.source,prepared:f.prepared});
 assert.ok(prepared.units[0].ref.startsWith('05-Buffer/books/'));assert.equal(prepared.units[0].revision,f.units[0].revision);
 assert.equal((await read(f.root,'book:'+prepared.units[0].ref+':0')).assets.length,1);
 assert.deepEqual(f.gateway.migrateBookMaterialStorage(input),receipt);
});

test('migration rejects conflicts, unexpected files, changed evidence and active tasks without removing originals',t=>{
 for(const mode of ['conflict','unexpected','changed','running']){
  const f=fixture(t),input={catalog_ref:f.catalog_ref,revision:f.revision};
  if(mode==='conflict')f.put(f.catalog_ref.replace(/^03-Archive\//,'05-Buffer/'),'other content');
  if(mode==='unexpected')f.put(f.catalog_ref.replace('catalog.md','notes.txt'),'manual notes');
  if(mode==='changed')f.put(f.units[0].ref,'changed source');
  if(mode==='running')f.put('.nexogenesis/uno-jobs/active.json','{"status":"running"}');
  assert.throws(()=>f.gateway.migrateBookMaterialStorage(input));assert.equal(unoRevision(f.root,f.catalog_ref),f.revision);
 }
});
