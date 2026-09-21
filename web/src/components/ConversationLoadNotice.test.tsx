import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ConversationLoadNotice } from "./ConversationLoadNotice";

describe("conversation load failure", () => {
  it("shows a retryable format error without rendering RPC internals or private paths", () => {
    const html = renderToString(<ConversationLoadNotice state={{ id: "target", pending: false,
      error: new Error('rpc session.history: SessionFormatUnsupportedError: nexo/quick-message unknown to this harness (raw log: D:\\private\\session.jsonl.zstd)'),
    }} hasCurrentConversation onRetry={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("重新读取");
    expect(html).toContain("返回当前对话");
    expect(html).toContain("历史记录的格式");
    expect(html).toContain("输入草稿已保留");
    expect(html).not.toMatch(/private|session\.jsonl|nexo\/quick-message|rpc session/);
  });

  it("keeps an in-flight read distinct from a retryable failure", () => {
    const html = renderToString(<ConversationLoadNotice state={{ id: "target", pending: true }}
      hasCurrentConversation={false} onRetry={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在读取对话");
    expect(html).not.toContain("重新读取");
    expect(html).not.toContain('role="alert"');
  });
});
