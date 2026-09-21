import {isDeepStrictEqual} from 'node:util';
import {validateConstructionControls, constructionSummary} from '../construction-controls.js';

const failure=message=>Object.assign(new Error(message),{code:'CONSTRUCTION_PERMISSION_DENIED'});
const equalSet=(a=[],b=[])=>isDeepStrictEqual([...a].sort(),[...b].sort());
const contentFields=['title','summary','boundary','type','sources'];
export function constructionPermissionText(job) {
  if(!job.construction_controls)return '';
  return `\n本次冻结控制：${constructionSummary(job.construction_controls)}侧重不是授权；只执行 allowed 中的操作。作者和审核人均须先用 compile_task(view=domains,id) 完整读取目标领域的核心问题与纳入排除边界。领域归属必须单独保存 patch domains 草稿，同一张卡在本批不能同时修改正文或关系。没有合适既有领域时登记 deferred，不创建领域或新卡。修改关系类型或端点须同时获得移除旧关系和新建关系的授权。未授权的改善仅登记待办。`;
}
export function assertConstructionEdit(job,args,current,original) {
  if(!job?.construction_controls)return;
  const {allowed}=validateConstructionControls(job.construction_controls);
  if(!allowed.length)throw failure('本次只诊断，不保存修改草稿。');
  const requirePermission=id=>{if(!allowed.includes(id))throw failure('本次未允许该调整：'+id);};
  if(!original)throw failure('本次只能调整冻结范围内的已有卡片。');
  const action=args.action??'write',meta=current?.card??original.meta,body=current?.body??original.body;
  if(action==='restore')throw failure('历史恢复不属于本次建构权限。');
  if(action==='link'||action==='unlink'){
    const exists=(meta.relations??[]).some(r=>r.target===args.link?.target&&r.type===args.link?.type);
    requirePermission(action==='unlink'?'relation_remove':exists?'relation_update':'relation_add');
  }else{
    if(args.body!==undefined&&args.body!==body||args.edits?.length||contentFields.some(key=>args[key]!==undefined&&!isDeepStrictEqual(args[key],meta[key])))requirePermission('card_edit');
    if(args.domains!==undefined&&!equalSet(args.domains,meta.domains))requirePermission('domain_assign');
    if(args.relations!==undefined){
      if(!Array.isArray(args.relations))throw failure('relations 必须是修改后的完整关系数组。');
      const before=meta.relations??[],after=args.relations,match=(list,r)=>list.find(x=>x.target===r.target&&x.type===r.type);
      for(const relation of before){const next=match(after,relation);if(!next)requirePermission('relation_remove');else if(!isDeepStrictEqual(relation,next))requirePermission('relation_update');}
      for(const relation of after)if(!match(before,relation))requirePermission('relation_add');
    }
    if(args.merge?.length){requirePermission('card_merge');requirePermission('card_edit');}
  }
  const domains=args.domains??meta.domains;
  if(!equalSet(domains,original.meta.domains)){
    if(!domains?.length)throw failure('没有合适既有领域时保留原归属并登记待办。');
    const contentChanged=current&&(current.body!==original.body||contentFields.some(key=>!isDeepStrictEqual(current.card[key],original.meta[key]))||!isDeepStrictEqual(current.card.relations??[],original.meta.relations??[])||current.merges?.length);
    const extra=action==='link'||action==='unlink'||args.merge?.length||args.edits?.length||(args.body!==undefined&&args.body!==original.body)||args.relations!==undefined&&!isDeepStrictEqual(args.relations,original.meta.relations??[])||contentFields.some(key=>args[key]!==undefined&&!isDeepStrictEqual(args[key],original.meta[key]));
    if(contentChanged||extra)throw failure('领域归属需独立治理；请把卡片正文、合并和关系调整留到下一次建构。');
  }
}
export function assertConstructionDraft(job,draft,original) {
  if(!job?.construction_controls)return;
  const {allowed}=validateConstructionControls(job.construction_controls);
  if(!original||!job.scope?.includes(draft.card.id)||draft.merges?.some(m=>!job.scope.includes(m.id)))throw failure('草稿超出冻结范围。');
  if(draft.restore_requested)throw failure('本次未授权恢复历史版本。');
  const domainChanged=!equalSet(draft.card.domains,original.meta.domains);
  if(domainChanged&&!allowed.includes('domain_assign'))throw failure('本次未允许调整领域归属。');
  const changedContent=draft.body!==original.body||contentFields.some(key=>!isDeepStrictEqual(draft.card[key],original.meta[key]));
  if(changedContent&&!allowed.includes('card_edit'))throw failure('本次未允许修订卡片。');
  if(draft.merges?.length&&(!allowed.includes('card_merge')||!allowed.includes('card_edit')))throw failure('本次未允许合并并修订承载卡。');
  const before=original.meta.relations??[],after=draft.card.relations??[];
  const match=(list,r)=>list.find(x=>x.target===r.target&&x.type===r.type);
  for(const r of before){const next=match(after,r);if(!next&&!allowed.includes('relation_remove')&&!draft.merges?.length)throw failure('本次未允许移除关系。');if(next&&!isDeepStrictEqual(r,next)&&!allowed.includes('relation_update'))throw failure('本次未允许修正关系。');}
  for(const r of after)if(!match(before,r)&&!allowed.includes('relation_add')&&!draft.merges?.length)throw failure('本次未允许新建关系。');
  if(domainChanged&&(changedContent||draft.merges?.length||!isDeepStrictEqual(before,after)))throw failure('领域归属必须由独立治理事务提交。');
  return {domainOnly:domainChanged,contentChanged:changedContent,relationsChanged:!isDeepStrictEqual(before,after),merged:Boolean(draft.merges?.length)};
}
