import { HttpError } from "./rpc.js";

const goals = {
  understand: ["深入理解", "general", "nexo-talk", "解释机制、适用条件和未知；与用户交流，不强制报告。"],
  compare: ["比较解释", "general", "nexo-talk", "对齐比较口径，保留分歧、竞争解释与边界。"],
  assess: ["检验判断", "assess", "nexo-assess", "核查关键假设、最强异议及可能改变判断的信号。"],
  report: ["形成报告", "report", "nexo-report", "面向读者形成有来源、有边界的报告；当前在对话中交付。"],
};
export function prepareThinking(request, message) {
  if (request?.mode === "quick") {
    if (typeof message !== "string" || !message.trim() || message.length > 12000 || request.trial) throw new HttpError(400, "请填写有效问题；预设路线不使用旧研究试用。");
    // Older clients may send a preferred route; every turn now uses model intent.
    return { quick: true };
  }
  if (request?.mode !== undefined && request.mode !== "research") throw new HttpError(400, "未知思考模式。");
  if (!request || typeof request !== "object" || !Object.hasOwn(goals, request.goal)
    || !["auto", "standard", "deep"].includes(request.depth) || (request.trial !== undefined && typeof request.trial !== "boolean")
    || typeof message !== "string" || !message.trim() || message.length > 12000) throw new HttpError(400, "请填写思考问题，并选择有效的目标和深度。");
  const [label, mode, skill, guidance] = goals[request.goal];
  return { mode, skill, label, trial: request.trial === true, scope: { analysis_depth: "iterative", complexity_level: request.depth === "deep" ? "deep" : "standard" },
    // Auto remains a semantic decision, not an arbitrary frontend budget override.
    auto: request.depth === "auto",
    prompt: `思考：${label} · ${request.depth === "auto" ? "按问题决定" : request.depth === "deep" ? "深入" : "标准"}\n\n${message.trim()}\n\n[THINKING_CONTEXT]\n${guidance}\n读取 ${skill} 的 Skill；必要时先澄清。需要分析时选择适用 TM、自主取证并完成验收，不固定 OPS 顺序。选项只作用于本次问题，后续允许自由聊天。默认不写卡。` };
}
