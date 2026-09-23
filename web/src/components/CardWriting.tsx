import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatText, PencilSimple, Check } from '@phosphor-icons/react';
import { fetchCard, saveReaderEntry, type CardDetail, type ReaderAnchor, type ReaderNote, type ReaderWrite } from '../api/client';
import { readableCardBody } from './cardReading';
import { anchorPosition, highlighted, nodeText } from './readerAnnotations';
import { cardMarkdownUrl } from './CardReader';
import './CardWriting.css';

type Draft=ReaderWrite;
const BlockContext=createContext<(tag:'p'|'li',children:ReactNode,start?:number,end?:number)=>ReactNode>(()=>null);
const annotationComponents:Components={
  p:function Paragraph({node,children}){return useContext(BlockContext)('p',children,node?.position?.start.offset,node?.position?.end.offset);},
  li:function ListItem({node,children}){const render=useContext(BlockContext);return node?.children.some(n=>n.type==='element'&&['p','ul','ol'].includes(n.tagName))?<li>{children}</li>:render('li',children,node?.position?.start.offset,node?.position?.end.offset);}
};
const AnnotatedMarkdown=memo(function AnnotatedMarkdown({body,libraryId}:{body:string;libraryId?:string}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={annotationComponents} urlTransform={url=>cardMarkdownUrl(url,libraryId)}>{body}</ReactMarkdown>;
});
function restoreDraft(key:string):Draft|null { try { const d=JSON.parse(localStorage.getItem(key)??'null');return d&&['body','note'].includes(d.operation)&&typeof d.text==='string'&&typeof d.expected_revision==='string'&&typeof d.request_id==='string'?d:null; } catch{return null;} }

export function CardWriting({card,editing,onEditing,onSaved}:{card:CardDetail;editing:boolean;onEditing:(value:boolean)=>void;onSaved:(card:CardDetail)=>void}) {
  const storageKey=`uno.reader-draft.v1:${card.edit_id}`;
  const [draft,setDraft]=useState<Draft|null>(()=>restoreDraft(storageKey));
  const [selection,setSelection]=useState<ReaderAnchor|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  const [latest,setLatest]=useState<CardDetail|null>(null);
  const root=useRef<HTMLDivElement>(null),saving=useRef(false);
  const [renderedBlocks,setRenderedBlocks]=useState<Set<number>>(new Set());
  const body=readableCardBody(card.body),notes=card.user_notes??[];
  const positions=new Map(notes.filter(n=>n.anchor).map(n=>[n.id,anchorPosition(body,n.anchor!)]));
  const misplaced=notes.filter(n=>n.anchor&&(positions.get(n.id)===null||!renderedBlocks.has(positions.get(n.id)!)));
  useLayoutEffect(()=>{if(draft?.operation!=='body')setRenderedBlocks(new Set(Array.from(root.current?.querySelectorAll<HTMLElement>('[data-note-block]')??[]).map(node=>Number(node.dataset.noteBlock))));},[body,draft?.operation]);
  const change=(next:Draft|null)=>{setDraft(next);setError('');setStatus('');setLatest(null);};
  useEffect(()=>{ try { if(draft)localStorage.setItem(storageKey,JSON.stringify(draft));else localStorage.removeItem(storageKey); }catch{setError('本机草稿无法保存，请在关闭前保存到知识库。');} },[draft,storageKey]);
  useEffect(()=>{
    if(editing&&draft?.operation!=='body') {
      if(draft?.text.trim()){setError('请先保存或取消当前笔记。');onEditing(false);return;}
      change({operation:'body',text:card.body,expected_revision:card.revision!,request_id:crypto.randomUUID()});
    }
  },[editing]);
  useEffect(()=>{if(draft?.operation==='body')onEditing(true);},[]);
  const beginNote=(anchor:ReaderAnchor|null,note?:ReaderNote)=>{
    if(draft?.text.trim()){setError('请先保存或取消当前编辑。');return;}
    change({operation:'note',text:note?.text??'',expected_revision:card.revision!,request_id:crypto.randomUUID(),note_id:note?.id??crypto.randomUUID(),expected_note_revision:note?.revision??null,anchor});
    setSelection(null);
  };
  const inspectSelection=()=>{
    const selected=window.getSelection();
    if(!selected||selected.isCollapsed||!selected.rangeCount){setSelection(null);return;}
    const range=selected.getRangeAt(0),element=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer as Element:range.startContainer.parentElement;
    const block=element?.closest<HTMLElement>('[data-note-block]');
    if(!block||!root.current?.contains(block)||!block.contains(range.endContainer)){setSelection(null);return;}
    const startRange=range.cloneRange();startRange.selectNodeContents(block);startRange.setEnd(range.startContainer,range.startOffset);
    const quote=range.toString(),start=startRange.toString().length,blockStart=Number(block.dataset.noteBlock),blockEnd=Number(block.dataset.noteEnd);
    if(!quote.trim()||quote.length>10000){setSelection(null);return;}
    setSelection({block:body.slice(blockStart,blockEnd),block_start:blockStart,quote,start,end:start+quote.length});
  };
  const save=async()=>{
    if(!draft?.text.trim()||saving.current)return;
    saving.current=true;setBusy(true);setError('');setStatus('');
    try {
      await saveReaderEntry(card.edit_id!,draft);
      const fresh=await fetchCard(card.edit_id!);
      change(null);onEditing(false);onSaved({...fresh,id:card.id});setStatus('已保存');
      window.dispatchEvent(new CustomEvent('uno:card-written',{detail:{id:card.edit_id}}));
    } catch(reason) {setError(reason instanceof Error?reason.message:String(reason));}
    finally{saving.current=false;setBusy(false);}
  };
  const cancel=()=>{if(draft?.text.trim()&&!window.confirm('放弃这份尚未保存的编辑？'))return;change(null);onEditing(false);};
  const editText=(text:string)=>{if(draft)change({...draft,text,request_id:crypto.randomUUID()});};
  const editor=(label:string)=><div className="reader-note-editor" onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void save();}if(e.key==='Escape')e.stopPropagation();}}>
    <label>{label}<textarea autoFocus aria-label={label} value={draft?.text??''} maxLength={draft?.operation==='body'?200000:20000} disabled={busy} onChange={e=>editText(e.target.value)} rows={draft?.operation==='body'?20:3} placeholder="写下此刻的想法…" /></label>
    <div className="reader-note-editor__footer"><small>{busy?'正在保存…':'草稿保存在本机'}</small><div><button disabled={busy} onClick={cancel}>取消</button><button className="reader-save" disabled={busy||!draft?.text.trim()} onClick={()=>void save()}>{draft?.operation==='body'?'保存正文':'保存想法'}</button></div></div>
  </div>;
  const noteView=(note:ReaderNote)=><div className="reader-inline-note" key={note.id}>
    <div className="reader-inline-note__meta"><span>{note.anchor?'我的批注':'我的想法'} · {new Date(note.updated_at).toLocaleDateString('zh-CN')}</span><button aria-label="编辑这条笔记" title="编辑这条笔记" disabled={busy} onClick={()=>beginNote(note.anchor,note)}><PencilSimple size={16}/></button></div>
    {draft?.note_id===note.id?editor('编辑笔记'):<p>{note.text}</p>}
  </div>;
  const block=(tag:'p'|'li',children:ReactNode,start?:number,end?:number)=>{
    if(start===undefined||end===undefined)return tag==='li'?<li>{children}</li>:<p>{children}</p>;
    const attached=notes.filter(n=>n.anchor&&positions.get(n.id)===start),text=nodeText(children);
    const ranges=attached.filter(n=>text.slice(n.anchor!.start,n.anchor!.end)===n.anchor!.quote).map(n=>n.anchor!);
    const pending=draft?.operation==='note'&&draft.anchor&&!notes.some(n=>n.id===draft.note_id)&&anchorPosition(body,draft.anchor)===start;
    const content=<><span data-note-block={start} data-note-end={end}>{highlighted(children,ranges)}</span>{selection?.block_start===start&&!draft&&<button className="reader-selection-action" onMouseDown={e=>e.preventDefault()} onClick={()=>beginNote(selection)}><ChatText size={16}/>添加批注</button>}</>;
    return tag==='li'?<li>{content}{attached.map(noteView)}{pending&&editor('我的批注')}</li>:<div className="reader-annotated-paragraph"><p>{content}</p>{attached.map(noteView)}{pending&&editor('我的批注')}</div>;
  };
  const draftPosition=draft?.anchor?anchorPosition(body,draft.anchor):null;
  const floatingDraft=draft?.operation==='note'&&draft.anchor&&!notes.some(n=>n.id===draft.note_id)&&(draftPosition===null||!renderedBlocks.has(draftPosition));
  return <div className="card-writing" ref={root}>
    {error&&<div role="alert" className="reader-writing-error"><p>{error}</p><button disabled={busy} onClick={()=>void fetchCard(card.edit_id!).then(setLatest).catch(e=>setError(String(e)))}>查看最新内容</button></div>}
    {latest&&<div className="reader-latest"><details open><summary>当前保存的正文</summary><pre>{latest.body}</pre>{latest.user_notes?.map(n=><p key={n.id}>{n.text}</p>)}</details><button onClick={()=>{if(draft){change({...draft,expected_revision:latest.revision!,expected_note_revision:latest.user_notes?.find(n=>n.id===draft.note_id)?.revision??null,request_id:crypto.randomUUID()});onSaved({...latest,id:card.id});}}}>已核对，以当前版本继续编辑</button></div>}
    {draft?.operation==='body'?<section className="reader-body-editor"><p className="reader-writing-hint">编辑正文 · 支持 Markdown</p>{editor('卡片正文')}</section>:<BlockContext.Provider value={block}><div className="md-body card-reader__body reader-annotated-body" onMouseUp={inspectSelection} onKeyUp={inspectSelection} onTouchEnd={inspectSelection}><AnnotatedMarkdown body={body} libraryId={card.library_id??undefined}/></div></BlockContext.Provider>}
    {draft?.operation!=='body'&&!!misplaced.length&&<section className="reader-unplaced"><h3>待核对的批注</h3><p className="reader-writing-hint">原段落已变化，保留原引用供你对照。</p>{misplaced.map(n=><div key={n.id}><blockquote>{n.anchor!.quote}</blockquote>{noteView(n)}</div>)}</section>}
    {floatingDraft&&<section><blockquote>{draft.anchor!.quote}</blockquote><p>原句已变化，请核对引用。</p>{editor('我的批注')}</section>}
    <section className="reader-thoughts" aria-label="我的想法"><h3>我的想法</h3>{notes.filter(n=>!n.anchor).map(noteView)}
      {draft?.operation==='note'&&!draft.anchor&&!notes.some(n=>n.id===draft.note_id)?editor('追加想法'):!draft&&<button className="reader-thoughts__prompt" onClick={()=>beginNote(null)}><PencilSimple size={18}/>写下一个想法，或留一个待验证的问题…</button>}
      {status&&<p role="status" className="reader-writing-status"><Check size={14}/>{status}</p>}
    </section>
  </div>;
}
