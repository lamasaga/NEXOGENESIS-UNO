const text = {type:'string'};
const record = (properties, required=[]) => ({type:'object',properties:Object.fromEntries(Object.entries(properties).map(([key,spec])=>[key,{...spec,...(required.includes(key)?{required:true}:{})}])),additionalProperties:false});
const list = items => ({type:'array',items});

/** Shared by native schemas and nested batch argument validation. */
export function tightenToolSchema(tool) {
  const parameters = {...tool.parameters};
  if (tool.name === 'compile_edit') {
    parameters.id = {...parameters.id,description:'使用目录中的原始卡片 ID（支持中文）；不是路径。新卡使用稳定 ID，改名不改 ID。'};
    if(parameters.type)parameters.type={...parameters.type,description:'单一主类型；按 conflict/entity/case/concept/method/mechanism/model/claim/phenomenon/undetermined 顺序检查，取第一个满足全部最低条件的类型。'};
    if(parameters.domains)parameters.domains={...parameters.domains,description:'0–3 个 compile_task domains 已存在的领域 ID；选最具体项，不重复父子领域，不自行发明。'};
    parameters.link = {...record({target:text,type:{type:'string',enum:['specialization','supplement','contrast','challenge','analogy','example','application']},note:text,basis:{type:'string',enum:['source','navigation']}},['target','type']),description:'link/unlink 的独立关系参数；新增须有具体 note；导航不等于原文论证。'};
    parameters.merge = list(record({id:text,revision:text},['id','revision']));
    if (parameters.edits) parameters.edits = list(record({old_text:text,new_text:text},['old_text','new_text']));
  }
  if (tool.name === 'compile_batch') parameters.operations = {...parameters.operations,required:true,items:record({tool:text,args:{type:'object',additionalProperties:true}},['tool','args'])};
  if (tool.name === 'compile_review') parameters.issues = list(record({id:text,detail:text},['id','detail']));
  return {...tool,parameters};
}
