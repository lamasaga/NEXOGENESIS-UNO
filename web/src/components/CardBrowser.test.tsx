import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { CardBrowser } from "./CardBrowser";

describe("CardBrowser", () => {
  it("presents search, classification, relationship filtering and in-place reading as one dialog", () => {
    const html = renderToString(<CardBrowser onClose={() => undefined} />);
    expect(html).toContain("知识卡片");
    expect(html).toContain("搜索标题、正文与关系");
    expect(html).toContain("全部类型");
    expect(html).not.toContain("全部标签");
    expect(html).toContain("全部领域");
    expect(html).toContain("全部关系");
    expect(html).toContain("未组织池");
    expect(html).toContain('aria-label="知识卡片正文"');
    expect(html).toContain('role="dialog"');
  });
  it('shows a loading state instead of a false empty repair pool',()=>{
    const html=renderToString(<CardBrowser initialPoolMode onClose={()=>undefined}/>);
    expect(html).toContain('正在读取未组织池');
    expect(html).not.toContain('未组织池中没有匹配卡片');
    expect(html).not.toContain('0 项待处理');
  });
});
