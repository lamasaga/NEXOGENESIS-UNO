import {loadCards,parseCardFile} from '../cards.js';
import {unoPath,unoRevision,unoCardRef,unoMarkdown,readUnoReceipt,sha} from '../harness/uno-storage.js';
import {listDrafts} from './drafts.js';

const retired=card=>['superseded','archived'].includes(card?.meta.lifecycle);
const taskOf=(job,index)=>`${job.id}-b${index}`;

/** Read actual publication receipts, never trust the task's embedded receipt copy. */
function publishedRetirements(root,job){
  const tasks=new Set((job.batches??[]).map((_,index)=>taskOf(job,index))),drafts=[];
  for(const task of tasks)for(const draft of listDrafts(root,task))if(draft.state==='published')drafts.push(draft);
  const keys=new Set([...(job.receipts??[]).map(row=>row.key),...drafts.map(row=>row.publication_key)].filter(Boolean)),proofs=new Map();
  for(const key of keys){
    let receipt;try{receipt=readUnoReceipt(root,key);}catch{continue;}
    if(!receipt?.accepted||receipt.key!==key)continue;
    if(receipt.publication&&tasks.has(receipt.publication.task)){
      for(const row of receipt.publication.retirements??[]){
        if(!receipt.card_ids?.includes(row.target)||!receipt.publication.cards?.some(card=>card.id===row.target))continue;
        proofs.set(row.id,{...row,receipt_key:key,task:receipt.publication.task});
      }
      continue;
    }
    // Older receipts have no retirement hashes. A published merge draft plus
    // the exact archived base bytes reconstructs the transaction's retired file.
    for(const draft of drafts){
      if(!key.startsWith(draft.task+':publish:')||!receipt.card_ids?.includes(draft.card.id))continue;
      for(const merge of draft.merges??[]){
        try{
          const historical=`03-Archive/card-history/${merge.id}/${merge.revision}.md`;
          if(unoRevision(root,historical)!==merge.revision)continue;
          const before=parseCardFile(unoPath(root,historical));
          const expected=unoMarkdown({...before.meta,lifecycle:'superseded',superseded_by:draft.card.id,updated:receipt.at.slice(0,10)},before.body);
          proofs.set(merge.id,{id:merge.id,ref:merge.ref,previous_revision:merge.revision,revision:sha(expected),target:draft.card.id,receipt_key:key,task:draft.task,legacy:true});
        }catch{/* Missing or altered history cannot establish successful retirement. */}
      }
    }
  }
  return proofs;
}

/** Pure current-state check. Resolved IDs are removed only from work, never from frozen scope. */
export function inspectConstructScope(root,job,index=job.batch_index){
  const ids=job.batches?.[index]??[];
  if(job.mode!=='construct'||job.construct_contract!=='scoped-review-v1')return {active_ids:[...ids],resolved:[],blocked:[]};
  const cards=loadCards(root,{includeInactive:true}),proofs=publishedRetirements(root,job),result={active_ids:[],resolved:[],blocked:[]},fresh=new Map();
  const currentCard=id=>{
    if(fresh.has(id))return fresh.get(id);
    const cached=cards.get(id);let card=null;
    if(cached){const ref=unoCardRef(root,cached);if(unoRevision(root,ref)!==null)card={...parseCardFile(unoPath(root,ref)),file:cached.file};}
    fresh.set(id,card);return card;
  };
  function verify(id,visited=new Set()){
    if(visited.has(id))return {code:'RETIREMENT_CYCLE',detail:'合并去向形成循环，未清除待办。'};
    const card=currentCard(id),proof=proofs.get(id);
    if(!card)return {code:'CARD_MISSING',detail:'范围中的卡片已缺失，未清除待办。'};
    if(!proof)return {code:'RETIREMENT_UNCONFIRMED',detail:'退役没有本任务成功发布收据，需核对去向。'};
    if(card.meta.lifecycle!=='superseded'||card.meta.superseded_by!==proof.target||unoCardRef(root,card)!==proof.ref||unoRevision(root,proof.ref)!==proof.revision)
      return {code:'RETIREMENT_CHANGED',detail:'退役文件、版本或去向与发布收据不一致，未清除待办。'};
    const target=currentCard(proof.target);
    if(!target)return {code:'RETIREMENT_TARGET_MISSING',detail:'合并承载卡已缺失，未清除待办。'};
    if(retired(target)){
      const next=verify(proof.target,new Set([...visited,id]));if(next.code)return next;
      return {...proof,redirect:next.redirect,chain:[id,...next.chain]};
    }
    if(target.meta.lifecycle!==undefined&&target.meta.lifecycle!=='active')return {code:'RETIREMENT_TARGET_INVALID',detail:'合并承载卡状态异常，未清除待办。'};
    return {...proof,redirect:proof.target,chain:[id,proof.target]};
  }
  for(const id of ids){
    const card=currentCard(id);
    if(card&&!retired(card)&&!proofs.has(id)){result.active_ids.push(id);continue;}
    const checked=verify(id);
    if(checked.code)result.blocked.push({id,...checked,lifecycle:card?.meta.lifecycle??null,redirect:card?.meta.superseded_by??null});
    else result.resolved.push(checked);
  }
  return result;
}

/** Update task-only projection in memory; caller persists the job when appropriate. */
export function reconcileConstructScope(root,job,index=job.batch_index){
  const result=inspectConstructScope(root,job,index);
  if(job.mode==='construct'&&job.construct_contract==='scoped-review-v1'){
    job.construct_resolution??={};job.construct_resolution[index]=result;
  }
  return result;
}
