export const CONTENT_SAFETY_CODE = 'MODEL_CONTENT_REJECTED';
export const CONTENT_SAFETY_TITLE = '请求内容被供应商安全审核拦截';
export const CONTENT_SAFETY_MESSAGE = '本次发送给模型的内容触发了供应商的内容安全审核，请求被拒绝。供应商未说明具体触发内容；这不等于已认定原文违规。';
export const CONTENT_SAFETY_NEXT = '当前进度和已保存成果均保留，系统不会自动重发。你可以延期当前单元，继续处理后续内容；如认为是误判，可向模型供应商反馈。延期内容仍算未完成。';

export function isContentSafetyRejection(error, depth = 0) {
  if (!error || depth > 4) return false;
  if (typeof error === 'string') return /the request was rejected because it was considered high risk/i.test(error);
  if (typeof error !== 'object') return false;
  if ([error.code, error.type, error.kind].some(value =>
    [CONTENT_SAFETY_CODE, 'content_filter', 'content-filter', 'content_policy_violation'].includes(value))) return true;
  return [error.message, error.error, error.failure, error.finish].some(value => isContentSafetyRejection(value, depth + 1));
}
