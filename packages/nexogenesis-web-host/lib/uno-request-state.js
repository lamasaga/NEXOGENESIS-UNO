/** Project native events onto the existing call ledger; never complete a job here. */
export function updateRequestState(call, event) {
  if (!call) return;
  if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'finish') {
    call.finish_reason = event.data.chunk.reason?.kind ?? 'unknown';
    call.status = ['max-tokens','length'].includes(call.finish_reason) ? 'truncated'
      : ['error','aborted'].includes(call.finish_reason) ? 'failed' : 'returned';
  }
  if (event.type === 'assistant/message') {
    call.status = call.status === 'running' ? 'returned' : call.status;
    call.usage = event.data?.usage ?? call.usage;
    call.response_kind = event.data?.message?.content?.some(b=>b.type==='tool-call') ? 'tool_calls'
      : event.data?.message?.content?.some(b=>b.type==='text'&&b.text?.trim()) ? 'text' : 'no_text';
    call.elapsed_ms = Date.now() - Date.parse(call.started_at);
  }
  if (event.type === 'turn/end') {
    const reason = event.data?.reason?.kind;
    call.turn_end_reason = reason ?? 'unknown';
    if (['max-tokens','length'].includes(reason)) call.status = 'truncated';
    else if (call.status === 'running') call.status = reason === 'cancelled' ? 'cancelled' : 'failed';
  }
}
