export const CONSTRUCTION_CONTROLS = 'focus-and-permissions-v1';
export const CONSTRUCTION_FOCUSES = Object.freeze([
  {id:'connections',label:'发现联系',description:'连接分散知识，发现应用、对照和反例。',goal:'发现已有知识之间有依据的联系，说明比较维度、用途与成立条件。'},
  {id:'domains',label:'梳理领域',description:'核对共同问题，整理已有领域的成员归属。',goal:'核对卡片与既有领域的核心问题和边界，修正不合适的成员归属；缺少合适领域时登记待办。'},
  {id:'cards',label:'精炼卡片',description:'澄清知识对象，处理重复与表达不清。',goal:'改善卡片的完整性和独立可读性，只合并实质重复，保留作者、来源和独有条件。'},
  {id:'viewpoints',label:'比较分歧',description:'区分观点的前提、证据、边界与反例。',goal:'比较不同观点的对象、时期、前提和反例，保留有意义的分歧，不制造共识。'},
  {id:'comprehensive',label:'综合整理',description:'判断本次范围内最值得做的结构调整。',goal:'根据本次知识用途寻找最有价值的调整，允许保留原样，不以修改、连边或合并数量为目标。'}
]);
export const CONSTRUCTION_OPERATIONS = Object.freeze([
  {id:'relation_add',group:'关系',label:'新建关系'},
  {id:'relation_update',group:'关系',label:'修正关系'},
  {id:'relation_remove',group:'关系',label:'移除关系'},
  {id:'domain_assign',group:'领域',label:'调整已有领域归属'},
  {id:'card_edit',group:'卡片',label:'修订卡片'},
  {id:'card_merge',group:'卡片',label:'合并重复卡片'}
]);
const presets={connections:['relation_add','relation_update','relation_remove'],domains:['domain_assign'],cards:['card_edit','card_merge'],viewpoints:['relation_add','relation_update','card_edit'],comprehensive:CONSTRUCTION_OPERATIONS.map(o=>o.id)};
export function defaultConstructionControls(primary='comprehensive') {
  return {contract:CONSTRUCTION_CONTROLS,focuses:[primary],primary,allowed:[...(presets[primary]??presets.comprehensive)]};
}
export function validateConstructionControls(value) {
  if(!value||value.contract!==CONSTRUCTION_CONTROLS)throw Error('建构控制版本无效，请刷新后重试。');
  for(const field of ['focuses','allowed'])if(!Array.isArray(value[field])||new Set(value[field]).size!==value[field].length)throw Error('建构侧重与允许调整须为不重复的选项。');
  if(!value.focuses.length||value.focuses.some(id=>!CONSTRUCTION_FOCUSES.some(f=>f.id===id))||!value.focuses.includes(value.primary))throw Error('请选择有效的建构侧重和主要侧重。');
  if(value.allowed.some(id=>!CONSTRUCTION_OPERATIONS.some(o=>o.id===id)))throw Error('本服务尚不支持所选调整，不能按其他操作执行。');
  if(value.allowed.includes('card_merge')&&!value.allowed.includes('card_edit'))throw Error('合并卡片须同时允许修订承载卡片。');
  return {contract:CONSTRUCTION_CONTROLS,focuses:[...value.focuses],primary:value.primary,allowed:[...value.allowed]};
}
export function knowledgePreferenceText(saved) {
  return [saved.purpose?`知识库用途：${saved.purpose}`:'',saved.prompt,
    saved.organization&&(saved.organization.cards!=='independent'||saved.organization.domains!=='broad'||saved.organization.cross_domain!=='normal')?`组织偏好（仅在均有依据时取舍，不改变证据标准）：卡片${saved.organization.cards==='integrated'?'倾向完整综合':'倾向独立表达'}；领域${saved.organization.domains==='focused'?'倾向细分问题':'倾向较宽的问题空间'}；跨域联系${saved.organization.cross_domain==='priority'?'重点探索':'常规发现'}。`:''].filter(Boolean).join('\n');
}
export function constructionGoal(controls,notes='') {
  const value=validateConstructionControls(controls),ordered=[value.primary,...value.focuses.filter(id=>id!==value.primary)];
  return [String(notes).trim(),...ordered.map(id=>CONSTRUCTION_FOCUSES.find(f=>f.id===id).goal)].filter(Boolean).join('\n');
}
export function constructionSummary(controls) {
  const primary=CONSTRUCTION_FOCUSES.find(f=>f.id===controls.primary)?.label??'综合整理';
  const secondary=controls.focuses.filter(id=>id!==controls.primary).map(id=>CONSTRUCTION_FOCUSES.find(f=>f.id===id)?.label).join('、');
  const operations=CONSTRUCTION_OPERATIONS.filter(o=>controls.allowed.includes(o.id)).map(o=>o.label).join('、');
  return `重点${primary}${secondary?`，同时关注${secondary}`:''}。${operations?`允许${operations}。`:'只诊断并记录建议，保留现有知识。'}`;
}
