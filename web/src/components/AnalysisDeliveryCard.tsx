import type { CognitiveRunSnapshot } from "../api/client";

/** Public result provenance, not an animation or a rendering of private model reasoning. */
export function AnalysisDeliveryCard({ snapshot, onOpenCard }: { snapshot?: CognitiveRunSnapshot; onOpenCard?: (id: string) => void }) {
  const delivery = snapshot?.run.delivery;
  const review = snapshot?.delivery_review;
  if (!delivery || snapshot?.run.analysis_policy_version !== "conversation-v2") return null;
  const findings = review && review.fingerprint === delivery.review_ref ? review.relation_findings : [];
  if (!delivery.limitations.length && !findings?.length && delivery.state === "delivered") return null;
  return <section className="proposal-card analysis-delivery" aria-label="本轮分析的依据与限制">
    <strong>{delivery.state === "prepared" ? "回答准备中，尚未确认交付" : delivery.state === "interrupted" ? "回答已中断" : "本轮依据与未完成项"}</strong>
    {delivery.limitations.length > 0 && <ul>{delivery.limitations.map((item, index) => <li key={`${item.code}-${index}`}>{item.claim_id ? `${item.claim_id}：` : ""}{item.detail}</li>)}</ul>}
    {findings?.length > 0 && <details><summary>查看关系如何影响判断（{findings.length}）</summary>
      <p>路径存在与正文已读不等于推断已被证明。以下为模型的公开综合结果。</p>
      {findings.map((item, index) => <article key={`${item.claim_id}-${index}`}>
        <p><strong>{item.claim_id}</strong> · {item.provenance === "observed_and_read" ? "实际路径与阅读可回查" : "路径依据尚未核验"}{item.outcome === "rejected" ? " · 未采用" : ""}</p>
        <p>{item.finding}</p><p>条件与断点：{item.conditions}</p>
        {item.provenance === "observed_and_read" && <>
          <p>{item.path.map((id, i) => <span key={`${id}-${i}`}>{i > 0 ? " — " : ""}<button type="button" onClick={() => onOpenCard?.(id)}>{id}</button></span>)}</p>
          <ul>{item.edges.map((edge, i) => <li key={i}>{edge.from} → {edge.to}（{edge.type}）：{edge.note}</li>)}</ul>
          <p>此处箭头为关系声明方向，不是自动推导出的因果方向；观察记录 #{item.observation_step}。</p>
        </>}
      </article>)}
    </details>}
  </section>;
}
