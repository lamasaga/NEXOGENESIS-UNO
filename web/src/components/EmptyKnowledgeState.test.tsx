import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { EmptyKnowledgeState } from "./EmptyKnowledgeState";

describe("EmptyKnowledgeState", () => {
  it("treats a cardless knowledge base as a usable starting state", () => {
    const html = renderToString(<EmptyKnowledgeState onStartConversation={() => undefined} />);

    expect(html).toContain("新的知识库");
    expect(html).toContain("先提出问题");
    expect(html).toContain("先导入材料");
    expect(html).toContain("开始一个问题");
  });
});
