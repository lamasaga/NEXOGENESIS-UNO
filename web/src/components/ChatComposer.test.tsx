import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ChatComposer } from "./ChatComposer";
describe("conversation composer", () => {
  it("explains loading without redirecting to a new conversation", () => {
    const html = renderToString(<ChatComposer conversationId="loading" title={null} sending={false} unavailableReason="正在读取所选对话…" onSend={() => undefined} />);
    expect(html).toContain("正在读取所选对话"); expect(html).not.toContain("请先新建对话");
  });
  it("has one durable supplement action and a pause action while running", () => {
    const html = renderToString(<ChatComposer title="编译" sending taskConversation onSend={() => undefined} onInterrupt={() => undefined} />);
    expect(html).toContain("补充要求"); expect(html).toContain("暂停执行");
    expect(html).not.toContain("加入队列"); expect(html).not.toContain("立即插入"); expect(html).not.toContain("刷新页面会清空");
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });
  it("retains ordinary follow-up input and submission errors", () => {
    const html = renderToString(<ChatComposer title="周期讨论" sending={false} notice="发送失败，输入已保留" onSend={() => undefined} />);
    expect(html).toContain("输入消息…"); expect(html).toContain("发送失败，输入已保留");
    expect(html).toContain(">发送</button>");
  });
});
