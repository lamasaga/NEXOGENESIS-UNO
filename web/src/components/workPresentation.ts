import type { WorkItem } from "../api/client";

export type WorkPresentationKind = "active" | "waiting" | "resumable" | "partial" | "paused" | "stopped" | "completed" | "idle" | "history";

export interface WorkPresentation {
  kind: WorkPresentationKind;
  label: string;
  detail: string;
  openLabel: string;
  technicalDetail?: string;
}

const hasPendingDecision = (item: WorkItem) => Boolean(
  item.native_question || item.interaction || item.proposals.length > 0 || item.phase === "waiting_user",
);

const withTechnicalDetail = (item: WorkItem, presentation: WorkPresentation): WorkPresentation => {
  const detail = item.detail.trim();
  return detail && detail !== presentation.detail ? { ...presentation, technicalDetail: detail } : presentation;
};

/** Keep runtime states auditable while describing only user-actionable meaning in the primary UI. */
export function presentWorkItem(item: WorkItem): WorkPresentation {
  if (item.outcome === "ended") return { kind: "stopped", label: "已结束", detail: item.detail, openLabel: "查看记录" };
  if (hasPendingDecision(item)) {
    return {
      kind: "waiting",
      label: "等待你处理",
      detail: "需要你选择或确认后才能继续。打开对话会直接定位到待处理项。",
      openLabel: "打开并处理",
    };
  }
  if (item.executing || item.phase === "running") {
    return { kind: "active", label: "执行中", detail: "任务仍在执行，结果会继续显示在原对话中。", openLabel: "查看进展" };
  }
  if (item.phase === "blocked" || item.phase === "failed") {
    if (item.phase === 'failed' && item.stage === null && !item.can_continue) return { kind: 'partial', label: '回答未完成', detail: item.detail || '模型未完整返回回答，请重新发送问题。', openLabel: '查看记录' };
    if (item.can_continue) {
      return withTechnicalDetail(item, {
        kind: "resumable",
        label: "可继续",
        detail: "任务停在可恢复的执行边界，已有进度会保留。可以继续原任务，或先查看记录。",
        openLabel: "查看记录",
      });
    }
    if (item.stage === null) {
      return withTechnicalDetail(item, {
        kind: "partial",
        label: "阶段性结束",
        detail: item.delivery?.state === "delivered" ? "已交付的回答保留；执行遇到问题，未完成项请查看记录，也可继续追问。" : "本轮执行已停止；是否交付完整回答尚未确认，请查看对话和停止记录，也可继续追问。",
        openLabel: "查看结果",
      });
    }
    return withTechnicalDetail(item, {
      kind: "stopped",
      label: "本轮未完成",
      detail: "任务已经停止且当前不能直接接续。查看记录后可以新建任务。",
      openLabel: "查看记录",
    });
  }
  if (item.phase === "closed") {
    if (item.uno_job_id) return { kind: 'partial', label: item.task_status==='partial'?'本轮结束 · 有待办':'本轮已结束', detail:item.detail, openLabel:'查看结果' };
    const delivered = item.delivery?.state === "delivered";
    const partial = item.delivery?.coverage === "partial";
    return { kind: "partial", label: delivered ? partial ? "已回答部分" : item.delivery?.coverage === "answered" ? "已回答" : "已交付 · 覆盖待确认" : "本轮已结束",
      detail: delivered ? item.delivery?.limitations?.map(item => item.detail).join("；") || "答案已保存到对话；交付不代表全部推断已经验证。"
        : "执行已结束，但完整答案交付尚未确认。不会自动重启研究。", openLabel: "查看结果" };
  }
  if (item.phase === "paused") {
    return withTechnicalDetail(item, {
      kind: "paused", label: "已暂停", detail: item.uno_job_id&&item.detail?item.detail:"进度已经保留，可以继续原任务。", openLabel: "查看记录",
    });
  }
  if (item.phase === "cancelled") {
    return withTechnicalDetail(item, {
      kind: "stopped", label: "已停止", detail: "已提交的内容仍然保留；需要时可以查看记录。", openLabel: "查看记录",
    });
  }
  if (item.phase === "completed") {
    return { kind: "completed", label: "已完成", detail: "本轮已经结束，可以查看结果。", openLabel: "查看结果" };
  }
  if (item.phase === "history") {
    return { kind: "history", label: "历史记录", detail: "这是已保留的历史对话，没有正在执行或等待处理的操作。", openLabel: "查看记录" };
  }
  return { kind: "idle", label: "尚未开始", detail: "当前没有正在执行或等待处理的操作。", openLabel: "查看对话" };
}
