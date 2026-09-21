import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { loadCards, parseCardFile } from '../cards.js';
import { safeId, safeCardId } from '../uno-contract.js';
import { unoPath, unoRevision, unoMarkdown, unoCardRef, transaction, expect, sha, readUnoUnit, readUnoReceipt } from '../harness/uno-storage.js';
import { RELATIONS, SYMMETRIC, listDomainsV2 } from './knowledge.js';
import { validateCardClassification } from './card-classification.js';
import { applyTextEdits } from '../runtime/text-edits.js';
import { readCompileJob, jobRef } from './state.js';
import { inspectBookUnit } from './book-sources.js';
import { isBookMaterialPath } from './book-paths.js';
import { bookEvidencePath, bookEvidenceRevision } from './book-evidence.js';
import {assertConstructionEdit,assertConstructionDraft} from './construction-permissions.js';
import {applyDomainGovernance} from './domain-governance.js';

export function draftRef(task,id){if(!safeId(task)||!safeCardId(id))throw Error('草稿标识无效：卡片 ID 应使用目录返回的原始 ID，不能填路径');return `03-Archive/compile-drafts/${task}/card-${id}.md`;}
export function readDraft(root,task,id){const ref=draftRef(task,id);if(!existsSync(unoPath(root,ref)))return null;const parsed=parseCardFile(unoPath(root,ref));return {...parsed.meta,body:parsed.body,ref,revision:unoRevision(root,ref)};}
export function listDrafts(root,task){const dir=unoPath(root,`03-Archive/compile-drafts/${task}`);if(!existsSync(dir))return [];return readdirSync(dir).filter(n=>/^card-.+\.md$/.test(n)).map(n=>readDraft(root,task,n.slice(5,-3)));}
export function draftCards(root,task){const cards=new Map(loadCards(root,{includeInactive:true}));for(const d of listDrafts(root,task))if(d.card&&d.state!=='rejected')cards.set(d.card.id,{meta:d.card,body:d.body,file:unoPath(root,d.ref),revision:d.revision,draft:true});return cards;}
export function validateSource(root,ref){
  if(typeof ref!=='string'||! /^(05-Buffer|03-Archive)\//.test(ref))throw Error('来源必须指向本库 Buffer 或归档材料');
  const [file,...anchors]=ref.split('#');if(anchors.length>1)throw Error('来源锚点无效');
  const path=bookEvidencePath(root,file);if(!existsSync(path))throw Error('来源不存在：'+ref);
  const bookUnit=isBookMaterialPath(file)&&file.includes('/units/');
  if(bookUnit){
    const unit=inspectBookUnit(root,{book_units:[{ref:file}]},file);
    if(anchors.length){
      const range=/^char-(\d+)-(\d+)$/.exec(anchors[0]);
      if(!range||Number(range[1])>=Number(range[2])||Number(range[2])>Array.from(unit.body).length)throw Error('图书来源字符范围无效：'+ref);
    }
  }else if(anchors.length){const anchor=anchors[0];if(!/^[a-zA-Z0-9_-]+$/.test(anchor)||!readFileSync(path,'utf8').includes('^'+anchor))throw Error('来源锚点不存在：'+ref);}
  const revision=bookUnit?bookEvidenceRevision(root,file):file.startsWith('05-Buffer/')?sha(readUnoUnit(root,file).body):unoRevision(root,file);
  return {ref,file,revision};
}
function stringList(value){if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))return [];return [...new Set(value.map(x=>x.trim()).filter(Boolean))];}
function relationIssues(card,cards){
  const issues=[];
  for(const rel of card.relations??[]){if(!Object.hasOwn(RELATIONS,rel.type)||!cards.has(rel.target)||rel.target===card.id)issues.push('关系类型或端点无效：'+rel.target);if(!rel.note?.trim())issues.push('关系缺少具体说明：'+rel.target);if(!['source','navigation'].includes(rel.basis??(rel.origin==='navigation'?'navigation':'source')))issues.push('关系 basis 无效：'+rel.target);}
  return issues;
}
export function basicIssues(root,card,body,cards,{relations_only=false}={}){
  if(relations_only)return relationIssues(card,cards);
  const issues=[];
  if(!card.title?.trim()||/[\r\n\x00]/.test(card.title))issues.push('标题必须是非空单行');
  if(!card.summary?.trim())issues.push('需要检索摘要');
  for(const issue of validateCardClassification(card,listDomainsV2(root)).issues)issues.push(issue.message);
  if(!body.trim())issues.push('正文为空，不能用摘要替代正文');
  if(!card.boundary?.trim())issues.push('请通过 boundary 给出具体边界/证据范围，正文可自行组织');
  if(!(card.sources?.length))issues.push('缺少来源');
  for(const ref of card.sources??[])try{validateSource(root,ref);}catch(e){issues.push(e.message);}
  issues.push(...relationIssues(card,cards));
  return issues;
}

/** Staging, publishing and history are all transactions invoked through HarnessGateway. */
export function stageKnowledge(root,{task,key,...input}){
  if(!['write','patch','link','unlink','restore'].includes(input.action??'write'))throw Error('未知卡片操作');
  if(input.link&&!['link','unlink'].includes(input.action))throw Error('link 字段必须使用 action: link 或 unlink；本次未写入，请单独提交关系');
  if(['link','unlink','restore'].includes(input.action)&&['title','summary','body','boundary','type','domains','sources','relations','edits','merge'].some(k=>input[k]!==undefined))throw Error('关系或恢复操作不能同时修改内容字段，请分开提交');
  if(input.edits&&input.body!==undefined)throw Error('正文局部 edits 与完整 body 不能同时提交');
  if(input.edits&&input.action!=='patch')throw Error('edits 需要 action: patch');
  const relationOnly=['link','unlink'].includes(input.action)||(input.action==='patch'&&input.relations!==undefined&&!['title','summary','body','boundary','type','domains','sources','edits','merge'].some(k=>input[k]!==undefined));
  const ref=draftRef(task,input.id);
  return transaction(root,key,{task,...input},()=>{
    // Validate only new writes: an identical historical receipt remains replayable.
    if(input.action==='link'){
      if(Object.hasOwn(input,'basis'))throw Error('关系归属位置错误：basis 必须写在 link.basis，不能放在顶层；本次未写入');
      if(!input.link||!Object.hasOwn(input.link,'basis'))throw Error('新增关系必须明确提供 link.basis：source（来源已有关系）或 navigation（检索导航）；本次未写入');
      if(!['source','navigation'].includes(input.link.basis))throw Error('link.basis 只能是 source 或 navigation；本次未写入');
    }
    const current=readDraft(root,task,input.id),cards=draftCards(root,task),old=loadCards(root,{includeInactive:true}).get(input.id);
    const jobId=task.replace(/-b\d+$/,''),job=existsSync(unoPath(root,jobRef(jobId)))?readCompileJob(root,jobId):null;
    if(job?.construction_controls){
      if(job.status!=='running'||job.end_requested||job.pause_requested||job.role==='reviewer')throw Error('当前任务不能新增建构草稿。');
      if(!job.scope?.includes(input.id)||(input.merge??[]).some(m=>!job.scope.includes(m.id)))throw Error('建构草稿超出冻结范围。');
      assertConstructionEdit(job,input,current,old);
    }
    if(old&&['superseded','archived'].includes(old.meta.lifecycle)&&input.action!=='restore')
      throw Object.assign(new Error('卡片已退役，普通修订不能重新激活；请沿保留去向处理，恢复必须明确使用 restore：'+input.id),
        {code:'CARD_RETIRED',details:{id:input.id,lifecycle:old.meta.lifecycle,redirect:old.meta.superseded_by??null}});
    const oldRef=old?unoCardRef(root,old):`01-Cards/${input.id}.md`;
    expect(root,{[current?ref:oldRef]:input.revision??null});
    if(current?.state==='published')throw Error('该草稿已发布；请在新批次中修订');
    let card={...(current?.card??old?.meta??{}),id:input.id},body=current?.body??old?.body??'';
    const merges=current?.merges??[];
    if(input.action==='link'||input.action==='unlink'){
      if(!card.title)throw Error('先读取已有卡片');const link=input.link;
      if(!link||!Object.hasOwn(RELATIONS,link.type)||!cards.has(link.target)||link.target===input.id)throw Error('关系类型或端点无效');
      if(input.action==='link'&&!String(link.note??'').trim())throw Error('关系需要具体阅读用途');
      if(input.action==='link'&&SYMMETRIC.has(link.type)&&(cards.get(link.target).meta.relations??[]).some(r=>r.target===input.id&&r.type===link.type))throw Error('对称关系已反向存在，请修订原边');
      card.relations=(card.relations??[]).filter(r=>r.target!==link.target||r.type!==link.type);
      if(link.basis&&!['source','navigation'].includes(link.basis))throw Error('关系 basis 只能是 source 或 navigation');
      if(input.action==='link')card.relations.push({target:link.target,type:link.type,note:link.note,origin:link.basis==='navigation'?'navigation':'document',basis:link.basis});
    }else if(input.action==='restore'){
      if(!/^[a-f0-9]{64}$/.test(input.version??''))throw Error('恢复版本无效');
      const past=parseCardFile(unoPath(root,`03-Archive/card-history/${input.id}/${input.version}.md`));card=past.meta;body=past.body;card.boundary??=extractBoundary(body);
    }else{
      if(input.action==='patch'&&!current&&!old)throw Error('局部修改需要已有卡片或草稿');
      // Missing fields preserve the current object; explicit empty fields still fail quality checks.
      for(const field of ['title','summary','boundary','type'])if(input[field]!==undefined){if(typeof input[field]!=='string')throw Error(field+' 必须为文字');card[field]=input[field].trim();}
      for(const field of ['domains','sources'])if(input[field]!==undefined){if(!Array.isArray(input[field])||input[field].some(x=>typeof x!=='string'))throw Error(field+' 必须为字符串数组');card[field]=stringList(input[field]);}
      if(input.relations!==undefined){if(!Array.isArray(input.relations)||input.relations.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error('relations 必须为关系对象数组');card.relations=input.relations.map(row=>({...row}));}
      if(input.body!==undefined){if(typeof input.body!=='string')throw Error('body 必须为文字');body=input.body;}
      if(input.edits)body=applyTextEdits(body,input.edits);
      if(!relationOnly){
        card={...card,schema:'uno-card-v4',boundary:card.boundary??extractBoundary(body),domains:card.domains??[],sources:card.sources??[],relations:card.relations??[],lifecycle:'active',origin:card.origin??'document',generated_by:'uno-classification-v1'};
        delete card.tags;delete card.topics;delete card.superseded_by;
        // Ordinary rewrites cannot silently discard previously deposited evidence.
        // Explicit sources correct unpublished mistakes. Existing formal evidence
        // remains protected; omission still preserves the current draft's sources.
        card.sources=stringList([...(old?.meta.sources??[]),...card.sources]);
      }
    }
    for(const item of input.merge??[]){
      const source=loadCards(root).get(item.id);if(!source||item.id===input.id)throw Error('合并来源无效');
      const sourceRef=unoCardRef(root,source);expect(root,{[sourceRef]:item.revision});
      if(!merges.some(m=>m.id===item.id))merges.push({id:item.id,ref:sourceRef,revision:item.revision});
      card.sources=stringList([...card.sources,...(source.meta.sources??[])]);
      for(const rel of source.meta.relations??[])if(rel.target!==input.id&&!card.relations.some(r=>r.target===rel.target&&r.type===rel.type))card.relations.push(rel);
    }
    card.relations=(card.relations??[]).filter(r=>!merges.some(m=>m.id===r.target));
    const issues=basicIssues(root,card,body,cards,{relations_only:relationOnly}),bindings=[];
    for(const source of card.sources??[])try{bindings.push(validateSource(root,source));}catch{/* Reported by basicIssues. */}
    const draft={kind:'uno-knowledge-draft',task,card,validation_scope:relationOnly?'relations':'card',...(current?.restore_requested||input.action==='restore'?{restore_requested:true}:{}),base_ref:current?.base_ref??oldRef,base_revision:current?current.base_revision:unoRevision(root,oldRef),state:issues.length?'rejected':'pending',errors:issues,merges,source_bindings:bindings,...(job?.construction_controls?{domain_revisions:Object.fromEntries(listDomainsV2(root).filter(d=>(card.domains??[]).includes(d.id)).map(d=>[d.id,d.revision]))}:{}),rejections:(current?.rejections??0)+(issues.length?1:0),updated_at:new Date().toISOString()};
    return {writes:new Map([[ref,unoMarkdown(draft,body)]]),result:{summary:issues.length?'草稿待修：'+input.id:'保存待审核草稿：'+card.title,card_ids:issues.length?[]:[input.id],draft_id:input.id,staged:!issues.length,issues,ref,changed_fields:Object.keys(input).filter(k=>!['id','revision','action'].includes(k)),relation_count:card.relations.length,...(input.link?{relation:input.link,relation_action:input.action}:{})}};
  });
}
function extractBoundary(body){return String(body).match(/(?:^|\n)#{1,4}\s*(?:边界[^\n]*|适用[^\n]*|限制[^\n]*|准确理解)\n+([\s\S]*?)(?=\n#{1,4} |$)/)?.[1]?.trim()??'';}
function retainHistory(root,writes,id,ref){if(!existsSync(unoPath(root,ref)))return;const bytes=readFileSync(unoPath(root,ref));writes.set(`03-Archive/card-history/${id}/${sha(bytes)}.md`,bytes);}
export function publishKnowledge(root,{task,key,ids,reviews,compile_job_id}){
  return transaction(root,key,{task,ids,reviews,...(compile_job_id?{compile_job_id}:{})},()=>{
    // Read the persisted authority again at the write boundary. The caller
    // cannot opt out by omitting compile_job_id or claiming author approval.
    const inferred=task.replace(/-b\d+$/,''),jobId=compile_job_id??inferred;
    const job=existsSync(unoPath(root,jobRef(jobId)))?readCompileJob(root,jobId):null;
    if(compile_job_id&&(!job||task!==`${job.id}-b${job.batch_index??0}`))throw Error('发布任务与当前工作包不一致');
    if(job?.mode==='compile')throw Error('旧编译草稿只读；请使用新图书编译。');
    const writes=new Map(),cards=draftCards(root,task),published=[],publication={task,cards:[],retirements:[]},mergedIds=new Set(),constructionOutcomes=[];
    // Two proposals may not publish and retire the same ID in one transaction.
    for(const id of ids)for(const item of readDraft(root,task,id)?.merges??[]){
      if(ids.includes(item.id)||mergedIds.has(item.id))throw Object.assign(new Error('同一发布组不能同时修订和退役、或重复合并同一卡片：'+item.id),{code:'MERGE_PUBLICATION_CONFLICT'});
      mergedIds.add(item.id);
    }
    for(const id of ids){
      const d=readDraft(root,task,id);if(!d||d.state!=='pending'||reviews[id]?.revision!==d.revision||reviews[id]?.issues?.length)throw Error('当前草稿没有通过对应版本的审核：'+id);
      if(job?.construction_controls){
        if(job.end_requested||job.pause_requested||!['running','review'].includes(job.status))throw Error('当前任务已停止，不能发布。');
        const change=assertConstructionDraft(job,d,loadCards(root,{includeInactive:true}).get(id));
        if(change?.domainOnly)throw Error('领域归属须通过独立领域治理发布。');
        if(change?.contentChanged||change?.merged)constructionOutcomes.push({id,title:d.card.title,kind:'card',operation:change.merged?'merge':'edit'});
        if(change?.relationsChanged)constructionOutcomes.push({id,title:d.card.title,kind:'relation'});
      }
      expect(root,{[d.base_ref]:d.base_revision});
      for(const source of d.source_bindings)if(validateSource(root,source.ref).revision!==source.revision)throw Error('来源内容已变化，需要重新核对：'+source.ref);
      const issues=basicIssues(root,d.card,d.body,cards,{relations_only:d.validation_scope==='relations'});if(issues.length)throw Error(issues.join('；'));
      for(const rel of d.card.relations??[])if(!loadCards(root).has(rel.target)&&!ids.includes(rel.target))throw Error('关系端点尚未发布：'+rel.target);
      retainHistory(root,writes,id,d.base_ref);
      const date=new Date().toISOString().slice(0,10);
      const body=job?.construction_controls?d.body:d.body+(extractBoundary(d.body)?'':'\n\n## 边界与适用条件\n\n'+d.card.boundary);
      const publishedText=unoMarkdown({...d.card,created:d.card.created??date,updated:date,quality_notes:[],review_notes:[],reviewed_at:new Date().toISOString()},body);
      writes.set(d.base_ref,publishedText);publication.cards.push({id,ref:d.base_ref,revision:sha(publishedText),draft_revision:d.revision});
      for(const m of d.merges){
        expect(root,{[m.ref]:m.revision});const old=parseCardFile(unoPath(root,m.ref));retainHistory(root,writes,m.id,m.ref);
        const retiredText=unoMarkdown({...old.meta,lifecycle:'superseded',superseded_by:id,updated:date},old.body);
        writes.set(m.ref,retiredText);publication.retirements.push({id:m.id,ref:m.ref,previous_revision:m.revision,revision:sha(retiredText),target:id});
      }
      const {ref,revision,body:ignored,...meta}=d;
      writes.set(ref,unoMarkdown({...meta,state:'published',published_at:new Date().toISOString(),publication_key:key},d.body));published.push(id);
    }
    return {writes,result:{summary:`审核通过并发布 ${published.length} 张知识卡片`,card_ids:published,publication,...(job?.construction_controls?{construction_outcomes:constructionOutcomes}:{})}};
  });
}
export function publishConstructionDomains(root,{task,key,ids,reviews}) {
  const requestHash=sha(JSON.stringify({task,ids,reviews})),previous=readUnoReceipt(root,key);
  if(previous){if(previous.construction_domain_request_hash!==requestHash)throw Error('同一领域发布请求不能更改内容。');return {...previous,idempotent:true};}
  const job=readCompileJob(root,task.replace(/-b\d+$/,''));
  if(!job.construction_controls||job.end_requested||job.pause_requested||!['running','review'].includes(job.status))throw Error('当前任务不能提交领域治理。');
  const cards=loadCards(root),domains=listDomainsV2(root),drafts=ids.map(id=>readDraft(root,task,id));
  const expected_cards={},expected_domains={};
  for(const d of drafts){
    if(!d||d.state!=='pending'||reviews[d.card.id]?.revision!==d.revision||reviews[d.card.id]?.issues?.length)throw Error('领域草稿未通过当前版本审核。');
    if(!assertConstructionDraft(job,d,cards.get(d.card.id))?.domainOnly)throw Error('领域治理只能发布成员归属。');
    expect(root,{[d.base_ref]:d.base_revision});expected_cards[d.card.id]=d.base_revision;
    for(const id of d.card.domains){const domain=domains.find(row=>row.id===id);if(!domain)throw Error('领域已不存在。');expected_domains[id]=d.domain_revisions?.[id];if(!expected_domains[id]||expected_domains[id]!==domain.revision)throw Error('领域定义已变化，请重新核对草稿。');}
    for(const source of d.source_bindings)if(validateSource(root,source.ref).revision!==source.revision)throw Error('来源已变化。');
  }
  return applyDomainGovernance(root,{key,assignments:drafts.map(d=>({card_id:d.card.id,domains:d.card.domains})),expected_cards,expected_domains},({writes,changedCards})=>{
    const publication={task,cards:[],retirements:[]};
    for(const d of drafts){publication.cards.push({id:d.card.id,ref:d.base_ref,revision:sha(writes.get(d.base_ref)),draft_revision:d.revision});const {ref,revision,body,...meta}=d;writes.set(ref,unoMarkdown({...meta,state:'published',published_at:new Date().toISOString(),publication_key:key},body));}
    return {writes,result:{summary:`领域治理：调整 ${changedCards.length} 张卡片的归属`,card_ids:changedCards,publication,construction_domain_request_hash:requestHash,construction_outcomes:drafts.map(d=>({id:d.card.id,title:d.card.title,kind:'domain'}))}};
  });
}
