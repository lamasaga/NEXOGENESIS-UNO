import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AgentWorkDock } from "./AgentWorkDock";
import { ChatPanel } from "./ChatPanel";
import { ConversationControls } from "./ConversationControls";
import { cardCitationNumbers } from "./CardCitation";

const idleNarration = { phase: "idle" as const, title: "知识图谱", detail: "等待新的问题" };

describe("ChatPanel markdown", () => {
  it("keeps the short question judgment separate from the grounded answer", () => {
    const html = renderToString(<ChatPanel title="t" sending={false} messages={[{
      role: "assistant", content: "有条件的回答", intent: { action: "retrieve", route: "challenge", judgment: "需要检验原主张的边界" },
    }]} />);
    expect(html).toContain("本轮问题判断");
    expect(html).toContain("需要检验原主张的边界");
    expect(html).not.toContain('"action"');
  });
  it("does not add analysis ceremony or sources to a greeting", () => {
    const html = renderToString(<ChatPanel title="t" sending={false} messages={[{
      role: "assistant", content: "你好！", sources: [], intent: { action: "answer", judgment: "问候" },
    }]} />);
    expect(html).toContain("你好！");
    expect(html).not.toContain("本轮问题判断");
    expect(html).not.toContain("检索轨迹");
  });
  it("等待模型时不虚报检索或沿用上一轮已完成状态", () => {
    const html = renderToString(<ChatPanel title="t" sending={true} messages={[]} />);
    expect(html).toContain("请求已发送，正在等待模型响应");
    for (const phase of ["idle", "complete"] as const) {
      const dock = renderToString(<AgentWorkDock sending={true}
        narration={{ phase, title: "本轮知识调用完成", detail: "旧结果" }} />);
      expect(dock).toContain("正在等待模型响应");
      expect(dock).not.toContain("本轮知识调用完成");
      expect(dock).not.toContain("旧结果");
    }
  });

  it("renders assistant message as markdown (list + table)", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false}
        messages={[{
          role: "assistant",
          content: "- 甲\n- 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
        }]} />
    );
    expect(html).toContain("<li>");
    expect(html).toContain("<table>");
  });

  it("keeps user message as plain text", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false}
        messages={[{ role: "user", content: "**不是粗体**" }]} />
    );
    expect(html).not.toContain("<strong>");
    expect(html).toContain("**不是粗体**");
  });

  it("renders real sources and a write confirmation card", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false}
        messages={[{ role: "assistant", content: "回答", sources: [{ id: "a", title: "卡片A" }] }]}
        proposals={[{ proposal_id: "pw-000000000000", summary: "新建一张卡", operations: [{ id: "a", title: "卡片A" }], presentation: {
          title: "建议新增知识卡", explanation: "把整理好的内容保存为新的知识卡。", changes: ["新增《卡片A》"],
          confirm_label: "确认保存新卡", cancel_label: "暂不保存",
        } }]}
        onConfirmProposal={() => undefined} />
    );
    expect(html).toContain("卡片A");
    expect(html).toContain("等待你确认");
    expect(html).toContain("确认保存新卡");
    expect(html).toContain("历史来源");
  });

  it("keeps retrieved context separate from cited evidence", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false}
        messages={[{ role: "assistant", content: "回答", sources: [
          { id: "a", title: "依据卡", kind: "evidence" },
          { id: "b", title: "已读卡", kind: "read" },
          { id: "c", title: "候选卡", kind: "retrieved" },
        ] }]} />
    );
    expect(html).toContain("依据");
    expect(html).toContain("检索轨迹");
    expect(html).toContain("已读");
    expect(html).toContain("召回候选");
  });

  it("将正文中的已精读卡片引用渲染为可打开的阅读入口", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false} onOpenCard={() => undefined}
        messages={[{ role: "assistant", content: "信贷会放大周期[[card:credit-cycle|信贷周期的内生放大机制]]。" }]} />
    );
    expect(html).toContain("信贷周期的内生放大机制");
    expect(html).toContain('class="md-card-citation"');
    expect(html).toContain('data-card-id="credit-cycle"');
    expect(html).not.toContain("[[card:");
    expect(html).toContain(">[1]</button>");
  });

  it("uses short numbers per answer and reuses a number for repeated cards", () => {
    const content = "依据[[card:a|很长的第一张证据卡片标题]]，比较[[card:b|第二个证据]]，再次引用[[card:a|第一张卡的别名]]。";
    const html = renderToString(<ChatPanel title="t" sending={false} onOpenCard={() => undefined}
      messages={[{ role: "assistant", content }]} />);
    expect(html.match(/>\[1\]<\/button>/g)).toHaveLength(2);
    expect(html.match(/>\[2\]<\/button>/g)).toHaveLength(1);
    expect(html).toContain('aria-label="依据 1，阅读知识卡片：很长的第一张证据卡片标题"');
    expect(cardCitationNumbers("`[[card:example|示例]]`\n" + content).get("a")).toBe(1);
    expect(cardCitationNumbers("[[card:b|新回答]]").get("b")).toBe(1);
  });

  it("renders an explicit failed pipeline state with a retry action", () => {
    const html = renderToString(
      <AgentWorkDock narration={idleNarration} sending={false} onRetryPipeline={() => undefined}
        pipelineRun={{ stage: "digest", phase: "failed", label: "任务未完成", detail: "校验失败", steps: ["扫描 Buffer"], startedAt: 1 }} />
    );
    expect(html).toContain("消化暂未完成");
    expect(html).toContain("校验失败");
    expect(html).toContain("继续此任务");
    expect(html).not.toContain("查看失败原因");
  });

  it("does not call a task complete while it is waiting for a user action", () => {
    const html = renderToString(
      <AgentWorkDock narration={idleNarration} sending={false}
        pipelineRun={{ stage: "construct", phase: "waiting_user", label: "建构正在等你处理", steps: [], startedAt: Date.now() }} />
    );
    expect(html).toContain("等待决定");
    expect(html).toContain("需要你决定下一步如何处理");
    expect(html).toContain("请在右侧完成判断");
  });

  it("offers an explicit continuation without hiding the old task", () => {
    const html = renderToString(<AgentWorkDock narration={idleNarration} sending={false} onRetryPipeline={() => undefined}
      pipelineRun={{ stage: "construct", phase: "cancelled", label: "建构已停止", steps: [], startedAt: 1 }} />);
    expect(html).toContain("继续此任务");
    expect(html).not.toContain("归档旧会话");
  });

  it("shows elapsed time for an active pipeline and avoids a generic chat status", () => {
    const html = renderToString(
      <AgentWorkDock narration={idleNarration} sending
        pipelineRun={{ stage: "construct", phase: "running", label: "模型生成", steps: [], startedAt: Date.now() - 6_000 }} />
    );
    expect(html).toContain("已运行");
    expect(html).not.toContain("正在检索知识体并生成回答");
  });

  it("lets a live continuation override a stale stopped pipeline snapshot", () => {
    const html = renderToString(
      <AgentWorkDock narration={idleNarration} sending onRetryPipeline={() => undefined} onStopPipeline={() => undefined}
        pipelineRun={{ stage: "digest", phase: "cancelled", label: "消化已停止", detail: "任务已停止", jobId: "digest-thread", steps: ["request_user_choice"], startedAt: Date.now() }} />
    );
    expect(html).toContain("进行中");
    expect(html).toContain("正在继续消化任务");
    expect(html).toContain("等待你选择处理方向");
    expect(html).toContain(">停止<");
    expect(html).not.toContain("继续执行");
    expect(html).not.toContain("消化已停止");
  });

  it("shows one disabled pause control after an after-wave pause is accepted", () => {
    const html = renderToString(
      <AgentWorkDock narration={idleNarration} sending onStopPipeline={() => undefined}
        pipelineRun={{ stage: "construct", phase: "running", label: "将在当前最小工作单元完成后暂停", pauseRequested: true, jobId: "construct-thread", steps: [], startedAt: Date.now() }} />
    );
    expect(html).toContain("即将暂停");
    expect(html).toContain("disabled");
    expect(html).not.toContain("本波");
  });

  it("names a completed fixed task from its persisted cognitive mode", () => {
    const html = renderToString(
      <AgentWorkDock narration={idleNarration} sending={false} cognition={{
        snapshot: {
          run: { run_id: "r1", mode: "digest", status: "completed", thinking_model: null, step_count: 4, checkpoint_revision: 1 },
          workspace: { goal: "消化", scope: {}, hypotheses: [], evidence: [], counter_evidence: [], open_questions: [], conflicts: [], candidate_actions: [], observed_nodes: [], deferred_items: [], budget: {}, stop_reason: null, extension: {} },
          episode: { episode_id: "e1", steps: [] },
          interaction: null,
        },
        latest: null,
        events: [],
      }} />
    );
    expect(html).toContain(">消化<");
    expect(html).toContain("消化任务已完成");
    expect(html).toContain("详细结果在右侧工作区");
    expect(html).not.toContain("思维任务");
  });

  it("renders a persistent user choice with options and free-form input", () => {
    const html = renderToString(
      <ChatPanel title="建构" sending={false} messages={[]} choiceRequests={[{
        interaction_id: "i-1", run_id: "r-1", session_id: "s-1", type: "choice", status: "pending",
        request_key: "domain-direction", question: "如何处理两个空领域？",
        options: [{ id: "retire", label: "退役空领域", description: "保留原卡并停止作为领域使用。" }, { id: "keep", label: "暂时保留", description: "先补足证据。" }],
      }]} onChoose={() => undefined} />
    );
    expect(html).toContain("请选择下一步");
    expect(html).toContain("退役空领域");
    expect(html).toContain("其他想法");
  });

  it("distinguishes a required confirmation from work that is already applied", () => {
    const waiting = renderToString(
      <AgentWorkDock narration={idleNarration} sending={false} proposals={[{ proposal_id: "p1", summary: "变更", operations: [] }]} />
    );
    expect(waiting).toContain("等待决定");
    expect(waiting).toContain("项待处理");
    expect(waiting).toContain("确认前不会改动知识体");

    const applied = renderToString(
      <AgentWorkDock narration={idleNarration} sending={false} appliedChange={{ created: ["新的知识卡"], enriched: ["已有知识卡"] }} />
    );
    expect(applied).toContain("知识变更已经写入");
    expect(applied).toContain("新的知识卡");
    expect(applied).toContain("已有知识卡");
  });

  it("shows a readable relation confirmation instead of an internal relation code", () => {
    const html = renderToString(
      <ChatPanel title="建构" sending={false} messages={[]} proposals={[{
        proposal_id: "458fdb50", summary: "这条 supports 联系有助于理解地方政府发展模式。", operations: [], presentation: {
          title: "建议建立一条知识联系",
          explanation: "将《党政不分框架的适用条件与边界》与《地方政府发展模式三结构特征与改革议程》联系起来。前一张卡可以为后一张卡提供理解上的依据。",
          reason: "这条联系有助于理解地方政府的发展模式。",
          changes: ["让《党政不分框架的适用条件与边界》成为理解《地方政府发展模式三结构特征与改革议程》时可参照的知识。"],
          confirm_label: "确认保存这条联系", cancel_label: "不保存，继续寻找更合适的联系",
        },
      }]} onConfirmProposal={() => undefined} />
    );
    expect(html).toContain("建议建立一条知识联系");
    expect(html).toContain("确认保存这条联系");
    expect(html).toContain("不保存，继续寻找更合适的联系");
    expect(html).not.toContain("458fdb50");
    expect(html).not.toContain("supports");
  });

  it("does not duplicate the live tool trace inside a fixed pipeline thread", () => {
    const chat = renderToString(
      <ChatPanel title="消化工作流" sending messages={[]} pipelineStage="digest"
        pipelineRun={{ stage: "digest", phase: "running", label: "正在生成", steps: [], startedAt: Date.now() }} />
    );
    const workbench = renderToString(<AgentWorkDock narration={idleNarration} sending steps={[{ kind: "tool", label: "解析第 1/4 版草稿" }]} />);
    expect(chat).not.toContain("真实工具轨迹");
    expect(workbench).toContain("正在检查刚形成的判断");
    expect(workbench).not.toContain("解析第 1/4 版草稿");
  });

  it("renders a compact fixed-thread start state instead of empty bubbles", () => {
    const html = renderToString(
      <ChatPanel title="消化" sending={false} pipelineStage="digest"
        messages={[{ role: "user", content: "" }, { role: "assistant", content: "" }]} />
    );
    expect(html).toContain("消化任务尚未开始");
    expect(html).toContain("查看记录不会自动执行任务");
    expect(html).not.toContain("rounded-br-sm");
  });

  it("does not call a command-only pipeline record completed", () => {
    const html = renderToString(
      <ChatPanel title="消化" sending={false} pipelineStage="digest"
        messages={[{ role: "user", content: "/digest", ts: "2026-08-31T00:00:00.000Z" }]} />
    );
    expect(html).toContain("本轮没有可展示的结果");
    expect(html).toContain("不会把空记录标为已完成");
    expect(html).not.toContain("本次结果");
  });

  it("presents an idle thinking body without repeating the graph title", () => {
    const html = renderToString(<AgentWorkDock narration={idleNarration} sending={false} />);
    expect(html).toContain("思维体");
    expect(html).toContain("就绪");
    expect(html).toContain("当前没有运行中的任务");
    expect(html).toContain("可以直接提问");
    expect(html).not.toContain("知识图谱");
  });

  it("does not present an audit-only blocked analysis as an action the user must handle", () => {
    const work: import("../api/client").WorkItem = {
      id: "analysis", title: "经济泡沫的形成机制分析", stage: null, phase: "blocked", executing: false,
      outcome: "blocked", goal: "分析泡沫机制", detail: "闭合审计要求 exploration_review，但实质分析已闭合。",
      updated_at: "2026-09-07", can_continue: false, native_question: null, interaction: null, proposals: [],
    };
    const chat = renderToString(<ChatPanel title={work.title} sending={false} work={work}
      messages={[{ role: "assistant", content: "本轮已经形成结论。" }]} />);
    const dock = renderToString(<AgentWorkDock narration={idleNarration} sending={false} work={work} />);
    for (const html of [chat, dock]) {
      expect(html).toContain("阶段性结束");
      expect(html).toContain("继续追问");
      expect(html).not.toContain("exploration_review");
      expect(html).not.toContain("需要处理");
    }
  });

  it("summarizes archived pipeline results as a compact achievement record", () => {
    const html = renderToString(
      <ChatPanel title="编译工作流" sending={false} messages={[]} pipelineStage="compile"
        pipelineHistory={{
          archived_runs: 8, completed_runs: 7, failed_runs: 1, paused_runs: 0,
          buffers: 46, cards_created: 0, cards_enriched: 0, cards_adjusted: 0,
          recent: [{
            stage: "compile", ts: "2026-08-13T10:20:00", status: "completed",
            summary: "编译已完成：写入 6 个 Buffer。", buffers: 6,
            cards_created: 0, cards_enriched: 0, cards_adjusted: 0,
          }],
        }} />
    );
    expect(html).toContain("历史成果");
    expect(html).toContain("pipeline-history__count");
    expect(html).toContain(">8<");
    expect(html).toContain("46");
    expect(html).toContain("完整展示最近 3 次");
  });
});


it("收起已有编译时只在可滚动记录中显示完整原因，不重复或误报尚未开始", () => {
  const detail = "已保存 11 张卡片；仍有章节覆盖问题。" + "具体证据与修改建议。".repeat(100);
  const work: import("../api/client").WorkItem = {
    id: "compile", title: "编译", stage: "compile", phase: "paused", executing: false,
    outcome: "paused", goal: "编译图书", updated_at: "2026-09-17", can_continue: true,
    native_question: null, interaction: null, proposals: [], detail, uno_job_id: "book-job",
    task_status: "paused",
  };
  const noop = () => {};
  const html = renderToString(<><ChatPanel title="编译" sending={false} messages={[]} work={work} pipelineStage="compile"/>
    <ConversationControls work={work} busy={false} onPause={noop} onDiscuss={noop} onContinue={noop} onFinish={noop} onDetails={noop}/></>);
  expect(html.split(detail)).toHaveLength(2);
  expect(html.indexOf(detail)).toBeGreaterThan(html.indexOf('class="chat-panel__messages"'));
  expect(html).toContain('aria-label="当前工作记录"');
  expect(html).not.toContain("任务尚未开始");
  expect(html).toContain("继续工作");
});
