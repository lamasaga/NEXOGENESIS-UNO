// Read-only, provider-neutral report. No request bodies, credentials or model calls.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readCompileJob } from '../../packages/nexogenesis-tools/lib/uno/state.js';
import { unoPath } from '../../packages/nexogenesis-tools/lib/harness/uno-storage.js';

export function agentMetrics(root,id){
  const job=readCompileJob(root,id),path=unoPath(root,`.nexogenesis/agent-metrics/${id}.jsonl`);
  const rows=existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const tools=rows.filter(r=>r.kind==='tool'),contexts=rows.filter(r=>r.kind==='context'),by_tool={};
  for(const row of tools){const value=by_tool[row.name]??={calls:0,errors:0,input_chars:0,output_chars:0,elapsed_ms:0};value.calls++;value.errors+=row.ok?0:1;for(const key of ['input_chars','output_chars','elapsed_ms'])value[key]+=row[key]??0;}
  let miss=0,hit=0,output=0,reported=0;
  for(const call of job.calls??[]){if(!call.usage)continue;reported++;miss+=call.usage.inputTokens??0;hit+=call.usage.cacheReadTokens??0;output+=call.usage.outputTokens??0;}
  return {job:id,status:job.status,model_requests:job.calls.length,requests_with_usage:reported,
    input_cache_miss:miss,input_cache_hit:hit,cache_hit_rate:miss+hit?hit/(miss+hit):null,output_tokens:output,
    observed_tools:tools.length,tool_errors:tools.filter(r=>!r.ok).length,by_tool,
    context_observations:contexts.length,stable_instruction_versions:new Set(contexts.map(r=>r.stable_instructions_hash)).size,
    note:'工具字符数不是 tokens。未报告 usage 的请求不计为零成本；压缩及供应商内部重试需另核账单。系统段稳定不保证供应商缓存命中。批量工具的错误明细见原生回执。'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [root,id]=process.argv.slice(2);if(!root||!id)throw Error('用法：node tools/eval/uno-agent-metrics.mjs <知识库根目录> <任务ID>');
  console.log(JSON.stringify(agentMetrics(root,id),null,2));
}
