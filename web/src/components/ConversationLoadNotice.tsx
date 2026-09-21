import "./ConversationLoadNotice.css";

export type ConversationLoadState = {
  id: string;
  pending: boolean;
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
      <strong>{state.pending ? "正在读取对话…" : "这段对话暂时无法打开"}</strong>
      {!state.pending && <p>{unsupported
        ? "当前后台尚未识别这段历史记录的格式，请更新后台后重试。"
        : "对话记录读取失败，请稍后重试。"}</p>}
      {hasCurrentConversation && <p>下方仍是原对话，输入草稿已保留。</p>}
    </div>
    <div className="conversation-load-notice__actions">
      {!state.pending && <button type="button" onClick={onRetry}>重新读取</button>}
      <button type="button" onClick={onDismiss}>{hasCurrentConversation ? "返回当前对话" : "关闭提示"}</button>
    </div>
  </section>;
}
