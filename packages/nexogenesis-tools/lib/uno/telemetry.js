import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { unoPath, sha } from '../harness/uno-storage.js';
import { toolResult, toolFailure } from '../runtime/tool-result.js';

export function recordAgentMetric(root, id, data) {
  // Measurements must not turn a successful knowledge commit into a failed tool call.
  try {const path=unoPath(root,`.nexogenesis/agent-metrics/${id}.jsonl`);mkdirSync(dirname(path),{recursive:true});appendFileSync(path,JSON.stringify({at:new Date().toISOString(),...data})+'\n');}
  catch { /* Optional telemetry only; transaction receipts remain authoritative. */ }
}
export async function observedTool(root, job, name, args, execute) {
  const started=performance.now();let result;
  try {result=toolResult(await execute());}catch(error){result=toolFailure(error);}
  if(job)recordAgentMetric(root,job.id,{kind:'tool',name,phase:job.phase,role:job.role??'author',
    session_id:job.session_id,batch:job.batch_index,operation_id:args.operation_id??null,receipt_key:result.key??null,
    input_hash:sha(JSON.stringify(args)),input_chars:JSON.stringify(args).length,output_chars:JSON.stringify(result).length,
    ok:result.ok!==false,elapsed_ms:Math.round(performance.now()-started),error_code:result.error?.code??null});
  return result;
}
