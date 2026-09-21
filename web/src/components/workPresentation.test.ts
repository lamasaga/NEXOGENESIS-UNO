import { describe, expect, it } from "vitest";
import type { WorkItem } from "../api/client";
import { presentWorkItem } from "./workPresentation";
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationControls } from './ConversationControls';

const base: WorkItem = {
  id: "analysis", title: "经济泡沫的形成机制分析", stage: null, phase: "blocked", executing: false,
  outcome: "blocked", goal: "研究经济泡沫", updated_at: "2026-09-07", can_continue: false,
  native_question: null, interaction: null, proposals: [],
  detail: "闭合审计持续要求 exploration_review；实质分析已闭合，但审计元条件未闭合。",
};

describe("work presentation", () => {
  it('编译本轮结束且有独立待办时不再显示已暂停或答案未交付',()=>{
    const result=presentWorkItem({...base,uno_job_id:'book',stage:'compile',task_status:'partial',phase:'closed',detail:'原件页面待核对，领域待整理。'});
    expect(result).toMatchObject({label:'本轮结束 · 有待办',detail:'原件页面待核对，领域待整理。',openLabel:'查看结果'});
    const noop=()=>{};
    const html=renderToStaticMarkup(createElement(ConversationControls,{work:{...base,uno_job_id:'book',stage:'compile',task_status:'partial',phase:'closed'},busy:false,onPause:noop,onDiscuss:noop,onContinue:noop,onFinish:noop,onDetails:noop}));
    expect(html).toContain('工作已结束');expect(html).not.toContain('继续工作');expect(html).not.toContain('可以讨论、继续');
  });
  it('普通对话生成失败显示未完成与实际原因，不称为阶段性结束',()=>{
    expect(presentWorkItem({...base,phase:'failed',detail:'模型达到输出长度上限'})).toMatchObject({label:'回答未完成',detail:'模型达到输出长度上限'});
  });
  it("treats a blocked ordinary analysis with an answer as a non-actionable partial result", () => {
    const result = presentWorkItem(base);
    expect(result).toMatchObject({ kind: "partial", label: "阶段性结束", openLabel: "查看结果" });
    expect(result.detail).toContain("是否交付完整回答尚未确认");
    expect(result.detail).not.toContain("已经形成可阅读的回答");
    expect(result.detail).not.toContain("exploration_review");
    expect(result.technicalDetail).toContain("exploration_review");
  });

  it("labels a recoverable fixed task as resumable instead of vaguely needing attention", () => {
    expect(presentWorkItem({ ...base, stage: "construct", can_continue: true })).toMatchObject({
      kind: "resumable", label: "可继续", openLabel: "查看记录",
    });
  });

  it("lets a real pending decision override a stale blocked phase", () => {
    expect(presentWorkItem({ ...base, native_question: {
      rpc_id: "q", session_id: "analysis", live: false, questions: [{ id: "scope", question: "选择范围" }],
    } })).toMatchObject({ kind: "waiting", label: "等待你处理", openLabel: "打开并处理" });
  });
});

it("ended jobs preserve the explicit ending label and never imply completion",()=>{
 expect(presentWorkItem({...base,phase:'cancelled',outcome:'ended',detail:'成果和未处理材料保留'})).toEqual({kind:'stopped',label:'已结束',detail:'成果和未处理材料保留',openLabel:'查看记录'});
});

it('interrupted UNO execution displays its actual recovery reason',()=>{
 const reason='上次执行已中断，继续时先核对已保存收据。';
 expect(presentWorkItem({...base,uno_job_id:'job',stage:'construct',phase:'paused',detail:reason}).detail).toBe(reason);
});
