import { useEffect, useState } from "react";
import { fetchGraphOverview, readCachedGraphOverview, type GraphOverviewStats, type OverviewCount } from "../api/client";
import { TYPE_LABELS } from "./cardReading";

const RELATION_COLORS: Record<string, string> = {
  specialization: "#22d3ee", supplement: "#34d399", contrast: "#fbbf24", challenge: "#f472b6",
  analogy: "#c084fc", example: "#a3e635", application: "#58bfe5",
  // Historical cards remain readable while current compilation writes the seven relations above.
  "applies-to": "#58bfe5", influences: "#818cf8", supports: "#34d399", "based-on": "#fbbf24",
  "conflicts-with": "#f472b6", involves: "#fb7185", extends: "#22d3ee", "example-of": "#a3e635",
  "part-of": "#c084fc", precedes: "#94a3b8",
};
const FALLBACK_COLORS = ["#67e8f9", "#fda4af", "#c4b5fd", "#fcd34d", "#86efac"];
export function GraphOverview({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<GraphOverviewStats | null>(() => readCachedGraphOverview({ allowStale: true }));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const hadCachedOverview = Boolean(readCachedGraphOverview({ allowStale: true }));
    fetchGraphOverview().then((value) => { if (!cancelled) setStats(value); })
      .catch((reason) => { if (!cancelled && !hadCachedOverview) setError(String(reason)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="graph-overview-overlay" role="presentation" onClick={onClose}>
    <section className="graph-overview" role="dialog" aria-modal="true" aria-labelledby="graph-overview-title" onClick={(event) => event.stopPropagation()}>
      <button className="graph-overview__close" onClick={onClose} aria-label="关闭图谱概览">✕</button>
      {error ? <p className="graph-overview__status">概览未能加载：{error}</p>
        : !stats ? <GraphOverviewLoader />
        : <OverviewBody stats={stats} />}
    </section>
  </div>;
}

function GraphOverviewLoader() {
  return <div className="graph-overview__loader" role="status" aria-label="正在读取知识卡与关系">
    <svg className="graph-overview__loader-graph" viewBox="0 0 260 128" aria-hidden="true">
      <g className="graph-overview__loader-halo"><circle cx="130" cy="64" r="26" /></g>
      <g className="graph-overview__loader-edges graph-overview__loader-edges--inner">
        <line x1="130" y1="64" x2="96" y2="46" /><line x1="130" y1="64" x2="118" y2="31" />
        <line x1="130" y1="64" x2="156" y2="38" /><line x1="130" y1="64" x2="175" y2="61" />
        <line x1="130" y1="64" x2="149" y2="88" /><line x1="130" y1="64" x2="108" y2="87" />
      </g>
      <g className="graph-overview__loader-edges graph-overview__loader-edges--outer">
        <line x1="96" y1="46" x2="68" y2="61" /><line x1="96" y1="46" x2="82" y2="24" />
        <line x1="118" y1="31" x2="132" y2="15" /><line x1="156" y1="38" x2="185" y2="26" />
        <line x1="175" y1="61" x2="202" y2="74" /><line x1="149" y1="88" x2="177" y2="103" />
        <line x1="108" y1="87" x2="115" y2="108" /><line x1="108" y1="87" x2="70" y2="94" />
      </g>
      <g className="graph-overview__loader-nodes graph-overview__loader-nodes--outer">
        <circle cx="68" cy="61" r="3" /><circle cx="82" cy="24" r="3" /><circle cx="132" cy="15" r="3" />
        <circle cx="185" cy="26" r="3" /><circle cx="202" cy="74" r="3" /><circle cx="177" cy="103" r="3" />
        <circle cx="115" cy="108" r="3" /><circle cx="70" cy="94" r="3" />
      </g>
      <g className="graph-overview__loader-nodes graph-overview__loader-nodes--inner">
        <circle cx="96" cy="46" r="4" /><circle cx="118" cy="31" r="4" /><circle cx="156" cy="38" r="4" />
        <circle cx="175" cy="61" r="4" /><circle cx="149" cy="88" r="4" /><circle cx="108" cy="87" r="4" />
      </g>
      <circle className="graph-overview__loader-core" cx="130" cy="64" r="6" />
    </svg>
    <strong>正在构建图谱概览</strong>
    <span>读取知识卡与关系结构</span>
  </div>;
}

function OverviewBody({ stats }: { stats: GraphOverviewStats }) {
  return <>
    <header className={`graph-overview__judgment graph-overview__judgment--${stats.judgment.tone}`}>
      <div className="graph-overview__judgment-head"><span aria-hidden>△</span><h2 id="graph-overview-title">知识卡与关系</h2></div>
      <p>{stats.judgment.text}</p>
    </header>
    <div className="graph-overview__metrics">
      <Metric value={stats.node_count} label="卡片节点" /><Metric value={stats.edge_count} label="关系边" />
      <Metric value={stats.domain_count} label="领域" /><Metric value={stats.entity_count} label="实体" />
    </div>
    <Distribution title="主类型比例" items={stats.node_types.map(item=>({...item,type:TYPE_LABELS[item.type]??item.type}))} total={stats.node_count}
      note="每张卡只有一个主类型，各项比例互不重叠。" colorFor={(_type,index)=>FALLBACK_COLORS[index%FALLBACK_COLORS.length]} />
    <Distribution title="关系比例" items={stats.relation_types} total={stats.edge_count} colorFor={(type, index) => colorOf(type, RELATION_COLORS, index)} highlight={stats.relation_highlight} />
  </>;
}

function Metric({ value, label }: { value: number; label: string }) {
  return <div className="graph-overview__metric"><strong>{value.toLocaleString("zh-CN")}</strong><span>{label}</span></div>;
}

export function Distribution({ title, items, total, note, colorFor, highlight, searchable = false }: { title: string; items: OverviewCount[]; total:number; note?:string; searchable?:boolean; colorFor: (type: string, index: number) => string; highlight?: GraphOverviewStats["relation_highlight"]; }) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(12);
  const filtered = items.map((item, index) => ({ item, index })).filter(({ item }) => item.type.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visible = searchable ? filtered.slice(0, visibleCount) : filtered;
  const percentage=(count:number)=>total>0?Math.min(100,Math.max(0,count/total*100)):0;
  const label=(count:number)=>{const value=percentage(count);return value>0&&value<0.1?'<0.1%':`${Number(value.toFixed(1))}%`;};
  return <section className="graph-overview__dist">
    <div className="graph-overview__dist-head"><h3>{title}</h3></div>
    {note&&<p className="graph-overview__note">{note}</p>}
    {searchable && items.length > 0 && <input className="graph-overview__search" type="search" aria-label="查找图谱分类" placeholder="查找主类型或领域" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(12); }} />}
    {!filtered.length&&<p className="graph-overview__note">{items.length ? "没有匹配的分类" : "暂无"}</p>}
    <div className="graph-overview__percentages">{visible.map(({item,index})=><div className="graph-overview__percentage" key={item.type}>
      <span>{item.type}{highlight?.types.includes(item.type)&&<small> · {highlight.note}</small>}</span>
      <div className="graph-overview__bar" aria-hidden="true"><span style={{width:`${percentage(item.count)}%`,background:colorFor(item.type,index)}}/></div>
      <strong>{label(item.count)}</strong>
    </div>)}</div>
    {searchable && filtered.length > visibleCount && <button className="card-reading-back graph-overview__more" onClick={() => setVisibleCount(count => count + 24)}>显示更多分类</button>}
  </section>;
}

function colorOf(type: string, colors: Record<string, string>, index: number) { return colors[type] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]; }
