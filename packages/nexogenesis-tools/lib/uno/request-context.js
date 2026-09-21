import { createHash } from 'node:crypto';

export const UNO_CONTEXT_VERSION = 'uno-request-context-v1';
export const UNO_INPUT_LIMIT_BYTES = 128000;
const measurements = new WeakMap();
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined')).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const signature = value => hash(canonical(value));
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const content = message => Array.isArray(message?.content) ? message.content : [];
const SYSTEM_PLUGIN = '@deepseek-ai/dsh-system-prompt';
const PREFIX = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
const READ_TOOLS = new Set(['compile_read_material', 'compile_read_card', 'compile_guide']);

// Only the renderer-verified, plugin-owned UNO section is replaceable. Text that
// merely looks like a progress update (including user or tool text) is evidence.
function progress(message) {
  const source = message.source, sections = source?.sections;
  if (message.role !== 'user' || source?.kind !== 'plugin' || source.plugin !== SYSTEM_PLUGIN
      || source.form !== 'snapshot' || !Array.isArray(sections) || sections.some(s => typeof s?.text !== 'string')
      || content(message).length !== 1 || content(message)[0].type !== 'text'
      || content(message)[0].text !== PREFIX + '\n\n' + sections.map(s => s.text).join('\n\n')) return null;
  const owned = sections.filter(s => s.name === 'uno-task-progress');
  if (owned.length !== 1) return null;
  const state = parse(owned[0].text.slice(owned[0].text.indexOf('\n') + 1));
  return typeof state?.id === 'string' ? {id:state.id, sections} : null;
}

function resultValue(block) {
  return block?.type === 'tool-result' && block.content?.length === 1 && block.content[0].type === 'text'
    ? parse(block.content[0].text) : null;
}
// These failures happen before any batch execution. Unknown errors, partial
// batches and rejected-but-saved drafts are never treated as non-execution.
function preflightRejected(call, value) {
  if (value?.ok !== false || value.results || value.receipt || value.receipts || value.key || value.draft_id) return false;
  return value.error?.code === 'INVALID_ARGUMENTS'
    || (call.name === 'compile_batch' && value.error?.code === 'TOOL_FAILED'
      && value.error.message === '批量执行需要1–8项操作');
}
function marker(call, args, retained) {
  return {
    ...Object.fromEntries(['operation_id','action','id','revision','ref','version'].filter(key => args?.[key] !== undefined).map(key => [key,args[key]])),
    _uno_context: {kind:'repeated_rejected_arguments', original_call_id:call.id, retained_call_id:retained.id,
      arguments_sha256:signature(args), instruction:'这次调用在执行前被拒绝；参数与指定后续调用完全相同，正文保留在那里。本记录不是可执行参数，也不表示后续调用成功。'}
  };
}

/** Pure, deterministic projection. Never writes events, material or reading receipts. */
export function projectUnoMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError('UNO request messages must be an array');
  const existing = measurements.get(messages);
  if (existing) return {messages,stats:existing};
  const stats = {version:UNO_CONTEXT_VERSION, removed_progress:0, compacted_failed_calls:0, deduplicated_results:0};
  const lastProgress = new Map(), progressByIndex = new Map(), calls = new Map(), results = new Map();
  let frontier = -1;
  messages.forEach((message,index) => {
    const p = progress(message); if(p) {lastProgress.set(p.id,index);progressByIndex.set(index,p);}
    for (const block of content(message)) {
      if (message.role === 'assistant' && block.type === 'tool-call') {
        if(calls.has(block.id)) calls.set(block.id,null); else calls.set(block.id,{block,index,args:parse(block.arguments)});
        frontier = index;
      }
      if (message.source?.kind === 'tool' && block.type === 'tool-result' && message.source.callId === block.toolCallId) {
        if(results.has(block.toolCallId)) results.set(block.toolCallId,null); else results.set(block.toolCallId,{block,index,value:resultValue(block)});
      }
    }
  });
  const retainedArguments = new Map();
  for (const row of calls.values()) if(row && results.get(row.block.id) && row.args && !row.args._uno_context)
    retainedArguments.set(row.block.name + ':' + signature(row.args), row);
  const duplicateReads = new Map(), resultReplacements = new Map(), callReplacements = new Map();
  for (const row of [...calls.values()].filter(Boolean).reverse()) {
    const {block:call,index,args} = row, result = results.get(call.id);
    if(!result || result.index <= index || !args) continue;
    if(READ_TOOLS.has(call.name)
        && result.value && result.value.ok !== false && !result.block.isError && !result.value._uno_context) {
      // Compare the WHOLE returned value (revision, offsets, sources, metadata,
      // counterevidence), not just a title, body hash or cumulative read ledger.
      const key = call.name + ':' + signature(args) + ':' + signature(result.block.content);
      const retained = duplicateReads.get(key);
      if(retained && index < frontier && bytes(result.block.content) > 700) {
        resultReplacements.set(result.block,{...result.block,content:[{type:'text',text:JSON.stringify({
          _uno_context:{kind:'duplicate_result',original_call_id:call.id,retained_call_id:retained.id,
            payload_sha256:signature(result.block.content),instruction:'完全相同的工具结果在本次请求的指定后续调用中保留一份；包含完整定位、版本、正文和元数据。'}
        })}]}); stats.deduplicated_results++;
      } else if(!retained) duplicateReads.set(key,call);
    }
    if(index >= frontier || !preflightRejected(call,result.value)) continue;
    // Preserve the latest frontier, including signed reasoning/replay blocks.
    // A modified old assistant will fall back to the provider's public message
    // conversion; never reuse opaque replay state for changed tool arguments.
    if(content(messages[index]).some(b => !['text','tool-call'].includes(b.type))) continue;
    let replacement;
    const later = retainedArguments.get(call.name + ':' + signature(args));
    if(call.name!=='compile_batch' && later && later.index > index && bytes(args)>700) replacement=marker(call,args,later.block);
    else if(call.name==='compile_batch' && Array.isArray(args.operations)) {
      let changed=false;
      const operations=args.operations.map(operation=>{
        if(!operation || typeof operation.tool!=='string' || !operation.args)return operation;
        const retained=retainedArguments.get(operation.tool+':'+signature(operation.args));
        if(!retained || retained.index<=index || bytes(operation.args??{})<=700)return operation;
        changed=true;return {...operation,args:marker(call,operation.args,retained.block)};
      });
      if(changed)replacement={...args,operations};
    }
    if(replacement && bytes(replacement)<Buffer.byteLength(call.arguments)) {
      callReplacements.set(call,{...call,arguments:JSON.stringify(replacement)});stats.compacted_failed_calls++;
    }
  }
  const projected=[];
  messages.forEach((message,index)=>{
    const p=progressByIndex.get(index);
    if(p && lastProgress.get(p.id)!==index) {
      const latest=progressByIndex.get(lastProgress.get(p.id));
      // Keep unknown dynamic sections and changed policies; only identical
      // copies already present in the newest snapshot can disappear with UNO.
      const rest=p.sections.filter(section=>section.name!=='uno-task-progress'
        && !latest.sections.some(s=>s.name===section.name && s.text===section.text));
      stats.removed_progress++;
      if(rest.length)projected.push({...message,source:{...message.source,sections:rest},content:[{type:'text',text:PREFIX+'\n\n'+rest.map(s=>s.text).join('\n\n')}]});
      return;
    }
    let changed=false,changedCall=false;
    const blocks=content(message).map(block=>{
      const replacement=block.type==='tool-call'?callReplacements.get(block):block.type==='tool-result'?resultReplacements.get(block):null;
      if(replacement){changed=true;if(block.type==='tool-call')changedCall=true;return replacement;}return block;
    });
    if(!changed){projected.push(message);return;}
    const source={...message.source};if(changedCall)delete source.replayState;
    projected.push({...message,source,content:blocks});
  });
  stats.message_before_bytes=bytes(modelMessages(messages));stats.message_after_bytes=bytes(modelMessages(projected));
  stats.before_bytes=stats.message_before_bytes;stats.after_bytes=stats.message_after_bytes;
  stats.saved_bytes=stats.before_bytes-stats.after_bytes;
  measurements.set(projected,stats);
  return {messages:projected,stats};
}

// Plugin provenance and event IDs are not prompt text. Opaque replay state can
// contain provider-visible text/signatures, so count it conservatively as well.
function modelMessages(messages) {
  return messages.map(({source,id,...message})=>({...message,...(source?.replayState?{replayState:source.replayState}:{})}));
}
function inputPayload(request) {
  return {system:request.system??'',messages:modelMessages(request.messages??[]),tools:request.tools??[]};
}
export function getUnoRequestGovernance(messages) { return measurements.get(messages); }

/** Includes ALL system text, tool schemas, history and native replay payload.
 * UTF-8 bytes are an enforceable resource limit, not a vendor token prediction.
 */
export function assertUnoRequestBudget(request,{limitBytes=UNO_INPUT_LIMIT_BYTES}={}) {
  request.signal?.throwIfAborted();
  if(!Number.isSafeInteger(limitBytes)||limitBytes<1)throw new TypeError('Invalid UNO input byte budget');
  const payload=inputPayload(request), after=bytes(payload), text=JSON.stringify(payload);
  const prior=measurements.get(request.messages), saved=prior?.saved_bytes??0;
  const ascii=[...text].reduce((n,c)=>n+(c.codePointAt(0)<128?1:0),0);
  const stats={...prior,version:UNO_CONTEXT_VERSION,before_bytes:after+saved,after_bytes:after,saved_bytes:saved,
    input_limit_bytes:limitBytes,estimated_input_tokens:Math.ceil(ascii/3+([...text].length-ascii)),token_estimate:true,
    system_bytes:bytes(payload.system),tool_bytes:bytes(payload.tools),message_bytes:bytes(payload.messages)};
  measurements.set(request.messages,stats);
  if(after>limitBytes)throw Object.assign(new Error(`[UNO_CONTEXT_BUDGET] 完整输入 ${after} UTF-8 字节超过 ${limitBytes} 字节预算，已在模型请求发出前暂停。保留原文、草稿与记录；恢复时重建当前阶段上下文，不扩大总请求额度。`),{code:'UNO_CONTEXT_BUDGET',stats});
  return stats;
}

/** Final transport backstop, including images loaded later by a native SDK. */
export function assertUnoWireBudget(request, body) {
  const stats=measurements.get(request.messages);
  if(!stats)return; // Ordinary chat does not use this compile/construct policy.
  request.signal?.throwIfAborted();
  if(typeof body!=='string')throw Object.assign(new Error('[UNO_CONTEXT_ADAPTER] 无法计量实际请求正文，未发送未受控请求。'),{code:'UNO_CONTEXT_ADAPTER'});
  const size=Buffer.byteLength(body,'utf8');
  stats.wire_bytes=size;
  if(size>stats.input_limit_bytes)throw Object.assign(new Error(`[UNO_CONTEXT_BUDGET] 实际请求正文 ${size} UTF-8 字节超过 ${stats.input_limit_bytes} 字节预算（含工具定义、附件与供应商格式），已在发送前暂停；已有成果和记录保留。`),{code:'UNO_CONTEXT_BUDGET',stats});
  return stats;
}
