import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { unoMarkdown, sha } from '../../packages/nexogenesis-tools/lib/harness/uno-storage.js';
// Synthetic pre-existing source records for construction and historical reading tests.
// This only sets up test data; it implements no ingestion, selection or execution flow.
export function prepareSourceFixture(root,{source,prepared,theme='fixture'}) {
 const units=prepared.chapters.map((chapter,index)=>{
  const id=sha(source).slice(0,16)+'-'+index,ref='05-Buffer/_index/'+id+'.md',target='05-Buffer/'+theme+'/'+id+'.md';
  for(const path of [ref,target])mkdirSync(dirname(join(root,path)),{recursive:true});
  writeFileSync(join(root,ref),unoMarkdown({kind:'uno-material-index',unit_id:id,target},'Synthetic source pointer.'));
  writeFileSync(join(root,target),unoMarkdown({kind:'uno-raw-v3',title:chapter.title,source,source_metadata:prepared.source_metadata??'',source_sha256:prepared.fingerprint,unit_id:id,locator:chapter.locator,status:'pending',classification:'reviewed',material_kind:prepared.material_kind??'article'},chapter.text));
  return {ref,id,title:chapter.title,locator:chapter.locator,chars:Array.from(chapter.text).length};
 });
 return {source,original_source:source,units,assets:[],warnings:prepared.warnings??[]};
}
