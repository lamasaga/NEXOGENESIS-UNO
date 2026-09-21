/**
 * 图谱事件与画布渲染共用的单调时钟（秒）。
 *
 * 必须保留 performance.now() 的绝对时间基准：图谱数据刷新会重建画布，
 * 但不会重启页面与 SSE 事件流；若画布自行从 0 计时，已接收的激活事件
 * 会被误判为发生在未来，导致遮罩无法退出。
 */
export function activationNow(nowMs = performance.now()): number {
  return nowMs / 1000;
}
