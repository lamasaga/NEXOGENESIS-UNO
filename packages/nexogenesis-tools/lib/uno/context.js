import { normalizeJsonValue } from '../json-value.js';
import { boundedWorkflow, workflowRole } from './prompt-orchestration.js';
import { classificationContractForJob } from './card-classification.js';

/** Stable instructions stay in system; changing facts are logged trailing messages. */
export function taskInstructions(job) {
  return JSON.stringify(normalizeJsonValue({id: job.id, mode: job.mode, date: job.created_at?.slice(0,10),
    card_classification: classificationContractForJob(job),
    construction_controls:job.construction_controls,
    goal: job.requirements?.notes ?? job.notes ?? '', long_term: job.requirements?.long_term ?? '',
    preferences: job.requirements?.preferences ?? {}}));
}

export function taskProgress(job,{providerBudget}={}) {
  const direct=boundedWorkflow(job),role=workflowRole(job);
  return normalizeJsonValue({id: job.id, phase: job.phase, role: job.role ?? 'author',
    card_classification: classificationContractForJob(job),
    batch: job.batches?.[job.batch_index]?.length ? job.batch_index + 1 : null,
    total_batches: job.batches?.length ?? 0, remaining_calls: providerBudget?.remaining??Math.max(0, job.budget.calls - job.calls.length),
    ...(providerBudget?{request_budget:providerBudget}:{}),
    checkpoint: job.checkpoint ?? '', directives: job.user_directives ?? [],
    pending_batch_count: (job.completed_batches ?? []).filter(b => b.pending).length,
    pending_lookup: 'compile_task(view=pending,offset=0)，分页查看未完范围',
    ...(direct?{orchestration_profile:job.orchestration_profile,current_scope:job.batches?.[job.batch_index]??[],
      role_goal:role==='reviewer'?'验证当前提案与来源；问题交回作者，不扩大整理':'改善本批既有知识的明确问题'}:{}),
    next: job.handoff_requested || job.finish_requested ? '结束当前回复，由宿主继续交接。' : direct?'直接处理阶段首包；只补读缺失证据或按具体需要查收据、待办。不重复索取已有目录与正文。':'按需用 compile_task 查看目录、草稿、待办；不可把读取计作理解；历史压缩后需要精确引文时按来源与版本重新定位，不重做已提交工作。'});
}
