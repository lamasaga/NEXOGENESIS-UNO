import { registerUnoRequestContext } from './native-request-context.js';
import { BOOK_WORKFLOW, bookProgress } from './book-agent.js';
import { isBookWorkflow } from './book-sources.js';
import { taskInstructions, taskProgress } from './context.js';
import { boundedWorkflow, stageInstructions, stageToolSchemas, assertStageTool, boundSearchResult } from './prompt-orchestration.js';
import { getProviderBudget } from './request-budget.js';
import { observedTool, recordAgentMetric } from './telemetry.js';
import { toolResult, toolFailure } from '../runtime/tool-result.js';
import { sessionRootResolver, executionError, guardRepeatedFailure } from './execution-contract.js';
import { tightenToolSchema } from './tool-schemas.js';
import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { sha } from '../harness/uno-storage.js';
import { sessionCompileJob, readCompileJob } from './state.js';
import { CONSTRUCTION_WORKFLOW, runConstructionTool, constructionCoreFor } from './construction-workflow.js';
import { CARD_TYPES } from './card-classification.js';

export const name='uno-compile-tools';
export const inject=['tools','systemPrompt'];
export const Config=z.object({projectRoot:z.string().required(),instanceRegistry:z.string().default('')});
const str=description=>({type:'string',description});
const arr=description=>({type:'array',items:{type:'string'},description});
const number=description=>({type:'number',description});
const object=description=>({type:'object',additionalProperties:true,description});
const params={
  compile_task:{view:{type:'string',enum:['status','scope','domains','history','receipts','pending']},offset:number('目录分页起点，默认 0；scope 分页查看授权卡片'),id:str('history 时卡片 ID；receipts 时可按 operation_id 筛选')},
  compile_guide:{name:{type:'string',enum:['overview','types','relations','domains','examples'],required:true}},
  compile_read_material:{ref:{...str('卡片已引用的 Buffer 或归档 Markdown 路径，只读回查来源'),required:true},offset:number('Unicode 字符偏移'),limit:number('默认 12000，最多 24000 字符')},
  compile_search:{query:str('关键词、术语或数字；空字符串可浏览'),kind:{type:'string',enum:['all','card','buffer']},type:{type:'string',enum:CARD_TYPES,description:'单一主类型'},domain:str('领域 ID'),relation:str('关系代码'),neighbor:str('卡片 ID，查询双向邻居'),offset:number('分页起点'),limit:number('默认 8，最多 30')},
  compile_read_card:{id:{...str('卡片 ID'),required:true},view:{type:'string',enum:['current','baseline'],description:'current 当前草稿或卡；baseline 修改前正式卡，供差异审核'},offset:number('正文字符偏移'),limit:number('最多 30000 字符')},
  compile_edit:{operation_id:{...str('本任务内稳定且唯一的操作名；重试同一操作沿用，不重放成功写入'),required:true},action:{type:'string',enum:['write','link','unlink','restore']},id:{...str('稳定英文/数字 ID；改名不改 ID'),required:true},revision:str('已有卡片的当前 revision；新卡省略'),title:str('准确简练标题'),summary:str('检索摘要'),body:str('完整修订正文 Markdown，保留来源中的细节和条件'),type:{type:'string',enum:CARD_TYPES,description:'按 conflict/entity/case/concept/method/mechanism/model/claim/phenomenon/undetermined 顺序选择第一个满足全部最低条件的单一主类型'},domains:arr('0–3 个既有领域 ID；没有合适领域时用空数组，不得自行发明'),sources:arr('来源引用，沿用真实 Buffer 或归档定位'),link:object('link/unlink: {target,type,note}；类型 specialization/supplement/contrast/challenge/analogy/example/application'),merge:{type:'array',items:{type:'object',additionalProperties:true},description:'合并退役卡 [{id,revision}]，当前正文应已整合内容；旧卡保留'},version:str('restore 时历史版本 SHA256')},
  compile_review:{ids:arr('检查的卡片，最多 6 张；省略查看本批校对清单'),note:str('第二轮必须说明对命名、主类型、领域、正文、关系和来源的实际检查结论'),checks:{type:'array',items:{type:'object',properties:{id:{type:'string',required:true},claim:{type:'string',description:'最多600字符的具体主张',required:true},ref:{type:'string',required:true},quote:{type:'string',description:'最多600字符的来源原句',required:true}},additionalProperties:false},description:'bounded-workflow-v1：每张通过草稿至少一项具体主张与真实来源原句；claim/quote各最多600字符。定位通过不等于语义通过。'},issues:{type:'array',items:{type:'object',additionalProperties:true},description:'语义疑点 [{id,detail}]；对应 id 未列入则表示经核对已解决，不得未经核对清空'}},
  compile_checkpoint:{note:{...str('简短工作摘要：已作决定、当前重点和未完成项，最多 2000 字符'),required:true}},
  compile_finish:{phase:{type:'string',enum:['organize','complete'],required:true},summary:{...str('阶段结论及保留问题'),required:true},conclusions:{type:'array',items:{type:'object',properties:{id:{type:'string',required:true},status:{type:'string',enum:['unchanged','deferred'],required:true},note:{type:'string',required:true}},additionalProperties:false},description:'direction-driven-v1作者结算本组未改对象：完整阅读后unchanged并写具体依据；未完成用deferred说明缺口。最多6项。不代表独立事实核验。'}}
};
const descriptions={
  compile_batch:'将已明确的1–8项工具操作合并执行，逐项回执，单项失败不撤销其他成功项；不生成隐藏计划或增加模型调用。',
  compile_task:'查看建构方向、累计预算、授权卡片、领域索引或历史版本。范围目录分页，每页 30 项。',
  compile_guide:'读取 Markdown 约定和正反示范：overview 总则，types 九种实质主类型、未定与领域归属，relations 七种检索关系，domains 领域说明与领域关系契约。',
  compile_read_material:'只读回查卡片来源，可分页续读。返回原始定位与截断标记，不写原文或材料处理状态。',
  compile_search:'默认检索现有卡片；显式选择 buffer/all 才检索历史来源。支持主类型、领域、关系与双向邻居，先看摘要再展开。',
  compile_read_card:'阅读完整卡片元数据、当前版本和分页正文；退役卡会提供合并去向。修改前使用当前 revision。',
  compile_edit:'保存授权卡片的修订、合并或关系草稿。历史版本自动保留，经独立审核后发布。',
  compile_review:'读取或更新写后校对清单。审核人逐组核对当前卡片版本并报告语义疑点。程序检查不代替模型忠实度判断。',
  compile_checkpoint:'保存恢复所需的简短工作记录，下一次请求始终可见；不要复制原文或保存长篇推理过程。',
  compile_finish:'organize: 本批卡片处理后交给独立审核；complete: 当前提案审核结束。未解决问题保留为部分完成。'
};
/** The compile_* wire names remain stable for existing construction sessions. */
export function compileToolDefinitions(){
  const definitions={...params,
    compile_batch:{operations:{type:'array',items:{type:'object',additionalProperties:true},description:'1–8 项 [{tool,args}]。支持检索、读卡、只读来源和改卡草稿；顺序执行，逐项回执，成功项不重放。'}},
    compile_edit:{...params.compile_edit,action:{type:'string',enum:['write','patch','link','unlink','restore']},
      edits:{type:'array',items:{type:'object',additionalProperties:true},description:'局部修改 [{old_text,new_text}]，原句必须唯一匹配'},boundary:str('适用条件或证据范围')}
  };
  return Object.entries(definitions).map(([name,parameters])=>{
    const tool=tightenToolSchema({name,parameters,description:descriptions[name]});
    if(['compile_read_material','compile_read_card'].includes(name)){
      tool.parameters.offset=number('Unicode 字符偏移，默认 0');
      tool.parameters.limit=number('默认 12000，最多 24000 个 Unicode 字符');
    }
    if(name==='compile_edit'){
      tool.description='保存建构修订草稿；省略字段保留现值，局部正文用 patch edits。关系独立 link/unlink，link={target,type,note,basis:source|navigation}。独立审核后发布。';
      tool.parameters.link.description='link/unlink 的独立关系参数 {target,type,note,basis}；action=link 必须提供 link.basis 和具体 note，basis 不在顶层。unlink 可省略 basis。';
    }
    return tool;
  });
}
const argumentSpecs = new Map(compileToolDefinitions().map(t=>[t.name,t.parameters]));
function validateToolArguments(name,args){
  const spec=argumentSpecs.get(name);if(!spec)throw executionError('INVALID_ARGUMENTS','未知建构工具');
  const violations=validateArgs(spec,args);if(violations.length)throw executionError('INVALID_ARGUMENTS','工具参数不符合契约：'+violations.join('; '));
}

export function runCompileTool(root,sessionId,name,args,signal) {
  signal?.throwIfAborted();
  const job=sessionCompileJob(root,sessionId);
  if(!job||job.status!=='running'||job.end_requested||job.pause_requested)throw executionError('TASK_STOPPED','当前会话没有正在运行的授权建构任务');
  if(job.session_id!==sessionId)throw executionError('STALE_CONTEXT','这个工作上下文已交接，不能继续使用旧阶段');
  if(job.mode!=='construct'||job.workflow!==CONSTRUCTION_WORKFLOW)throw executionError('TASK_RETIRED','旧编译已退役；新图书编译由宿主按 unit-cards-v3 直接制卡，已保存的 v2 任务仅按原契约恢复。本工具只供建构。');
  assertStageTool(job,name,args);
  validateToolArguments(name,args);
  if(name==='compile_batch')return runToolBatch(root,sessionId,args,signal);
  const result=runConstructionTool(root,job,name,name==='compile_search'?{...args,kind:args.kind??'card'}:args);
  return boundedWorkflow(job)&&name==='compile_search'?boundSearchResult(result):result;
}

const BATCH_TOOLS=new Set(['compile_search','compile_read_card','compile_read_material','compile_edit']);
async function runToolBatch(root,sessionId,args,signal){
  const operations=args.operations;
  if(!Array.isArray(operations)||!operations.length||operations.length>8)throw Error('批量执行需要1–8项操作');
  // Prevalidate every operation before starting any write.
  for(const op of operations){if(!BATCH_TOOLS.has(op.tool)||!op.args||typeof op.args!=='object'||Array.isArray(op.args))throw executionError('INVALID_ARGUMENTS','不支持的批量操作');if(['compile_edit','compile_read_card','compile_read_material'].includes(op.tool))validateToolArguments(op.tool,op.args);}
  const results=[];
  for(const [index,op]of operations.entries()){
    signal?.throwIfAborted();
    if(results.length && Buffer.byteLength(JSON.stringify(results))>=14000)break;
    const input={...op.args};
    if(['compile_read_card','compile_read_material'].includes(op.tool))input.limit=Math.max(1,Math.min(3000,input.limit??3000));
    if(op.tool==='compile_search')input.limit=Math.max(1,Math.min(5,input.limit??5));
    try{const value=toolResult(await runCompileTool(root,sessionId,op.tool,input,signal));results.push({index,tool:op.tool,...value});if(value.stop||value.end_turn===true||value.error?.code==='TASK_STOPPED')break;}
    catch(e){results.push({index,tool:op.tool,...toolFailure(e)});if(results.at(-1).error.code==='TASK_STOPPED')break;}
  }
  return {results,attempted:results.length,requested:operations.length,next_index:results.length<operations.length?results.length:null,atomic:false,message:'逐项独立执行；成功项不重放。next_index 后尚未执行的项可另行提交。分页回执标明剩余正文，批量检查不代表阅读全文。'};
}

function concludePersistedHandoff(root,initial,name,args,result,exec){
  if(!initial||initial.workflow!==CONSTRUCTION_WORKFLOW||result?.ok===false||result?.error)return;
  if(name==='compile_batch'&&boundedWorkflow(initial)){
    for(const executed of result.results??[]){
      const operation=args.operations?.[executed.index];
      if(operation?.tool===executed.tool&&executed.index<result.attempted&&executed.end_turn===true)
        concludePersistedHandoff(root,initial,operation.tool,operation.args,executed,exec);
    }
    return;
  }
  if(result?.end_turn!==true||!['compile_finish','compile_review'].includes(name))return;
  exec.signal?.throwIfAborted();
  const current=readCompileJob(root,initial.id),sessionId=exec.agent?.session?.id??exec.session?.id;
  if(current.status!=='running'||current.session_id!==sessionId||current.end_requested||current.pause_requested)return;
  const persisted=result.ready===true&&(name==='compile_review'?current.role==='reviewer'&&current.finish_requested===true
    :args.phase==='organize'?current.handoff_requested===true:args.phase==='complete'&&current.finish_requested===true);
  // A model-visible JSON flag cannot finish the native loop by itself. Use the
  // native success marker only after the owning job has persisted its handoff.
  if(persisted)exec.concludeTurn();
}

export function apply(ctx,config) {
  const resolveRoot=sessionRootResolver(config);
  const governedRoots=new Map();
  ctx.effect(()=>registerUnoRequestContext(ctx,{
    isGoverned:agent=>{const root=resolveRoot({agent}),job=sessionCompileJob(root,agent.session.id);if(job)governedRoots.set(agent.session.id,root);return !!job;},
    onMeasurement:event=>{const root=governedRoots.get(event.sessionId),job=root&&sessionCompileJob(root,event.sessionId);
      if(job)recordAgentMetric(root,job.id,{kind:'request_context',phase:job.phase,role:job.role??'author',...event});}
  }));
  const taskContext=context=>{
    const root=resolveRoot(context);
    const job=sessionCompileJob(root,context?.agent?.session?.id);if(!job)return '';
    if(job.status!=='running')throw executionError('TASK_STOPPED','任务已暂停或结束，停止发起新请求。');
    if(isBookWorkflow(job.workflow))throw executionError('HOST_ONLY','单元编译由宿主直接提交完整正文，不运行原生工具循环。');
    if(!boundedWorkflow(job)&&job.calls.length>job.budget.calls&&!job.finish_requested)throw new Error('UNO_BUDGET：已达到本轮请求预算，请增加预算后恢复');
    return taskInstructions(job);
  };
  ctx.effect(()=>ctx.systemPrompt.section({name:'deployment:persona',order:0,complete:true,text:context=>{
    const job=sessionCompileJob(resolveRoot(context),context?.agent?.session?.id);
    if(!job)return '';
    if(isBookWorkflow(job.workflow))return taskContext(context);
    if(job.mode!=='construct'||job.workflow!==CONSTRUCTION_WORKFLOW)throw executionError('TASK_RETIRED','旧编译已退役，历史任务仅供查看。');
    return (stageInstructions(job)??constructionCoreFor(job))+'\n本任务固定目标与偏好：\n'+taskContext(context);
  }}));
  ctx.effect(()=>ctx.systemPrompt.context({name:'uno-task-progress',order:100,text:context=>{
    const root=resolveRoot(context);
    const job=sessionCompileJob(root,context?.agent?.session?.id);if(!job)return '';
    const text=JSON.stringify(isBookWorkflow(job.workflow)?{...bookProgress(job),budget:getProviderBudget(root,job.id)}:taskProgress(job,{providerBudget:boundedWorkflow(job)?getProviderBudget(root,job.id):undefined}));
    recordAgentMetric(root,job.id,{kind:'context',phase:job.phase,role:job.role??'author',stable_instructions_hash:sha((stageInstructions(job)??constructionCoreFor(job))+taskInstructions(job)),progress_chars:text.length});
    return 'UNO 当前执行状态（替代旧进度，不改变知识规范）：\n'+text;
  }}));
  ctx.on?.('system-prompt/assemble',async(_assembly,context,next)=>{
    const assembly=await next(),job=sessionCompileJob(resolveRoot(context),context?.agent?.session?.id);
    if(job&&isBookWorkflow(job.workflow))return {...assembly,tools:[]};
    const constructionNames=new Set(compileToolDefinitions().map(t=>t.name));
    const construction={...assembly,tools:assembly.tools.filter(t=>constructionNames.has(t.name))};
    if(job?.mode!=='construct'||job.workflow!==CONSTRUCTION_WORKFLOW)return {...assembly,tools:[]};
    return boundedWorkflow(job)?{...construction,tools:stageToolSchemas(job,construction.tools)}:construction;
  });
  for(const tool of compileToolDefinitions())ctx.tools.register(defineTool({...tool,
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:async(args,exec)=>{exec.signal?.throwIfAborted();const root=resolveRoot(exec);const sessionId=exec.agent?.session?.id??exec.session?.id,job=sessionCompileJob(root,sessionId);const result=await observedTool(root,job,tool.name,args,()=>runCompileTool(root,sessionId,tool.name,args,exec.signal));const guarded=job?guardRepeatedFailure(root,job.id,tool.name,args,result,sessionId):result;concludePersistedHandoff(root,job,tool.name,args,guarded,exec);return guarded;}
  }));
}
