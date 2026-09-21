import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { HarnessGateway } from '../../packages/nexogenesis-tools/lib/harness/gateway.js';
import { preprocessSource } from '../../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { readDraft } from '../../packages/nexogenesis-tools/lib/uno/drafts.js';
import { invalidateKnowledgeSnapshot } from '../../packages/nexogenesis-tools/lib/cards.js';
import { prepareSourceFixture } from './uno-source.mjs';
import { readUnoReceipt } from '../../packages/nexogenesis-tools/lib/harness/uno-storage.js';

export function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'uno-knowledge-'));const gateway=new HarnessGateway(root);
 const put=(ref,text)=>{mkdirSync(dirname(join(root,ref)),{recursive:true});writeFileSync(join(root,ref),text);invalidateKnowledgeSnapshot(root);};
 mkdirSync(join(root,'01-Cards'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const prep=async(text='# 第一章 参与\n\n材料提出要区分意见表达与共同决策。数字 987654 保留。\n\n# 第二章 案例\n\n甲港记录了协商变化，作者保留不同意见。')=>{
  put('00-Inbox/book.md',text);return prepareSourceFixture(root,{source:'00-Inbox/book.md',prepared:await preprocessSource(root,'00-Inbox/book.md',undefined,true,'book')});
 };
 // Simulate independent approval of synthetic fixtures via the current shared Gateway.
 const commit=input=>{
  const task='fixture-'+input.key,r=gateway.stageUnoKnowledge({task,...input});
  if(!r.staged)return r;
  const receipt=readUnoReceipt(root,input.key+'-publish');if(receipt)return receipt;
  const d=readDraft(root,task,input.id);
  return gateway.publishUnoKnowledge({task,key:input.key+'-publish',ids:[input.id],reviews:{[input.id]:{revision:d.revision,issues:[]}}});
 };
 const write=(id,sources,extra={})=>commit({key:'write-'+id,id,title:'知识 '+id,summary:'材料对具体社会过程的整理。',type:'case',domains:[],boundary:'材料仅支持本例，不推定普遍因果。',body:'材料描述了参与过程、不同立场和成立条件，未将案例视为普遍证明。',sources,...extra});
 return {root,gateway,put,prep,write,commit};
}
