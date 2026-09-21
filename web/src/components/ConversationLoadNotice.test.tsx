import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ConversationLoadNotice } from "./ConversationLoadNotice";

describe("conversation load failure", () => {
  it("shows a retryable format error without rendering RPC internals or private paths", () => {
    const html = renderToString(<ConversationLoadNotice state={{ id: "target", pending: false,
      error: new Error('rpc session.history: SessionFormatUnsupportedError: nexo/quick-message unknown to this harness (raw log: D:\\private\\session.jsonl.zstd)'),
    }} hasCurrentConversation onRetry={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("重新读取");
    expect(html).toContain("关闭提示");
    expect(html).toContain("历史记录的格式");
    expect(html).not.toMatch(/private|session\.jsonl|nexo\/quick-message|rpc session/);
  });

  it("keeps an in-flight read distinct from a retryable failure", () => {
    const html = renderToString(<ConversationLoadNotice state={{ id: "target", pending: true }}
      hasCurrentConversation={false} onRetry={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在读取最近对话");
    expect(html).not.toContain("重新读取");
    expect(html).not.toContain('role="alert"');
  });

  it("keeps cached content visible while a background refresh fails", () => {
    const html = renderToString(<ConversationLoadNotice state={{ id: "target", pending: false, cached: true,
      error: new Error("network failed"),
    }} hasCurrentConversation onRetry={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("最新消息暂时无法同步");
    expect(html).toContain("已显示上次读取的内容");
    expect(html).toContain("输入草稿不受影响");
  });
});
