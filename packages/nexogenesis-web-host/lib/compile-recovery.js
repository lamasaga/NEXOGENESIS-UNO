import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { sha } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { workflowCharLimit, workflowOutputLimit, workflowReasoning } from './workflow-limits.js';

export const COMPILE_RECOVERY_CONTRACT = 'compile-response-recovery-v1';
export const COMPILE_RECOVERY_MODEL_LIMIT = 1;
export const COMPILE_RECOVERY_JOB_LIMIT = 3;

const user = text => createUserMessage({ source:{kind:'user'}, content:[{type:'text',text}] });
const leafStrings = (value, result = []) => {
  if(typeof value === 'string' && value.trim()) result.push(value);
  else if(Array.isArray(value)) for(const item of value) leafStrings(item,result);
  else if(value && typeof value === 'object') for(const item of Object.values(value)) leafStrings(item,result);
  return result;
};

export function normalizeReviewEnvelope(value,{scope='cards'}={}) {
  if(!value || typeof value !== 'object' || Array.isArray(value)) return {value,changes:[]};
  if(scope !== 'gap' && Array.isArray(value.checked_ids) && Array.isArray(value.issues)
    && (value.unit_issues === undefined || value.unit_issues === null)) {
    return {value:{...value,unit_issues:[]},changes:['required-empty-unit-issues']};
  }
  return {value,changes:[]};
}

export function compileRecoveryFingerprint({phase,requestKey,responseText}) {
  return sha(JSON.stringify({contract:COMPILE_RECOVERY_CONTRACT,phase,requestKey,responseText:String(responseText??'')}));
}

export function buildCompileRecoveryRequest(job,{phase,responseText,errorMessage,expectedIds,allowedIds,scope}) {
  const context={phase:'recovery',failed_phase:phase,review_scope:scope,validation_error:errorMessage,
    expected_checked_ids:[...expectedIds],allowed_related_card_ids:[...allowedIds],original_response:String(responseText??'')};
  const system=`你只修复一次已经返回的编译检查响应，使它符合指定 JSON 契约。不得重新审查卡片，不得增加、删除或改写任何问题、卡片 ID、关系目标或结论。只能修复 JSON 语法、数组包裹、字段名和必需的空字段。无法在不改变语义的情况下修复时，返回 {"action":"cannot_repair","reason":"具体原因"}。
目标响应格式：{"checked_ids":[...],"issues":[{"id":"...","kind":"card|relation","related_card_ids":[],"message":"..."}],"unit_issues":[]}。
返回格式只能是 {"action":"repair_response","repaired_response":目标响应} 或 cannot_repair；不得输出代码围栏、解释或其他文字。`;
  const text='本次失败响应与局部契约：\n'+JSON.stringify(context),size=Array.from(system+text).length;
  const limit=workflowCharLimit(job,'context_chars',60000);if(size>limit)throw Object.assign(new Error(`失败响应超过 ${limit} 字符的局部恢复上下文上限，未调用模型。`),{code:'COMPILE_RECOVERY_CONTEXT_LIMIT'});
  const effort=workflowReasoning(job,'check','off');return {...job.model_selection,...(effort?{reasoningEffort:effort}:{}),system,messages:[user(text)],tools:[],maxTokens:workflowOutputLimit(job,'compile-response-recovery',8192),
    nexoPrompt:{phase:'unit-recovery'},unit_context:{source_chars:0,other_chars:size}};
}

export function buildGenerationRecoveryRequest(job,{responseText,errorMessage}) {
  const system='只恢复已返回的制卡响应格式，不生成新知识、不重读原文、不补写正文、来源、关系或覆盖结论。只允许修复 JSON 语法与无歧义的外层字段包裹。目标格式为 {cards:[原响应中完整卡片],note:原有说明或null}。不得删除任何候选；无法无损恢复时返回 {action:"cannot_repair",reason:"具体原因"}。成功时返回 {action:"repair_response",repaired_response:目标对象}。只输出 JSON。';
  const text=JSON.stringify({original_response:responseText,validation_error:errorMessage});
  const size=Array.from(system+text).length;
  const limit=workflowCharLimit(job,'context_chars',60000);if(size>limit)throw Object.assign(new Error(`失败响应超过 ${limit} 字符，原响应留在未组织池，未发送恢复请求。`),{code:'COMPILE_RECOVERY_CONTEXT_LIMIT'});
  const effort=workflowReasoning(job,'check','off');return {...job.model_selection,...(effort?{reasoningEffort:effort}:{}),system,messages:[user(text)],tools:[],maxTokens:workflowOutputLimit(job,'compile-generation-recovery',32768),
    nexoPrompt:{phase:'unit-recovery'},unit_context:{source_chars:0,other_chars:size}};
}

export function validateCompileRecovery(value,{responseText,parsedOriginal}) {
  if(value?.action==='cannot_repair')throw Object.assign(new Error(String(value.reason||'模型判断无法安全修复响应。')),{code:'COMPILE_RECOVERY_DECLINED'});
  const repaired=value?.action==='repair_response'?value.repaired_response:null;
  if(!repaired || typeof repaired!=='object' || Array.isArray(repaired))
    throw Object.assign(new Error('响应恢复模型没有返回规定的 repaired_response。'),{code:'COMPILE_RECOVERY_INVALID'});
  const repairedText=JSON.stringify(repaired),raw=String(responseText??'');
  for(const text of leafStrings(repaired))if(!raw.includes(text)&&!raw.includes(JSON.stringify(text).slice(1,-1)))
    throw Object.assign(new Error('响应恢复不得增加原返回中不存在的语义内容。'),{code:'COMPILE_RECOVERY_SCOPE_VIOLATION'});
  if(parsedOriginal && typeof parsedOriginal==='object')for(const text of leafStrings(parsedOriginal))if(!repairedText.includes(JSON.stringify(text).slice(1,-1))&&!repairedText.includes(text))
    throw Object.assign(new Error('响应恢复不得删除原返回中的语义内容。'),{code:'COMPILE_RECOVERY_SCOPE_VIOLATION'});
  return repaired;
}

export function classifyCompileFailure(error,signalAborted=false) {
  const code=String(error?.code??'');
  if(signalAborted)return {category:'execution_stop',automatic_recovery:false,retryable:true};
  if(['UNO_PROVIDER_BUDGET','UNO_STAGE_BUDGET','UNO_REVIEW_RESERVE','UNO_BUDGET'].includes(code))return {category:'budget',automatic_recovery:false,retryable:true};
  if(['UNIT_CONTEXT_LIMIT','COMPILE_RECOVERY_CONTEXT_LIMIT','UNO_CONTEXT_BUDGET','UNO_CONTEXT_ADAPTER'].includes(code))return {category:'context_limit',automatic_recovery:false,retryable:false};
  if(['REVISION_CONFLICT','STALE_EVIDENCE','CARD_RETIRED'].includes(code))return {category:'state_conflict',automatic_recovery:false,retryable:false};
  if(code.startsWith('COMPILE_RECOVERY_'))return {category:'response_contract',automatic_recovery:false,retryable:false};
  if(code==='INVALID_GENERATION_RESPONSE')return {category:'response_contract',automatic_recovery:false,retryable:false};
  if(code==='MODEL_EMPTY_RESPONSE')return {category:'response_contract',automatic_recovery:false,retryable:true};
  if(code==='MODEL_OUTPUT_TRUNCATED')return {category:'output_limit',automatic_recovery:true,retryable:true};
  if(code.startsWith('UNIT_'))return {category:'knowledge_review',automatic_recovery:false,retryable:false};
  return {category:'unexpected',automatic_recovery:false,retryable:true};
}
