import { normalizeJsonValue } from '../json-value.js';

/** Used at model-visible tool boundaries, including successful persisted writes. */
export function toolResult(value) {
  return normalizeJsonValue(Array.isArray(value) ? {items: value} : value);
}

export function toolFailure(error) {
  const message = String(error?.message ?? error);
  const code = error?.code ?? (error?.receipt ? 'HARNESS_REJECTED' : error?.name === 'AbortError' ? 'TASK_STOPPED' : 'TOOL_FAILED');
  const recovery = {
    TASK_STOPPED: '停止操作，保留已保存成果。', STALE_CONTEXT: '停止旧会话操作，由宿主确认当前任务与角色。',
    SCOPE_VIOLATION: '只处理当前授权范围；不要改用其他工具绕过。', INVALID_ARGUMENTS: '按参数契约修正本次调用，未执行写入。',
    REVISION_CONFLICT: '读回当前对象和版本，再用新的操作 ID 修改。',
    IDEMPOTENCY_CONFLICT: '该操作 ID 已对应其他内容；先查原收据，修订内容使用新 ID。',
    COMMIT_UNKNOWN: '先用 compile_task receipts 查询原操作 ID，确认提交事实后再决定；不重放成功写入。',
  }[code] ?? '依据具体错误修正参数；写入结果不确定时先查收据，不原样重复成功操作。';
  return {ok:false,error:{code,message,recovery,...(error?.details ? {details:error.details} : {})},
    ...(error?.receipt ? {receipt:toolResult(error.receipt)} : {})};
}
