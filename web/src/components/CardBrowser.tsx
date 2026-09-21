import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  deleteUnoUnassignedCard, fetchCard, fetchCardCatalog, fetchUnoUnassignedPool, organizeUnoUnassignedCard, recompileUnoUnassignedCard,fetchUnoRepair,
  type CardCatalogResponse, type CardCatalogQuery, type CardDetail, type UnoUnassignedPool,type UnoRepairDetail,
} from "../api/client";
import { cardVisualKind } from "../graph/cardVisuals";
import { CardMarkdown, CardRelations, type ViewedCard } from "./CardReader";
import { DomainContent, DomainRelations } from './DomainContent';
import { cardTypeLabel, readableCardExcerpt } from "./cardReading";
import {CompileRepairPanel} from './CompileRepairPanel';
import {UnassignedDomainCreator} from './UnassignedDomainCreator';
import {queueProgress,type UnoUnassignedQueueMode,type UnoUnassignedQueueState,type UnoUnassignedQueueTarget} from '../uno/unassignedQueue';

interface Props {
  onClose: () => void;
  onViewed?: (card: ViewedCard) => void;
  onToggleFavorite?: (card: ViewedCard) => void;
  isFavorite?: (cardId: string) => boolean;
  onOpenFloating?: (cardId: string) => void;
  onOpenJob?: (jobId: string,mode?:'compile'|'construct') => void;
  initialPoolMode?:boolean;
  unassignedQueue?:UnoUnassignedQueueState|null;
  onStartUnassignedQueue?:(mode:UnoUnassignedQueueMode,targets:UnoUnassignedQueueTarget[],libraryId:string)=>void;
  onStopUnassignedQueue?:()=>void;
  onResumeUnassignedQueue?:()=>void;
  onDeferUnassignedQueueItem?:()=>void;
  onClearUnassignedQueue?:()=>void;
}

const EMPTY_CATALOG: CardCatalogResponse = {
  items: [], total: 0, all_total: 0,
  facets: { types: [], domains: [], relations: [] },
};
const RESULT_BATCH_SIZE = 120;

export function CardBrowser({ onClose, onViewed, onToggleFavorite, isFavorite, onOpenFloating, onOpenJob,initialPoolMode=false,
  unassignedQueue,onStartUnassignedQueue,onStopUnassignedQueue,onResumeUnassignedQueue,onDeferUnassignedQueueItem,onClearUnassignedQueue }: Props) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [domain, setDomain] = useState("");
  const [type,setType]=useState("");
  const [relation, setRelation] = useState("");
  const [sort, setSort] = useState<NonNullable<CardCatalogQuery["sort"]>>("relevance");
  const [catalog, setCatalog] = useState<CardCatalogResponse>(EMPTY_CATALOG);
  const [visibleCount, setVisibleCount] = useState(RESULT_BATCH_SIZE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [card, setCard] = useState<CardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [poolMode,setPoolMode]=useState(initialPoolMode);
  const [pool,setPool]=useState<UnoUnassignedPool|null>(null);
  const [poolLoading,setPoolLoading]=useState(true);
  const [repairDetail,setRepairDetail]=useState<UnoRepairDetail|null>(null);
  const [managementBusy,setManagementBusy]=useState(false);
  const [managementNotice,setManagementNotice]=useState<string|null>(null);
  const [deleteConfirm,setDeleteConfirm]=useState<string|null>(null);
  const [deleteText,setDeleteText]=useState('');
  const [domainCreator,setDomainCreator]=useState(false);
  const [queueSetup,setQueueSetup]=useState(false);
  const [queueMode,setQueueMode]=useState<UnoUnassignedQueueMode>('recompile');
  const [queueLimitText,setQueueLimitText]=useState('10');
  const readerRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(()=>{
    const controller=new AbortController();
    setPoolLoading(true);
    fetchUnoUnassignedPool(controller.signal).then(setPool).catch(reason=>{if(!controller.signal.aborted)setManagementNotice('未组织池读取失败：'+String(reason));}).finally(()=>{if(!controller.signal.aborted)setPoolLoading(false);});
    return()=>controller.abort();
  },[]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab") {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, summary, a[href], [tabindex="0"]') ?? []).filter((item) => item.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if(poolMode){setLoading(false);return;}
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      fetchCardCatalog({ query: deferredQuery, type, domain, relation, sort }, controller.signal)
        .then((result) => {
          if(controller.signal.aborted)return;
          setCatalog(result);
          setVisibleCount(RESULT_BATCH_SIZE);
          setHistory([]);
          setSelectedId((current) => result.items.some((item) => item.id === current)
            ? current : (result.items[0]?.id ?? null));
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(String(reason));
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 140);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [deferredQuery, type, domain, relation, sort,poolMode]);

  useEffect(() => {
    if (!selectedId) {
      setCard(null);
      setRepairDetail(null);
      return;
    }
    let active = true;
    setCard(null);
    setRepairDetail(null);
    setReaderError(null);
    readerRef.current?.scrollTo({ top: 0 });
    if(poolMode&&pool?.items.some(item=>item.id===selectedId&&item.kind==='repair')){
      const controller=new AbortController();
      fetchUnoRepair(selectedId,controller.signal).then(detail=>{if(active)setRepairDetail(detail);}).catch(reason=>{if(active)setReaderError(String(reason));});
      return()=>{active=false;controller.abort();};
    }
    fetchCard(selectedId).then((detail) => {
      if (!active) return;
      setCard(detail);
      onViewed?.(detail);
    }).catch((reason) => {
      if (active) setReaderError(String(reason));
    });
    return () => { active = false; };
  }, [selectedId, onViewed,poolMode,pool]);

  const poolQuery=deferredQuery.trim().toLocaleLowerCase('zh-CN');
  const poolItems=(pool?.items??[]).filter(item=>!poolQuery||[item.id,item.title,item.summary,item.reason,item.type].join(' ').toLocaleLowerCase('zh-CN').includes(poolQuery));
  const queueTargets:UnoUnassignedQueueTarget[]=poolItems.map(item=>({id:item.id,kind:item.kind==='repair'?'repair':'unassigned',revision:item.revision}));
  const unassignedItems=queueTargets.filter(item=>item.kind==='unassigned').length;
  const isolatedItems=queueTargets.length-unassignedItems;
  const queueMaximum=Math.min(50,queueTargets.length);
  const queueLimit=Math.min(Math.max(1,Number.parseInt(queueLimitText,10)||1),Math.max(1,queueMaximum));
  const activeQueue=unassignedQueue&&unassignedQueue.libraryId===pool?.library.id?unassignedQueue:null;
  const progress=activeQueue?queueProgress(activeQueue):null;
  const listedItems=(poolMode?poolItems.map(item=>({id:item.id,title:item.title,type:item.type,maturity:item.kind==='repair'?'待修复':'待组织',domains:[],domain_titles:{} as Record<string,string>,updated:item.updated,excerpt:item.excerpt,relation_count:item.inbound_relation_count+item.outbound_relation_count,source_count:item.sources.length})):catalog.items);
  const visibleItems = listedItems.slice(0, visibleCount);
  const managedCard=pool?.items.find(item=>item.id===card?.id)??null;
  useEffect(()=>{
    if(!queueMaximum)return;
    setQueueLimitText(current=>String(Math.min(Math.max(1,Number.parseInt(current,10)||1),queueMaximum)));
  },[queueMaximum]);
  useEffect(()=>{
    if(!poolMode||selectedId||!(pool?.items.length))return;
    setSelectedId(pool.items[0].id);
  },[poolMode,pool,selectedId]);
  useEffect(()=>{
    setManagementNotice(null);
    setDeleteConfirm(null);
    setDeleteText('');
    setDomainCreator(false);
  },[selectedId]);
  useEffect(()=>{
    if(!poolMode||!activeQueue?.results.length)return;
    const controller=new AbortController();
    fetchUnoUnassignedPool(controller.signal).then(next=>{setPool(next);if(!next.items.some(item=>item.id===selectedId))setSelectedId(next.items[0]?.id??null);}).catch(()=>{});
    return()=>controller.abort();
  },[poolMode,activeQueue?.results.length,selectedId]);
  const openPool=()=>{
    setPoolMode(true);setDomain('');setType('');setRelation('');setHistory([]);setVisibleCount(RESULT_BATCH_SIZE);setManagementNotice(null);
    setSelectedId(pool?.items[0]?.id??null);setReading(false);
  };
  const closePool=()=>{setPoolMode(false);setSelectedId(catalog.items[0]?.id??null);setDeleteConfirm(null);setDeleteText('');setManagementNotice(null);};
  const refreshPool=async()=>{const next=await fetchUnoUnassignedPool();setPool(next);if(poolMode&&!next.items.some(item=>item.id===selectedId))setSelectedId(next.items[0]?.id??null);return next;};
  const navigate = (id: string) => {
    if (selectedId) setHistory((items) => [...items, selectedId]);
    setSelectedId(id); setReading(true);
  };

  const layer = <div className="card-browser-overlay" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialogRef} className={`card-browser${reading ? " is-reading" : ""}`} role="dialog" aria-modal="true" aria-labelledby="card-browser-title">
      <header className="card-browser__header">
        <div>
          <h2 id="card-browser-title">{poolMode?'未组织池':'知识卡片'} <span className="card-browser__total">{poolMode?(poolLoading?'…':(pool?.items.length??0).toLocaleString('zh-CN')):catalog.all_total.toLocaleString("zh-CN")}</span></h2>
          <p>阅读、发现与连接</p>
        </div>
        <label className="card-browser__search">
          <SearchIcon />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、正文与关系" aria-label="搜索知识卡片" />
          {query && <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}>✕</button>}
        </label>
        <button type="button" className="card-browser__close" aria-label="关闭知识卡片浏览器" onClick={onClose}>✕</button>
      </header>

      <div className="card-browser__tools">
        <div className="card-browser__filters" aria-label="知识卡片筛选与排序">
          <button type="button" className={`card-browser__pool-toggle${poolMode?' is-active':''}`} aria-pressed={poolMode} onClick={poolMode?closePool:openPool}>未组织池 · {pool?.items.length??'…'}</button>
          {!poolMode&&<><FilterSelect label="主类型" value={type} onChange={setType} empty="全部类型" options={catalog.facets.types.map(item=>({value:item.value,label:item.label+" · "+item.count}))}/>
          <FilterSelect label="领域" value={domain} onChange={setDomain} empty="全部领域"
            options={catalog.facets.domains.map((item) => ({ value: item.value, label: `${item.label} · ${item.count}` }))} />
          <FilterSelect label="关系" value={relation} onChange={setRelation} empty="全部关系"
            options={catalog.facets.relations.map((item) => ({ value: item.value, label: `${item.label} · ${item.count}` }))} />
          {(type || domain || relation) && <button className="card-reading-back" onClick={() => { setType(""); setDomain(""); setRelation(""); }}>重置筛选</button>}
          </>}
          <span className="card-browser__count" role="status">{poolMode?(poolLoading?'正在读取…':`${poolItems.length.toLocaleString('zh-CN')} 项待处理`):loading ? "搜索中…" : `${catalog.total.toLocaleString("zh-CN")} 张卡片`}</span>
          {poolMode&&!activeQueue&&onStartUnassignedQueue&&<button type="button" className="card-browser__queue-trigger" onClick={()=>setQueueSetup(open=>!open)} aria-expanded={queueSetup}>{queueSetup?'收起设置':'连续处理'}</button>}
          {!poolMode&&<FilterSelect label="排序" value={sort} onChange={(value) => setSort(value as NonNullable<CardCatalogQuery["sort"]>)} empty=""
            options={[
              { value: "relevance", label: query.trim() ? "相关程度" : "默认排序" },
              { value: "updated", label: "最近更新" },
              { value: "title", label: "标题顺序" },
              { value: "relations", label: "关系数量" },
            ]} />}
        </div>
        {poolMode&&activeQueue&&progress&&<section className={`card-browser__queue card-browser__queue--${activeQueue.status}`} aria-label="连续处理队列" role="status">
          <div><strong>{activeQueue.mode==='recompile'?'逐项完整处理':'逐项轻量处理'} · {progress.completed} / {progress.total}</strong><p>{activeQueue.message}</p>{progress.attention>0&&<small>{progress.attention} 项仍需人工判断；其他项目继续独立处理。</small>}</div>
          <div className="card-browser__queue-actions">
            {activeQueue.currentJobId&&<button type="button" onClick={()=>onOpenJob?.(activeQueue.currentJobId!,activeQueue.targets[activeQueue.index]?.kind==='repair'?'compile':'construct')}>查看当前任务</button>}
            {activeQueue.status==='running'&&<button type="button" onClick={onStopUnassignedQueue}>当前项完成后停止</button>}
            {activeQueue.status==='stopping'&&<button type="button" disabled>将在当前项后停止</button>}
            {activeQueue.status==='paused'&&progress.remaining>0&&!activeQueue.currentJobId&&<button type="button" onClick={onResumeUnassignedQueue}>重新连接并继续</button>}
            {activeQueue.status==='paused'&&progress.remaining>0&&activeQueue.currentJobId&&onDeferUnassignedQueueItem&&<button type="button" onClick={onDeferUnassignedQueueItem}>保留此项，继续下一项</button>}
            {!['running','stopping'].includes(activeQueue.status)&&<button type="button" onClick={onClearUnassignedQueue}>清除队列记录</button>}
          </div>
        </section>}
        {poolMode&&!activeQueue&&onStartUnassignedQueue&&queueSetup&&<section className="card-browser__queue-setup" aria-label="设置连续处理队列">
          <div className="card-browser__queue-intro"><strong>一项一项自动处理</strong><p>当前筛选含 {unassignedItems} 张正式空领域卡、{isolatedItems} 项隔离候选。每项仍创建独立任务，结算后才启动下一项。</p></div>
          <div className="card-browser__queue-modes">
            <label><input type="radio" name="queue-mode" checked={queueMode==='recompile'} onChange={()=>setQueueMode('recompile')}/><span><strong>完整处理</strong><small>正式卡重编译正文并整理领域；隔离候选按原问题修复。</small></span></label>
            <label><input type="radio" name="queue-mode" checked={queueMode==='organize'} onChange={()=>setQueueMode('organize')}/><span><strong>轻量处理</strong><small>正式卡只整理领域；隔离候选仍按原问题修复。</small></span></label>
          </div>
          <div className="card-browser__queue-footer">
            <label className="card-browser__queue-limit"><span>处理数量</span><span className="card-browser__stepper"><button type="button" aria-label="减少处理数量" disabled={queueLimit<=1} onClick={()=>setQueueLimitText(String(Math.max(1,queueLimit-1)))}>−</button><input type="number" inputMode="numeric" min={1} max={Math.max(1,queueMaximum)} value={queueLimitText} onChange={event=>{const value=event.target.value;if(value===''||/^\d+$/.test(value))setQueueLimitText(value);}} onBlur={()=>setQueueLimitText(String(queueLimit))} aria-label="连续处理数量"/><button type="button" aria-label="增加处理数量" disabled={queueLimit>=queueMaximum} onClick={()=>setQueueLimitText(String(Math.min(queueMaximum,queueLimit+1)))}>＋</button></span><small>最多 {queueMaximum} 项</small></label>
            <div className="card-browser__queue-actions"><button type="button" onClick={()=>setQueueSetup(false)}>取消</button><button type="button" className="is-primary" disabled={!queueTargets.length} onClick={()=>{onStartUnassignedQueue(queueMode,queueTargets.slice(0,queueLimit),pool!.library.id);setQueueSetup(false);}}>开始处理前 {Math.min(queueLimit,queueTargets.length)} 项</button></div>
          </div>
        </section>}
      </div>

      <div className="card-browser__workspace">
        <aside className="card-browser__results" aria-label="知识卡片搜索结果">
          <div className="card-browser__result-head">
            <span>{poolMode?'未组织池':query || type || domain || relation ? "筛选结果" : "全部卡片"}</span>
            {!poolMode&&catalog.total !== catalog.all_total && <small>全库 {catalog.all_total.toLocaleString("zh-CN")}</small>}
          </div>
          <div className="card-browser__list" aria-busy={loading||poolLoading}>
            {poolMode&&poolLoading&&<BrowserStatus>正在读取未组织池…</BrowserStatus>}
            {!poolMode&&loading && catalog.items.length === 0 && <BrowserStatus>正在整理知识卡片…</BrowserStatus>}
            {!loading && error && <BrowserStatus tone="warning">列表读取失败：{error}</BrowserStatus>}
            {!loading && !poolLoading && !error && listedItems.length === 0 && <BrowserStatus>{poolMode?'未组织池中没有匹配卡片。':'没有找到匹配的知识卡片。可以减少筛选条件或换一个关键词。'}</BrowserStatus>}
            {visibleItems.map((item) => <button key={item.id} type="button"
              className={`card-browser__row${item.id === selectedId ? " is-selected" : ""}`}
              aria-pressed={item.id === selectedId} onClick={() => { setSelectedId(item.id); setHistory([]); setReading(true); }}>
              <span className={`card-browser__row-mark card-browser__row-mark--${cardVisualKind(item.type)}`} aria-hidden />
              <span className="card-browser__row-main">
                <strong>{item.title}</strong>
                <small>{cardTypeLabel(item)}{item.maturity==='待修复'?' · 待修复候选':item.domains[0] ? ` · ${item.domain_titles[item.domains[0]] ?? item.domains[0]}` : " · 待组织领域"}</small>
                <span>{readableCardExcerpt(item.excerpt)}</span>
                <em>关系 {item.relation_count} · 来源 {item.source_count}{item.updated ? ` · 更新 ${item.updated}` : ""}</em>
              </span>
            </button>)}
            {visibleCount < listedItems.length && <button type="button" className="card-browser__more"
              onClick={() => setVisibleCount((count) => Math.min(count + RESULT_BATCH_SIZE, listedItems.length))}>
              再显示 {Math.min(RESULT_BATCH_SIZE, listedItems.length - visibleCount)} 张
            </button>}
          </div>
        </aside>

        <article ref={readerRef} className="card-browser__reader" aria-label="知识卡片正文">
          <div className="card-browser__reader-nav">
            <button className="card-reading-back card-browser__back-list" onClick={() => setReading(false)}>← 卡片列表</button>
            {history.length > 0 && <button className="card-reading-back" onClick={() => { setSelectedId(history.at(-1)!); setHistory((items) => items.slice(0, -1)); }}>← 返回上一张卡片</button>}
            {card && onOpenFloating && <button className="card-reading-back card-browser__float" onClick={() => onOpenFloating(card.id)}>↗ 浮窗阅读</button>}
          </div>
          {!selectedId && <BrowserStatus>从左侧选择一张知识卡片开始阅读。</BrowserStatus>}
          {readerError && <BrowserStatus tone="warning">{readerError}</BrowserStatus>}
          {selectedId && !card && !repairDetail && !readerError && <BrowserStatus>正在读取卡片正文…</BrowserStatus>}
          {repairDetail&&pool&&<CompileRepairPanel key={repairDetail.id} item={repairDetail} libraryId={pool.library.id} onOpenJob={onOpenJob} onRefresh={refreshPool} onLater={()=>setReading(false)}/>}
            {card && <>
            <header className="card-browser__reader-head">
              <div>
                <div className="card-browser__reader-meta">
                  <span>{card.maturity}</span>
                  {card.updated && <span>更新 {card.updated}</span>}
                </div>
                <h3>{card.title}</h3>
              </div>
              {onToggleFavorite && <button type="button" className={`card-browser__favorite${isFavorite?.(card.id) ? " is-active" : ""}`}
                aria-label={isFavorite?.(card.id) ? "取消收藏" : "收藏此卡片"} aria-pressed={isFavorite?.(card.id) ?? false}
                onClick={() => onToggleFavorite(card)}>{isFavorite?.(card.id) ? "★" : "☆"}</button>}
            </header>

            {poolMode&&managedCard&&<section className="card-browser__management" aria-label="未组织卡片操作">
              <div><strong>未组织原因</strong><p>{managedCard.reason}</p><small>入边 {managedCard.inbound_relation_count} · 出边 {managedCard.outbound_relation_count} · 来源 {managedCard.sources.length}</small></div>
              {managementNotice&&<p role="status" className="card-browser__management-notice">{managementNotice}</p>}
              <div className="card-browser__management-actions">
                <button type="button" disabled={managementBusy||Boolean(activeQueue&&['running','stopping'].includes(activeQueue.status))} onClick={()=>{setManagementBusy(true);setManagementNotice(null);void organizeUnoUnassignedCard(managedCard.id,pool!.library.id).then(job=>{setManagementNotice('单卡领域整理任务已开始，不会重写正文。');onOpenJob?.(job.id,job.mode);}).catch(reason=>setManagementNotice(String(reason))).finally(()=>setManagementBusy(false));}}>只整理领域</button>
                <button type="button" disabled={managementBusy||Boolean(activeQueue&&['running','stopping'].includes(activeQueue.status))} onClick={()=>{setManagementBusy(true);setManagementNotice(null);void recompileUnoUnassignedCard(managedCard.id,pool!.library.id).then(job=>{setManagementNotice('单卡重编译、审核与领域整理任务已开始。');onOpenJob?.(job.id,job.mode);}).catch(reason=>setManagementNotice(String(reason))).finally(()=>setManagementBusy(false));}}>重编译正文并整理领域</button>
                {pool?.capabilities?.manual_seed_domain&&<button type="button" disabled={managementBusy||Boolean(activeQueue&&['running','stopping'].includes(activeQueue.status))} onClick={()=>{setDomainCreator(open=>!open);setDeleteConfirm(null);setManagementNotice(null);}}>以此卡发起新领域</button>}
                <button type="button" className="is-danger" disabled={managementBusy} onClick={()=>{setDomainCreator(false);setDeleteConfirm(managedCard.id);setDeleteText('');}}>删除卡片</button>
              </div>
              {domainCreator&&<UnassignedDomainCreator card={managedCard} libraryId={pool!.library.id} onCancel={()=>setDomainCreator(false)} onCreated={async receipt=>{setDomainCreator(false);setManagementNotice(receipt.summary);const next=await refreshPool();setCard(null);setSelectedId(next.items[0]?.id??null);setReading(false);}}/>}
              {deleteConfirm===managedCard.id&&<div className="card-browser__delete-confirm" role="alertdialog" aria-label="确认删除卡片">
                <strong>删除后卡片会立即离开知识体</strong><p>系统同时清理指向它的关系。原始 Markdown 保存在删除归档中，可人工恢复。请输入卡片 ID 确认：</p>
                <code>{managedCard.id}</code><input value={deleteText} onChange={event=>setDeleteText(event.target.value)} aria-label="输入卡片 ID 确认删除"/>
                <div><button type="button" onClick={()=>{setDeleteConfirm(null);setDeleteText('');}}>取消</button><button type="button" className="is-danger" disabled={managementBusy||deleteText!==managedCard.id} onClick={()=>{setManagementBusy(true);setManagementNotice(null);void deleteUnoUnassignedCard(managedCard,pool!.library.id).then(async()=>{const next=await refreshPool();setDeleteConfirm(null);setDeleteText('');setCard(null);setSelectedId(next.items[0]?.id??null);}).catch(reason=>setManagementNotice(String(reason))).finally(()=>setManagementBusy(false));}}>确认删除</button></div>
              </div>}
            </section>}

            <div className="card-browser__domains" aria-label="主类型"><span>主类型</span><button type="button" onClick={()=>{setType(card.type);setReading(false);}}>{cardTypeLabel(card)}</button></div>
            {card.domains.length > 0 && <div className="card-browser__domains" aria-label="所属领域">
              <span>领域</span>
              {card.domains.map((id) => <button type="button" key={id} onClick={() => setDomain(id)}>{card.domain_titles?.[id] ?? id}</button>)}
            </div>}

            {!card.domain_content && <CardRelations relations={card.relations} onNavigate={navigate} />}
            {card.domain_content && <>
              {card.summary && <p>{card.summary}</p>}
              <DomainContent content={card.domain_content} onNavigate={navigate} />
            </>}

            <div className="card-browser__body"><CardMarkdown body={card.body} /></div>
            {card.domain_content && <DomainRelations relations={card.relations ?? []} onNavigate={navigate} />}
          </>}
        </article>
      </div>
    </section>
  </div>;

  return typeof document === "undefined" ? layer : createPortal(layer, document.body);
}

function FilterSelect({ label, value, onChange, empty, options }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  empty: string;
  options: Array<{ value: string; label: string }>;
}) {
  return <label className="card-browser__select" title={label}>
    <span className="sr-only">{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
      {empty && <option value="">{empty}</option>}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function BrowserStatus({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "warning" }) {
  return <div className={`card-browser__status card-browser__status--${tone}`} role="status">{children}</div>;
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden><circle cx="8.5" cy="8.5" r="5.25" /><path d="m12.4 12.4 4 4" /></svg>;
}
