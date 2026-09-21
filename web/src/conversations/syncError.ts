export function workSyncErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const detail = error instanceof Error ? error.message : '';
  const reason = name === 'TimeoutError' || name === 'AbortError'
    ? '进度同步超时，正在重试。'
    : name === 'TypeError' ? '网页暂时无法连接后台，正在重试。'
    : `进度请求失败${detail ? `：${detail.slice(0, 200)}` : ''}。正在重试。`;
  return reason + ' 当前显示上次确认的状态；这不代表模型调用失败，也不会自动暂停任务。';
}
