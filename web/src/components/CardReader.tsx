import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DotsSixVertical, PencilSimple, Star, X, ArrowCounterClockwise } from '@phosphor-icons/react';
import { CardWriting } from './CardWriting';
import { BOOK_UNIT_REF, isBookResource, isBookMaterialPath } from '../../../packages/nexogenesis-tools/lib/uno/book-paths.js';
import { fetchCard, type CardDetail, type CardRelation } from "../api/client";
import { DomainContent, DomainRelations } from './DomainContent';
import { cardVisualKind } from "../graph/cardVisuals";
import { cardTypeLabel, fitReaderFrame, initialReaderFrame, readableCardBody, type ReaderFrame } from "./cardReading";

export type ViewedCard = Pick<CardDetail, "id" | "title" | "type" | "domains" | "updated">;
interface Props {
  cardIds: string[];
  onClose: (cardId: string) => void;
  onViewed?: (card: ViewedCard) => void;
  onToggleFavorite?: (card: ViewedCard) => void;
  isFavorite?: (cardId: string) => boolean;
}

export function CardReader({ cardIds, onClose, ...props }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = cardIds.includes(activeId ?? "") ? activeId : cardIds.at(-1);
  useEffect(() => { setActiveId(cardIds.at(-1) ?? null); }, [cardIds]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && active && !document.querySelector('[aria-modal="true"]')) onClose(active);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose]);
  if (!cardIds.length) return null;
  const layer = <div className="card-reader-layer" aria-label="正在阅读的知识卡片">
    {cardIds.map((cardId, index) => <CardReaderPanel key={cardId} cardId={cardId} index={index}
      onClose={onClose} {...props} isActive={active === cardId} onActivate={() => setActiveId(cardId)} />)}
  </div>;
  return typeof document === "undefined" ? layer : createPortal(layer, document.body);
}

function CardReaderPanel({ cardId, index, onClose, onViewed, onToggleFavorite, isFavorite, isActive, onActivate }: Omit<Props, "cardIds"> & {
  cardId: string; index: number; isActive: boolean; onActivate: () => void;
}) {
  const [history, setHistory] = useState([cardId]);
  const currentId = history.at(-1)!;
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [frame, setFrame] = useState(() => initialReaderFrame(index));
  const [manipulating, setManipulating] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const live = useRef(frame);
  const gesture = useRef<{ id: number; x: number; y: number; origin: ReaderFrame; kind: "move" | "resize" } | null>(null);

  useEffect(() => {
    let active = true;
    setCard(null); setError(null); setEditing(false);
    contentRef.current?.scrollTo({ top: 0 });
    fetchCard(currentId).then((detail) => {
      if (active) { setCard(detail); onViewed?.(detail); }
    }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [currentId, onViewed]);

  const commitFrame = (next: ReaderFrame) => { live.current = next; setFrame(next); };
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 320 || window.innerHeight < 240) return;
      gesture.current = null; setManipulating(false);
      const next = fitReaderFrame(live.current, { width: window.innerWidth, height: window.innerHeight });
      live.current = next; setFrame(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const start = (event: ReactPointerEvent<HTMLElement>, kind: "move" | "resize") => {
    if (event.button !== 0 || (kind === "move" && (event.target as HTMLElement).closest("button"))) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: live.current, kind };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault(); onActivate(); setManipulating(true);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    const next = g.kind === "move" ? { ...g.origin, x: g.origin.x + dx, y: g.origin.y + dy }
      : { ...g.origin, width: Math.min(g.origin.width + dx, window.innerWidth - g.origin.x - 8), height: Math.min(g.origin.height + dy, window.innerHeight - g.origin.y - 8) };
    live.current = fitReaderFrame(next, { width: window.innerWidth, height: window.innerHeight });
    if (panelRef.current) Object.assign(panelRef.current.style, {
      left: `${live.current.x}px`, top: `${live.current.y}px`, width: `${live.current.width}px`, height: `${live.current.height}px`,
    });
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    if (gesture.current?.id !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setManipulating(false); commitFrame(live.current);
  };

  return <section ref={panelRef} className={`card-reader card-reader--${cardVisualKind(card?.type ?? "")}${manipulating ? " is-dragging" : ""}`}
    aria-label={card?.title ?? "读取知识卡片"} onPointerDownCapture={onActivate}
    style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: isActive ? 4 : 1 }}>
    <div className="card-reader__header" title="拖动知识卡片" tabIndex={0} aria-label="移动卡片：拖动或使用方向键"
      onPointerDown={(e) => start(e, "move")} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault(); commitFrame(fitReaderFrame({ ...live.current, x: live.current.x + (e.key === "ArrowRight" ? 24 : e.key === "ArrowLeft" ? -24 : 0), y: live.current.y + (e.key === "ArrowDown" ? 24 : e.key === "ArrowUp" ? -24 : 0) }, { width: window.innerWidth, height: window.innerHeight }));
      }}>
      <span className="reader-window-title"><DotsSixVertical size={20}/>知识卡片</span>
      <div className="card-reader__actions">
        {card?.edit_id&&<button className="reader-edit-body" aria-pressed={editing} onClick={()=>setEditing(true)}><PencilSimple size={16}/>编辑正文</button>}
        <button aria-label="恢复卡片默认大小与位置" title="恢复默认大小与位置" onClick={() => commitFrame(initialReaderFrame(index))}><ArrowCounterClockwise size={18}/></button>
        {card && onToggleFavorite && <button className={`card-reader__favorite${isFavorite?.(card.id) ? " is-active" : ""}`}
          aria-label={isFavorite?.(card.id) ? "取消收藏" : "收藏此卡片"} aria-pressed={isFavorite?.(card.id) ?? false}
          onClick={() => onToggleFavorite(card)}><Star size={21} weight={isFavorite?.(card.id)?'fill':'regular'}/></button>}
        <button className="card-reader__close" aria-label="关闭此卡片" onClick={() => onClose(cardId)}><X size={21}/></button>
      </div>
    </div>
    <div ref={contentRef} className="card-reader__content">
      {history.length > 1 && <button className="card-reading-back" onClick={() => setHistory((items) => items.slice(0, -1))}>← 返回上一张卡片</button>}
      {error && <p role="alert">{error}</p>}
      {!error && !card && <p role="status">正在读取卡片…</p>}
      {card && <>
        <p className="card-reading-meta">{card.maturity}{card.updated ? ` · 更新 ${card.updated}` : ""}</p>
        <h2 className="card-reading-title">{card.title}</h2>
        <div className="card-reading-domains" aria-label="主类型"><span>{cardTypeLabel(card)}</span></div>
        {!!card.domains.length && <div className="card-reading-domains" aria-label="所属领域">{card.domains.map((id) => <span key={id}>{card.domain_titles?.[id] ?? id}</span>)}</div>}
        {!card.domain_content && <CardRelations relations={card.relations} onNavigate={(id) => setHistory((items) => [...items, id])} />}
        {card.superseded_by&&<p>此卡已合并。<button onClick={()=>setHistory(h=>[...h,card.superseded_by!])}>查看保留卡片</button></p>}
        {card.summary&&<p className="card-reader__summary">{card.summary}</p>}
        {card.domain_content && <DomainContent content={card.domain_content} onNavigate={id=>setHistory(items=>[...items,id])} />}
        {!!card.quality_notes?.length&&<p role="note">待校对：{card.quality_notes.join('；')}</p>}
        {card.user_edited_at&&<p className="reader-writing-hint">正文经你编辑 · {new Date(card.user_edited_at).toLocaleDateString('zh-CN')}</p>}
        {card.edit_id&&card.revision?<CardWriting key={card.edit_id} card={card} editing={editing} onEditing={setEditing} onSaved={setCard}/>:<CardMarkdown body={card.body} libraryId={card.library_id??undefined} />}
        {card.domain_content && <DomainRelations relations={card.relations ?? []} onNavigate={id=>setHistory(items=>[...items,id])} />}
        <CardSources sources={card.sources} libraryId={card.library_id??undefined} onNavigate={id=>setHistory(h=>[...h,id])}/>
        {!!card.assets?.length&&<section className="card-assets"><h3>来源图片</h3>{card.assets.map(a=><figure key={a.ref}><a href={a.url} target="_blank" rel="noreferrer"><img loading="lazy" src={a.url} alt={a.caption||a.locator||"来源图片"} style={{maxWidth:"100%",maxHeight:280,objectFit:"contain"}}/></a><figcaption>{a.caption} · {a.locator}</figcaption></figure>)}</section>}
      </>}
    </div>
    <button className="card-reader__resize" aria-label="调整卡片大小" title="拖动调整大小，或使用方向键"
      onPointerDown={(e) => start(e, "resize")} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault(); commitFrame(fitReaderFrame({ ...live.current, width: live.current.width + (e.key === "ArrowRight" ? 24 : e.key === "ArrowLeft" ? -24 : 0), height: live.current.height + (e.key === "ArrowDown" ? 24 : e.key === "ArrowUp" ? -24 : 0) }, { width: window.innerWidth, height: window.innerHeight }));
      }}><svg viewBox="0 0 16 16" aria-hidden><path d="M5 13 13 5M9 13l4-4" /></svg></button>
  </section>;
}

export function CardRelations({ relations = [], onNavigate }: { relations?: CardRelation[]; onNavigate: (id: string) => void }) {
  if (!relations.length) return null;
  return <section className="card-reading-relations" aria-label="关联卡片">
    <h4>关联卡片 <span>{relations.length}</span></h4>
    <div>{relations.map((item, index) => <button type="button" key={`${item.direction}-${item.target}-${item.type}-${index}`}
      title={item.note || item.target_title} onClick={() => onNavigate(item.target)}>
      <small>{item.direction === "incoming" ? "来自" : "指向"}</small><span>{({adjacent:'邻接',bridge:'跨域桥接',specialization:'细分',supplement:'补充',challenge:'质疑',example:'例证',application:'应用',related:"相关（历史）",contrast:"对照",analogy:"类比",boundary:"边界（历史）",background:"背景（历史）"} as Record<string,string>)[item.type]??item.type}</span><strong>{item.target_title}</strong><span aria-hidden>↗</span>
    </button>)}</div>
  </section>;
}

export function sourceReaderId(ref:string,libraryId?:string) {
  const file=ref.split('#')[0],prefix=libraryId?'kb:'+libraryId+':':'';
  if(BOOK_UNIT_REF.test(file))return prefix+'book:'+file+':0';
  if(isBookMaterialPath(file))return null;
  if(file.startsWith('05-Buffer/'))return prefix+'buffer:'+file+':0';
  return null;
}

export function cardMarkdownUrl(url:string,libraryId?:string) {
  const [ref,fragment]=url.replace(/^\.\.\//,'').split('#');
  if(isBookMaterialPath(ref)&&!isBookResource(ref))return '';
  if(isBookResource(ref)||/^03-Archive\/(?:assets|sources)\//.test(ref))
    return '/api/uno/assets?ref='+encodeURIComponent(ref)+(libraryId?'&library_id='+encodeURIComponent(libraryId):'')+(fragment?'#'+fragment:'');
  return /^(?:https?:|mailto:|#|\/|[^:]+$)/i.test(url)?url:'';
}

export function CardSources({sources=[],libraryId,onNavigate}:{sources?:string[];libraryId?:string;onNavigate:(id:string)=>void}) {
  if(!sources.length)return null;
  return <details><summary>来源与引用 · {sources.length}</summary>{sources.map(ref=>{
    const file=ref.split('#')[0],id=sourceReaderId(ref,libraryId),unit=BOOK_UNIT_REF.exec(file)?.[3].match(/^c(\d+)-p(\d+)$/);
    return <p key={ref}>{id?<button onClick={()=>onNavigate(id)}>查看原文 · {unit?`阅读单元 ${Number(unit[1])}.${Number(unit[2])}`:file.split('/').at(-1)}</button>
      :isBookResource(file)?<a href={cardMarkdownUrl(ref,libraryId)} target="_blank" rel="noreferrer">查看归档原书或资源</a>:ref}</p>;
  })}</details>;
}

export const CardMarkdown = memo(function CardMarkdown({ body,libraryId }: { body: string;libraryId?:string }) {
  return <div className="md-body card-reader__body"><ReactMarkdown urlTransform={url=>cardMarkdownUrl(url,libraryId)} remarkPlugins={[remarkGfm]}>{readableCardBody(body)}</ReactMarkdown></div>;
});
