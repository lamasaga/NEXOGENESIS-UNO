import {ConstructionControls} from '../ConstructionControls';
import {defaultConstructionControls,knowledgePreferenceText} from '../../../../packages/nexogenesis-tools/lib/construction-controls.js';
import { useEffect, useState } from 'react';
import { countUnoPreferences, type UnoPreferences, type UnoTokenUsage } from '../../api/client';
import './knowledgeProcessing.css';

const stages=[
  {id:'overall',index:'01',title:'总体'},
  {id:'compile',index:'02',title:'编译'},
  {id:'construct',index:'03',title:'建构'},
  {id:'conversation',index:'04',title:'对话'}
];

interface KnowledgeProcessingProps {
  value: UnoPreferences;
  onChange: (value: UnoPreferences) => void;
  conversationPersona?: string;
  defaultConversationPersona?: string;
  onConversationPersonaChange?: (value: string) => void;
  onRestoreConversationPersona?: () => void;
}

export function KnowledgeProcessing({
  value,onChange,conversationPersona='',defaultConversationPersona='',
  onConversationPersonaChange=()=>undefined,onRestoreConversationPersona=()=>undefined
}:KnowledgeProcessingProps) {
  const [usage,setUsage]=useState<UnoTokenUsage|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>{
    countUnoPreferences(knowledgePreferenceText(value),false,controller.signal).then(result=>{setUsage(result);setError('');}).catch(e=>{if(!controller.signal.aborted)setError(String(e));});
  },350);return()=>{clearTimeout(timer);controller.abort();};},[value.prompt,value.purpose,value.organization]);
  const patch=(fields:Partial<UnoPreferences>)=>onChange({...value,...fields});
  const organization=value.organization??{cards:'independent' as const,domains:'broad' as const,cross_domain:'normal' as const};
  return <div className="knowledge-processing">
    <header className="knowledge-processing__header">
      <div className="knowledge-processing__scope"><span>知识处理</span><strong>{value.library?.name??'当前知识库'}</strong></div>
      <h2>处理设置</h2>
      <nav className="knowledge-processing__stages" aria-label="知识处理环节">{stages.map(stage=><a href={'#knowledge-'+stage.id} key={stage.id}><span>{stage.index}</span><strong>{stage.title}</strong></a>)}</nav>
    </header>

    <section id="knowledge-overall" className="knowledge-processing__section knowledge-processing__section--overall" aria-labelledby="knowledge-overall-title">
      <div className="knowledge-processing__section-heading"><span>01</span><h3 id="knowledge-overall-title">总体</h3></div>
      <label><strong>知识库用途</strong><textarea className="knowledge-processing__purpose" aria-label="知识库用途与关注问题" value={value.purpose??''} maxLength={2000} onChange={e=>patch({purpose:e.target.value})} placeholder="这套知识主要解决什么问题？" rows={3}/></label>
      <div className="knowledge-processing__organization">
        <label>卡片组织<select value={organization.cards} onChange={e=>patch({organization:{...organization,cards:e.target.value as typeof organization.cards}})}><option value="independent">倾向独立表达</option><option value="integrated">倾向完整综合</option></select></label>
        <label>领域组织<select value={organization.domains} onChange={e=>patch({organization:{...organization,domains:e.target.value as typeof organization.domains}})}><option value="broad">倾向较宽的问题空间</option><option value="focused">倾向细分问题空间</option></select></label>
        <label>跨域联系<select value={organization.cross_domain} onChange={e=>patch({organization:{...organization,cross_domain:e.target.value as typeof organization.cross_domain}})}><option value="normal">常规发现</option><option value="priority">重点探索</option></select></label>
      </div>
      <label className="knowledge-processing__requirements"><strong>共同要求</strong><textarea aria-label="知识处理长期偏好" value={value.prompt} onChange={e=>patch({prompt:e.target.value})} placeholder="需要保留什么、做到多细、清理哪些噪声？" rows={5}/></label>
      <div className="knowledge-processing__meter"><span>长期偏好与单次要求合计上限 3,000 tokens</span><span>{usage?`${usage.exact?'':'约 '}${usage.tokens.toLocaleString()} / 3,000`:'正在计量…'}</span></div>
      {usage?.warning&&<small>{usage.warning}</small>}{error&&<p role="alert">{error}</p>}
    </section>

    <section id="knowledge-compile" className="knowledge-processing__section" aria-labelledby="knowledge-compile-title">
      <div className="knowledge-processing__section-heading"><span>02</span><h3 id="knowledge-compile-title">编译</h3></div>
      <div className="knowledge-processing__grid">
        <label><strong>材料清理</strong><select value={value.cleaning} onChange={e=>patch({cleaning:e.target.value as UnoPreferences['cleaning']})}><option value="clear">清除明确噪声</option><option value="retain">谨慎保留</option></select></label>
        <label><strong>质量模式</strong><select value={value.compile_quality??'standard'} onChange={e=>patch({compile_quality:e.target.value as UnoPreferences['compile_quality']})}><option value="standard">标准编译</option><option value="refine-each-card-v1">高质量 · 逐卡精修</option></select></label>
      </div>
      {value.compile_quality==='refine-each-card-v1'?<div className="knowledge-processing__notice"><strong>逐卡精修会显著增加请求量与耗时</strong></div>:null}
      <label className="knowledge-processing__toggle"><span><strong>归档外链图片</strong><small>下载失败时保留原链接</small></span><input type="checkbox" checked={value.external_images} onChange={e=>patch({external_images:e.target.checked})}/></label>
    </section>

    <section id="knowledge-construct" className="knowledge-processing__section" aria-labelledby="knowledge-construct-title">
      <div className="knowledge-processing__section-heading"><span>03</span><h3 id="knowledge-construct-title">建构</h3></div>
      <ConstructionControls defaults compact value={value.construction??defaultConstructionControls()} onChange={construction=>patch({construction})}/>
      <label className="knowledge-processing__delivery"><strong>结算方式</strong><select value={value.delivery} onChange={e=>patch({delivery:e.target.value as UnoPreferences['delivery']})}><option value="auto">审核通过后自动保存</option><option value="manual">审核后由我确认</option></select></label>
    </section>

    <section id="knowledge-conversation" className="knowledge-processing__section" aria-labelledby="knowledge-conversation-title">
      <div className="knowledge-processing__section-heading"><span>04</span><h3 id="knowledge-conversation-title">对话</h3></div>
      <label className="knowledge-processing__persona">
        <span className="knowledge-processing__persona-title"><strong>思维体人设</strong><button type="button" disabled={conversationPersona===defaultConversationPersona} onClick={onRestoreConversationPersona}>恢复默认</button></span>
        <textarea aria-label="思维体人设" value={conversationPersona} maxLength={12000} onChange={e=>onConversationPersonaChange(e.target.value)} placeholder="例如：像一位严谨但不居高临下的长期研究伙伴。先给出直接判断，再解释关键依据；语气自然、克制，遇到不确定信息明确说明，不使用空泛鼓励。" rows={9} spellCheck={false}/>
        <span className="knowledge-processing__persona-meta"><small>不改变事实与知识权限</small><small>{conversationPersona.length.toLocaleString()} / 12,000</small></span>
      </label>
    </section>

    <details className="knowledge-processing__budget"><summary>请求预算</summary><label>新任务默认请求数<input type="number" min={10} max={2000} value={value.budget_calls} onChange={e=>patch({budget_calls:Number(e.target.value)})}/></label></details>
  </div>;
}
