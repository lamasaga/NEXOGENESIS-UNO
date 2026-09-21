import "./ConversationLoadNotice.css";

export type ConversationLoadState = {
  id: string;
  pending: boolean;
  cached?: boolean;
  error?: unknown;
};

export function ConversationLoadNotice({ state, hasCurrentConversation, onRetry, onDismiss }: {
  state: ConversationLoadState;
  hasCurrentConversation: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const detail = state.error instanceof Error ? state.error.message : String(state.error ?? "");
  const unsupported = /SessionFormatUnsupportedError|unknown to this harness|unsupported.*(?:event|format)/i.test(detail);
  return <section className="conversation-load-notice" aria-label="对话加载状态" aria-busy={state.pending}>
    <div role={state.pending ? "status" : "alert"}>
      <strong>{state.pending ? state.cached ? "正在同步最新消息…" : "正在读取最近对话…" : state.cached ? "最新消息暂时无法同步" : "这段对话暂时无法打开"}</strong>
      {!state.pending && <p>{unsupported
        ? "当前后台尚未识别这段历史记录的格式，请更新后台后重试。"
        : "对话记录读取失败，请稍后重试。"}</p>}
      {state.cached && <p>已显示上次读取的内容；输入草稿不受影响。</p>}
      {!state.cached && hasCurrentConversation && <p>已进入目标对话，最近消息仍在载入。</p>}
    </div>
    <div className="conversation-load-notice__actions">
      {!state.pending && <button type="button" onClick={onRetry}>重新读取</button>}
      <button type="button" onClick={onDismiss}>关闭提示</button>
    </div>
  </section>;
}
