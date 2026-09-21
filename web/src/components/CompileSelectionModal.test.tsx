import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { CompileSelectionModal } from "./CompileSelectionModal";

describe("CompileSelectionModal", () => {
  it("explains that one selected Inbox material defines the compile scope", () => {
    const html = renderToString(
      <CompileSelectionModal onClose={() => undefined} onConfirm={() => undefined} />
    );
    expect(html).toContain("这次编译哪份材料");
    expect(html).toContain("本次只处理你选中的一份材料");
    expect(html).toContain('role="dialog"');
  });

  it("supports selecting a multi-book theme corpus", () => {
    const html = renderToString(
      <CompileSelectionModal mode="theme_compile" onClose={() => undefined} onConfirm={() => undefined} />
    );
    expect(html).toContain("选择同一主题的一组图书");
    expect(html).toContain("选择 2–30 份相关材料");
    expect(html).toContain("开始主题编译");
  });
});
