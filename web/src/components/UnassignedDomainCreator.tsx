import { useRef, useState } from 'react';
import { createUnoDomainFromCard, type UnoDomainCreationReceipt, type UnoUnassignedCard } from '../api/client';

interface Props {
  card: UnoUnassignedCard;
  libraryId: string;
  onCancel: () => void;
  onCreated: (receipt: UnoDomainCreationReceipt) => Promise<void> | void;
}

const lines = (value: string) => [...new Set(value.split(/\r?\n/).map(row => row.trim()).filter(Boolean))];

export function UnassignedDomainCreator({ card, libraryId, onCancel, onCreated }: Props) {
  const [title,setTitle]=useState('');
  const [summary,setSummary]=useState('');
  const [questions,setQuestions]=useState('');
  const [includes,setIncludes]=useState('');
  const [excludes,setExcludes]=useState('');
  const [domainId,setDomainId]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const requestId=useRef(globalThis.crypto.randomUUID());
  const valid=Boolean(title.trim()&&summary.trim()&&lines(questions).length&&lines(includes).length&&lines(excludes).length&&(!domainId.trim()||/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(domainId.trim())));

  return <form className="card-browser__domain-creator" aria-label="以当前卡片创建领域" onSubmit={event=>{
    event.preventDefault();if(!valid||busy)return;setBusy(true);setError('');
    void createUnoDomainFromCard(card,libraryId,{...(domainId.trim()?{id:domainId.trim()}:{}),title:title.trim(),summary:summary.trim(),core_questions:lines(questions),includes:lines(includes),excludes:lines(excludes)},requestId.current)
      .then(onCreated).catch(reason=>setError(String(reason))).finally(()=>setBusy(false));
  }}>
    <div className="card-browser__domain-creator-head"><div><strong>以此卡发起新领域</strong><p>当前卡会成为首个成员。领域应描述可持续容纳多张卡片的问题空间，而不是复用这张卡的标题。</p></div><button type="button" onClick={onCancel} aria-label="关闭新建领域">✕</button></div>
    <div className="card-browser__domain-fields">
      <label>领域名称<input autoFocus maxLength={100} value={title} onChange={event=>setTitle(event.target.value)} placeholder="例如：土地制度与国家治理"/></label>
      <label>领域摘要<textarea rows={2} maxLength={1000} value={summary} onChange={event=>setSummary(event.target.value)} placeholder="说明这个领域长期研究什么问题"/></label>
      <label>核心问题<textarea rows={2} value={questions} onChange={event=>setQuestions(event.target.value)} placeholder={'每行一个问题\n例如：土地收益如何影响国家治理？'}/></label>
      <label>纳入边界<textarea rows={2} value={includes} onChange={event=>setIncludes(event.target.value)} placeholder={'每行一项\n例如：土地制度、财政分配与基层治理'}/></label>
      <label>排除边界<textarea rows={2} value={excludes} onChange={event=>setExcludes(event.target.value)} placeholder={'每行一项\n例如：仅按朝代罗列的事件'}/></label>
    </div>
    <details><summary>高级设置</summary><label>领域 ID（可选）<input value={domainId} maxLength={100} onChange={event=>setDomainId(event.target.value)} placeholder="留空时自动生成稳定 ID"/><small>只允许英文字母、数字、连字符和下划线。</small></label></details>
    {error&&<p className="card-browser__management-notice" role="alert">{error}</p>}
    <div className="card-browser__queue-actions"><button type="button" onClick={onCancel}>取消</button><button type="submit" className="is-primary" disabled={!valid||busy}>{busy?'正在创建…':'创建领域并挂靠此卡'}</button></div>
  </form>;
}
