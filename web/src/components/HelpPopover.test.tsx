import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { HelpPopover } from "./HelpPopover";

describe("HelpPopover", () => {
  it("explains current UNO entry points, task states, and write boundaries", () => {
    const html = renderToString(<HelpPopover />);

    expect(html).toContain("UNO 使用指南");
    expect(html).toContain("按阅读单元直接生成、检查并保存卡片");
    expect(html).toContain("不再经过“消化”");
    expect(html).toContain("待修复队列");
    expect(html).toContain("审核后按当前设置自动保存");
    expect(html).toContain("绑定创建任务时的知识库");
    expect(html).not.toContain("NEXO 使用地图");
    expect(html).not.toContain("先把材料整理为 Buffer");
    expect(html).not.toContain("专题报告");
    expect(html).not.toContain("精修卡片");
  });
});
