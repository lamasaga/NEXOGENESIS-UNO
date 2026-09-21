import type { WriteProposal } from "../api/client";

interface Props {
  proposal: WriteProposal;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmCard({ proposal, busy = false, onConfirm, onCancel }: Props) {
  const presentation = proposal.presentation ?? {
    title: "建议保存这项知识调整",
    explanation: "这项调整已经通过写入前检查，等待你决定是否保存。",
    changes: [],
    confirm_label: "确认保存",
    cancel_label: "暂不保存",
  };
  return (
    <section className="proposal-card" aria-label="待确认的知识写入提案">
      <div className="proposal-card__eyebrow"><span className="proposal-card__dot" />等待你确认</div>
      <h3 className="proposal-card__title">{presentation.title}</h3>
      <p className="proposal-card__summary">{presentation.explanation}</p>
      {presentation.reason ? <p className="proposal-card__reason">这样做的理由：{presentation.reason}</p> : null}
      {presentation.changes.length > 0 ? <ul className="proposal-card__ops">
        {presentation.changes.map((change, index) => <li key={index}>{change}</li>)}
      </ul> : null}
      {proposal.operations.length === 1 && typeof proposal.operations[0].body === "string" ?
        <details className="proposal-card__preview"><summary>预览修改后的正文</summary><p>{String(proposal.operations[0].body).slice(0, 900)}</p></details> : null}
      {proposal.warnings?.length ? <details className="proposal-card__technical"><summary>查看依据与技术记录</summary><p>{proposal.warnings[0]}</p></details> : null}
      <div className="proposal-card__actions">
        <button className="proposal-button proposal-button--quiet" disabled={busy} onClick={onCancel}>{presentation.cancel_label}</button>
        <button className="proposal-button proposal-button--confirm" disabled={busy} onClick={onConfirm}>
          {busy ? "正在保存…" : presentation.confirm_label}
        </button>
      </div>
    </section>
  );
}
