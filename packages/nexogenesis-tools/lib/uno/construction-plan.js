import {readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {loadCards} from '../cards.js';
import {unoPath, unoRevision, unoCardRef, sha} from '../harness/uno-storage.js';
import {validateSource} from './drafts.js';
import {resolveCardTarget,listDomainsV2} from './knowledge.js';

export const CONSTRUCTION_PROFILE='direction-driven-v1';
export const directedConstruction=job=>job?.mode==='construct'&&job.construction_profile===CONSTRUCTION_PROFILE;
const RULES='construction-2026-09-16-v1';
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const words=text=>new Set([...segmenter.segment(String(text).toLowerCase())].filter(w=>w.isWordLike&&w.segment.length>1).map(w=>w.segment));
const overlap=(a,b)=>[...a].reduce((n,w)=>n+Number(b.has(w)),0);
const fingerprint=value=>sha(JSON.stringify(value));
const normalized=text=>String(text??'').replace(/\s+/gu,' ').trim();
const cacheRef=key=>`.nexogenesis/construct-checks/${key}.json`;
function cacheRead(root,key){try{return JSON.parse(readFileSync(unoPath(root,cacheRef(key)),'utf8'));}catch{return null;}}
function saveCache(root,key,value){const path=unoPath(root,cacheRef(key));mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(value));renameSync(path+'.tmp',path);}
function evidenceAvailable(root,ids){const cards=loadCards(root,{includeInactive:true}),dependencies=new Set(ids);
  for(const id of ids){if(resolveCardTarget(root,id,cards)!==id)return false;for(const relation of cards.get(id)?.meta.relations??[]){const target=resolveCardTarget(root,relation.target,cards);if(!target)return false;dependencies.add(target);}}
  for(const id of dependencies){const card=cards.get(id);if(!card)return false;for(const ref of card.meta.sources??[]){try{if(!validateSource(root,ref).revision)return false;}catch{return false;}}}return true;
}

/** Local retrieval proposes bounded comparison groups, never declares duplication or truth. */
export function planConstruction(root,{notes,card_ids,domain='',type='',force_recheck=false,requirements={}}={}){
  const goal=normalized(notes);if(!goal)throw Error('请说明本次建构方向，例如整理某一主题的重复解释、反例或观点分歧。');
  const cards=loadCards(root),allowed=[...cards].filter(([id,c])=>c.meta.type!=='domain'&&(!card_ids||card_ids.includes(id))&&(!domain||(c.meta.domains??[]).includes(domain))&&(!type||c.meta.type===type));
  if(card_ids&&card_ids.some(id=>!allowed.some(([key])=>key===id)))throw Error('选定卡片不存在、已退役或不属于所选范围。');
  const q=words(requirements.construction_controls?[requirements.construction_query,requirements.long_term?requirements.preferences?.purpose:''].filter(Boolean).join(' '):goal), audit=/事实核验|事实审计|真伪|真实性|(?:核查|核验|核对|检查).{0,6}(?:来源|事实|数字|数据)|(?:事实|来源|数据).{0,6}(?:核验|审计|核查|核对)|factual\s+audit/iu.test(goal);
  const kind=audit?'factual-audit':/重复|合并|去重/u.test(goal)?'duplicates':/反例|边界|失效/u.test(goal)?'counterexamples':/分歧|冲突|观点|立场/u.test(goal)?'viewpoints':'focused-review';
  const rows=allowed.map(([id,c])=>{const title=words(c.meta.title),keys=words([c.meta.title,c.meta.type,...(c.meta.domains??[]),c.meta.summary,c.body.slice(0,1600)].join(' '));return {id,c,keys,score:overlap(q,title)*4+overlap(q,keys),revision:unoRevision(root,unoCardRef(root,c))};});
  // Exact membership and versions invalidate past checks when new evidence is added to this scope.
  const inventory_revision=fingerprint(rows.map(r=>[r.id,r.revision]).sort(([a],[b])=>a.localeCompare(b)));
  const controls=requirements.construction_controls;
  const goal_key=fingerprint({goal,domain,type,kind,rules:RULES,controls,requirements:{long_term:requirements.long_term??'',model:requirements.model??''}});
  const ranked=rows.filter(r=>r.score>0||card_ids||domain||type).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  if(controls&&!ranked.length)ranked.push(...rows.sort((a,b)=>a.id.localeCompare(b.id)));
  if(controls?.primary==='domains')ranked.sort((a,b)=>Number(!b.c.meta.domains?.length)-Number(!a.c.meta.domains?.length)||b.score-a.score||a.id.localeCompare(b.id));
  // With a broad direction, nearby titles offer a bounded sample; no silent whole-library sweep.
  if(!ranked.length&&['duplicates','counterexamples','viewpoints'].includes(kind)){
    const counts=new Map();for(const row of rows)for(const term of words(row.c.meta.title))counts.set(term,(counts.get(term)??0)+1);
    for(const row of rows)row.score=[...words(row.c.meta.title)].reduce((n,term)=>n+Number(counts.get(term)>1),0);
    ranked.push(...rows.filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)));
  }
  const selected=ranked.slice(0,24),pending=new Map(selected.map(r=>[r.id,r])),packages=[];
  while(pending.size){const seed=pending.values().next().value;pending.delete(seed.id);const group=[seed];let chars=seed.c.body.length;
    const neighbors=[...pending.values()].map(row=>({row,score:overlap(seed.keys,row.keys)+(seed.c.meta.relations??[]).some(r=>r.target===row.id)*3})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.row.score-a.row.score||a.row.id.localeCompare(b.row.id));
    for(const {row} of neighbors){if(group.length>=6)break;if(chars+row.c.body.length>30000)continue;group.push(row);pending.delete(row.id);chars+=row.c.body.length;}
    packages.push({id:'group-'+(packages.length+1),goal,kind,card_ids:group.map(r=>r.id),reason:'按目标命中、共同内容或已有导航提出的比较候选；相似不等于重复。',status:'pending'});
  }
  const plan={version:CONSTRUCTION_PROFILE,rules:RULES,goal,kind,goal_key,controls,inventory_revision,force_recheck:Boolean(force_recheck),packages,skipped:[],scope_count:allowed.length,
    unselected:rows.filter(r=>!selected.some(s=>s.id===r.id)).map(r=>r.id),notice:'本次最多选取24张候选，分组只是检索线索；未入选部分尚未检查，不代表没有问题。'};
  for(const pack of packages){pack.fingerprint=packageFingerprint(root,plan,pack);const previous=cacheRead(root,pack.fingerprint);
    if(!force_recheck&&evidenceAvailable(root,pack.card_ids)&&previous?.fingerprint===pack.fingerprint&&previous.status==='checked'&&previous.rules===RULES){pack.status='reused';pack.previous_job=previous.job;pack.note=previous.note;plan.skipped.push({id:pack.id,card_ids:pack.card_ids,previous_job:previous.job,note:previous.note});}}
  return plan;
}

export function packageFingerprint(root,plan,pack){
  const cards=loadCards(root,{includeInactive:true}),dependencies=new Map();
  const add=id=>{const c=cards.get(id);if(!c){dependencies.set('card:'+id,null);return;}dependencies.set('card:'+id,unoRevision(root,unoCardRef(root,c)));for(const ref of c.meta.sources??[]){try{dependencies.set(ref,validateSource(root,ref).revision);}catch{dependencies.set(ref,null);}}};
  for(const id of pack.card_ids){add(id);for(const rel of cards.get(id)?.meta.relations??[]){add(rel.target);const canonical=resolveCardTarget(root,rel.target,cards);if(canonical&&canonical!==rel.target)add(canonical);}}
  return fingerprint({goal:plan.goal_key,inventory:plan.inventory_revision,rules:RULES,...(plan.controls?{domains:listDomainsV2(root).map(d=>[d.id,d.revision]).sort(([a],[b])=>a.localeCompare(b))}:{}),dependencies:[...dependencies].sort(([a],[b])=>a.localeCompare(b))});
}
export function currentConstructionPackage(job,index=job.batch_index??0){return job.construction_plan?.packages.filter(p=>p.status!=='reused')[index];}
export function constructionConclusion(root,job,id,index=job.batch_index??0){
  if(!directedConstruction(job))return null;
  const row=job.construction_results?.[index]?.[id],pack=currentConstructionPackage(job,index),card=loadCards(root).get(id);
  if(!row||!card||!pack||row.package_fingerprint!==packageFingerprint(root,job.construction_plan,{card_ids:[id]})||row.revision!==unoRevision(root,unoCardRef(root,card)))return null;
  if(row.status==='unchanged'&&!evidenceAvailable(root,[id]))return null;
  return row;
}
export function recordConstructionConclusions(root,job,conclusions=[]){
  if(!directedConstruction(job)){if(conclusions.length)throw Error('此任务不支持建构结论登记。');return;}
  if(!Array.isArray(conclusions)||conclusions.length>6)throw Error('本组最多6条建构结论。');
  const pack=currentConstructionPackage(job);if(!pack)throw Error('当前建构组不存在。');
  const result={...(job.construction_results?.[job.batch_index]??{})},cards=loadCards(root);
  for(const row of conclusions){if(!pack.card_ids.includes(row.id)||!['unchanged','deferred'].includes(row.status)||!row.note?.trim()||row.note.length>1200)throw Error('结论须属于本组，说明保留依据或具体延期原因。');
    const card=cards.get(row.id);if(!card)throw Error('卡片已经退役或丢失，请核对合并收据。');const revision=unoRevision(root,unoCardRef(root,card)),read=job.card_reads?.[row.id],total=Array.from(card.body).length;
    if(row.status==='unchanged'&&(!read||read.revision!==revision||!read.intervals.some(([start,end])=>start===0&&end>=total)))throw Error('未完整读回当前版本，不能登记无需修改。');
    if(row.status==='unchanged'&&!evidenceAvailable(root,[row.id]))throw Error('来源或关系端点缺失，请修订或明确延期，不能登记无需修改。');
    result[row.id]={id:row.id,status:row.status,note:row.note.trim(),revision,package_fingerprint:packageFingerprint(root,job.construction_plan,{card_ids:[row.id]}),kind:'author-inspection',source_verified:false};}
  (job.construction_results??={})[job.batch_index]=result;
}
/** Cache only final no-change inspections; modified groups run again against their resulting state. */
export function rememberConstructionCheck(root,job,pending){
  if(!directedConstruction(job)||pending||job.construction_plan.kind==='factual-audit')return;
  const pack=currentConstructionPackage(job);if(!pack)return;
  const rows=pack.card_ids.map(id=>constructionConclusion(root,job,id));
  if(rows.some(row=>row?.status!=='unchanged'))return;
  const key=packageFingerprint(root,job.construction_plan,pack);
  saveCache(root,key,{fingerprint:key,rules:RULES,status:'checked',job:job.id,note:rows.map(row=>row.note).join('\n'),at:new Date().toISOString(),source_verified:false});
}
