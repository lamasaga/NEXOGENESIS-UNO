import { useEffect, useMemo, useRef, useState } from 'react';
import './PromptInspector.css';

export interface PromptSummary {
  id: string; created_at: string; stage: string; title: string; provider: string; model: string;
  status: string; chars: number; capture: 'runtime' | 'wire'; session_id?: string; job_id?: string;
  route?: string; batch?: number; elapsed_ms?: number; usage?: Record<string, number>;
}
export interface PromptOutputData { version: number; blocks: Array<{index:number;type:'text';text:string}|{index:number;type:'tool-call';id:string;name:string;arguments:string}> }
export interface PromptRecord extends PromptSummary {
  output?: PromptOutputData; output_chars?: number;
  input: unknown; omissions: string[]; sections: Array<{label: string; location: string; chars: number; content: string}>;
  context_governance?: {
    version: string | number; before_bytes: number; after_bytes: number; saved_bytes: number;
    removed_progress: number; compacted_failed_calls: number; deduplicated_results: number;
    input_limit_bytes: number; estimated_input_tokens: number; token_estimate: boolean;
  };
}
const states: Record<string, string> = { running: '请求中', completed: '已返回', truncated: '达到输出上限', failed: '失败', cancelled: '已取消', incomplete: '未完整结束', interrupted: '上次服务已中断' };
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store' });
  if (response.status === 404 && path === '/api/prompt-inspector') throw new Error('当前后台尚未加载提示词记录功能，请启动更新后的 UNO。此前未记录的请求无法补回。');
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? '请求记录暂不可用，请重试。');
  return response.json();
}
function exportRecord(record: PromptRecord) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `uno-prompt-${record.id}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Section({ section }: {section: PromptRecord['sections'][number]}) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{section.label}<small>{section.location} · {section.chars.toLocaleString()} 字符</small></summary>{open && <pre>{section.content}</pre>}</details>;
}
export function PromptOutput({record}:{record:PromptRecord}) {
  if(!record.output)return <p role="status">这条历史记录未保存模型返回内容，不能据此判断模型是否返回了空内容。</p>;
  return <section aria-label="模型返回内容">
    <p className="prompt-inspector__note">本次请求实际收到的可见返回，保留原始文本；不含模型内部思考。调用状态不代表卡片已通过检查或已经保存。</p>
    {record.status==='running'&&<p role="status">正在返回，点击“刷新记录”查看已接收内容。</p>}
    {['failed','cancelled','incomplete','interrupted','truncated'].includes(record.status)&&<p role="status">本次请求未完整完成，下方仅展示已接收到的部分。</p>}
    {!record.output.blocks.length&&<p>尚未记录到可见返回正文或工具调用。</p>}
    {record.output.blocks.map(block=>block.type==='text'?<pre key={'text-'+block.index}>{block.text}</pre>:<div key={'tool-'+block.index}><h4>工具调用 · {block.name||'名称尚未完整返回'}</h4><p className="prompt-inspector__note">{block.id}</p><pre>{block.arguments}</pre></div>)}
  </section>;
}
export function PromptContent({ record }: {record: PromptRecord}) {
  const [view, setView] = useState<'sections' | 'input' | 'output'>('sections');
  const [query, setQuery] = useState('');
  const sections = useMemo(() => record.sections.filter(section => !query || (section.label + section.content).toLocaleLowerCase().includes(query.toLocaleLowerCase())), [record.sections, query]);
  return <>
    <header className="prompt-inspector__record-heading"><div><h3>{record.stage}</h3><p>{record.title || '模型请求'}{record.batch ? ` · 第 ${record.batch} 批` : ''}</p></div><button onClick={() => exportRecord(record)}>导出 JSON</button></header>
    <div className="prompt-inspector__metrics"><span>{record.provider} / {record.model}</span><span>{states[record.status] ?? record.status}</span><span>输入 {record.chars.toLocaleString()} 展示字符</span>{record.output_chars!==undefined&&<span>返回 {record.output_chars.toLocaleString()} 字符</span>}{record.elapsed_ms !== undefined && <span>{(record.elapsed_ms / 1000).toFixed(1)} 秒</span>}{record.route && <span>检索路线：{record.route}</span>}</div>
    <p className="prompt-inspector__note">{record.capture === 'wire' ? '记录位置：发送给供应商前的请求正文。分段顺序与 messages 一致，工具定义单独提交。' : '记录位置：运行时交给适配器的完整输入。SDK 可能转换格式或内部重试，此处不是 HTTP 原始报文，内部重试不单独计数。'}</p>
    {!!record.omissions.length && <p className="prompt-inspector__note">明确省略：{record.omissions.join('；')}。其余文本按实际输入保留。</p>}
    {record.context_governance && <section className="prompt-inspector__governance" aria-label="请求上下文治理">
      <strong>本次上下文治理</strong>
      <p>治理前 {record.context_governance.before_bytes.toLocaleString()} 字节 → 治理后 {record.context_governance.after_bytes.toLocaleString()} 字节，减少 {record.context_governance.saved_bytes.toLocaleString()} 字节。</p>
      <p>移除旧进度 {record.context_governance.removed_progress.toLocaleString()} 份 · 精简旧失败参数 {record.context_governance.compacted_failed_calls.toLocaleString()} 次 · 去重工具结果 {record.context_governance.deduplicated_results.toLocaleString()} 份</p>
      <p className="prompt-inspector__note">完整输入上限 {record.context_governance.input_limit_bytes.toLocaleString()} 字节；输入 Token 估算 {record.context_governance.estimated_input_tokens.toLocaleString()}。UTF-8 字节统计与“展示字符”口径不同，也不代表供应商 Token 或账单用量。下方快照继续遵守上述省略规则。</p>
    </section>}
    {record.status === 'truncated' && <p role="status">本次输出被额度截断，不能视为回答完成。{record.usage?.reasoningTokens !== undefined && `供应商报告思考 ${record.usage.reasoningTokens.toLocaleString()} tokens，包含在输出总量中。`}</p>}
    <div className="prompt-inspector__views" aria-label="请求查看方式"><button aria-pressed={view === 'sections'} onClick={() => setView('sections')}>拼接顺序与内容</button><button aria-pressed={view === 'input'} onClick={() => setView('input')}>实际输入 JSON</button><button aria-pressed={view === 'output'} onClick={() => setView('output')}>模型返回内容</button></div>
    {view === 'sections' ? <><label className="prompt-inspector__search">查找内容<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="查找规则、材料、工具或问题"/></label><p className="prompt-inspector__note">{sections.length} / {record.sections.length} 个片段 · 展开查看完整内容。分段名称是查看说明，不会额外发送给模型。</p>{sections.map(section => <Section key={record.id + section.location} section={section}/>)}{!sections.length && <p role="status">没有匹配的片段。</p>}</> : view === 'input' ? <pre>{JSON.stringify(record.input, null, 2)}</pre> : <PromptOutput record={record}/>}
    {record.usage && <details><summary>供应商报告的用量</summary><pre>{JSON.stringify(record.usage, null, 2)}</pre></details>}
    <footer className="prompt-inspector__note">请求 {record.id}{record.session_id && <><br/>会话 {record.session_id}</>}{record.job_id && <><br/>任务 {record.job_id}</>}</footer>
  </>;
}

export function PromptInspector({ libraryName, onClose }: {libraryName: string; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<PromptSummary[]>([]), [selected, setSelected] = useState('');
  const [record, setRecord] = useState<PromptRecord | null>(null), [error, setError] = useState(''), [detailError, setDetailError] = useState('');
  const [warning, setWarning] = useState(''), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void read<{items: PromptSummary[]; warning: string}>('/api/prompt-inspector', AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])).then(data => {
      if (controller.signal.aborted) return; setItems(data.items); setWarning(data.warning); setSelected(current => data.items.some(item => item.id === current) ? current : data.items[0]?.id ?? '');
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController(); setRecord(null); setDetailError(''); if (!selected) return;
    void read<PromptRecord>('/api/prompt-inspector/' + encodeURIComponent(selected), AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])).then(data => { if (!controller.signal.aborted) setRecord(data); }).catch(error => { if (!controller.signal.aborted) setDetailError(error.message); });
    return () => controller.abort();
  }, [selected, refresh]);
  return <dialog ref={dialog} className="prompt-inspector" aria-labelledby="prompt-inspector-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="prompt-inspector__shell">
      <header className="prompt-inspector__heading"><div><h2 id="prompt-inspector-title">提示词 · 最近 60 次请求</h2><p>{libraryName} · 按请求时间倒序，包含失败请求与运行时重试。记录保存在本机，刷新页面后仍可查看。</p></div><div><button onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新记录</button><button onClick={onClose} autoFocus aria-label="关闭提示词查看器">关闭</button></div></header>
      <p className="prompt-inspector__privacy">记录本次输入与可见返回，不含连接密钥、请求头或模型内部思考。旧记录可能没有返回内容；浏览记录不会调用模型。</p>
      {error && <p role="alert">{error}</p>}{warning && <p role="status">{warning}</p>}
      <div className="prompt-inspector__body"><nav aria-label="最近模型请求" className="prompt-inspector__list">{loading && <p role="status">正在读取记录…</p>}{!loading && !error && !items.length && <p>还没有请求记录。下一次对话、编译或建构调用模型后会出现在这里。</p>}{items.map(item => <button key={item.id} aria-current={selected === item.id ? 'true' : undefined} onClick={() => setSelected(item.id)}><strong>{item.stage}</strong><span>{item.title || item.model}</span><small>{new Date(item.created_at).toLocaleString('zh-CN', { hour12: false })} · {states[item.status] ?? item.status}</small></button>)}</nav>
        <article className="prompt-inspector__detail" aria-label="请求详情">{detailError ? <p role="alert">{detailError}</p> : record ? <PromptContent key={record.id} record={record}/> : selected ? <p role="status">正在读取完整输入…</p> : <p className="prompt-inspector__note">选择一次请求，查看输入的组成、实际返回内容与调用状态。</p>}</article>
      </div>
    </div>
  </dialog>;
}
