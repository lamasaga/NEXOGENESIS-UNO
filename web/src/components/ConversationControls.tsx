import type { WorkItem } from '../api/client';

export function ConversationControls({work,busy,onPause,onDiscuss,onContinue,onFinish,onDetails}:{
  work:WorkItem;busy:boolean;onPause:()=>void;onDiscuss:()=>void;onContinue:()=>void;onFinish:()=>void;onDetails:()=>void;
}) {
  return <div className="task-record-actions" aria-label="当前会话工作控制">
    <p>{work.control_pending?'正在等待执行退出…':work.task_status==='ended'||work.task_status==='closed'||work.phase==='closed'?'工作已结束；成果和未完成记录保留。':work.executing?'正在执行 · 切换对话不会停止。':work.task_status==='completed'?'工作已完成，可以继续交流。':work.discussing?'原工作进度与预算已保留，可继续交流。':'本批进度已保留；可以讨论、继续或结束工作。'}</p>
    {work.executing&&<button disabled={busy||!!work.control_pending} onClick={onPause}>暂停执行</button>}
    {work.can_discuss&&<button disabled={busy} onClick={onDiscuss}>讨论结果</button>}
    {work.can_continue&&<button disabled={busy} onClick={onContinue}>继续工作</button>}
    {work.can_finish&&<button disabled={busy||!!work.control_pending} onClick={onFinish}>结束这项工作</button>}
    {work.uno_job_id&&<button disabled={busy} onClick={onDetails}>{work.task_status==='review'?'查看并确认本批':'查看工作详情'}</button>}
    {!!work.held_inputs?.length&&<details><summary>已保存 {work.held_inputs.length} 条补充要求</summary>{work.held_inputs.map(m=><p key={m.id}>{m.text}</p>)}</details>}
  </div>;
}
