import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { NativeQuestionForm } from "./WorkCenter";
import { AgentWorkDock } from "./AgentWorkDock";
import type { WorkItem } from "../api/client";

describe("restored waiting work", () => {
  const work: WorkItem = { id: "a", title: "讨论", stage: null, phase: "waiting_user", executing: true, outcome: "completed", goal: null, detail: "有问题等待你的选择", updated_at: "2026-09-05", can_continue: false, proposals: [], interaction: null,
    native_question: { rpc_id: "q", session_id: "a", live: true, questions: [{ id: "scope", question: "选择方向", options: [{ label: "机制" }, { label: "历史" }] }] } };
  it("原生问题可见但没有默认代选，即使模型仍处于运行态", () => {
    const html = renderToString(<NativeQuestionForm question={work.native_question!} onAnswer={async () => {}} />);
    expect(html).toContain("选择方向"); expect(html).toContain("提交回答并继续");
    expect(html).not.toContain('checked=""'); expect(html).toContain('disabled=""');
  });
  it("等待状态优先于上轮完成记录和模型运行标记", () => {
    const html = renderToString(<AgentWorkDock work={work} sending narration={{ phase: "complete", title: "旧结果", detail: "已结束" }} />);
    expect(html).toContain("等待决定"); expect(html).toContain("选择方向"); expect(html).not.toContain("本轮任务已完成");
  });
});
