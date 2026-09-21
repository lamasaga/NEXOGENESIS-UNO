import {CONSTRUCTION_FOCUSES,CONSTRUCTION_OPERATIONS,defaultConstructionControls,type ConstructionControls as Controls,type ConstructionFocus} from '../../../packages/nexogenesis-tools/lib/construction-controls.js';
import './constructionControls.css';

export function ConstructionControls({value,onChange,defaults=false,disabled=false,compact=false}:{value:Controls;onChange:(value:Controls)=>void;defaults?:boolean;disabled?:boolean;compact?:boolean}) {
  function toggleFocus(id:ConstructionFocus) {
    if(id==='comprehensive'){onChange({...value,focuses:[id],primary:id});return;}
    if(value.focuses.includes(id)){
      if(value.focuses.length===1)return;
      const focuses=value.focuses.filter(f=>f!==id);
      onChange({...value,focuses,primary:value.primary===id?focuses[0]:value.primary});
    }else onChange({...value,focuses:[...value.focuses.filter(f=>f!=='comprehensive'),id],primary:value.primary==='comprehensive'?id:value.primary});
  }
  return <div className={`construction-controls${compact?' construction-controls--compact':''}`}>
    <fieldset disabled={disabled} className="construction-controls__focus">
      <legend>{defaults?'默认建构侧重':'这次重点改善什么'}</legend>
      {!compact?<p>可以同时关注多个方向，选择一个主要侧重。</p>:null}
      <div className="construction-controls__choices">{CONSTRUCTION_FOCUSES.map(f=><button type="button" key={f.id} aria-pressed={value.focuses.includes(f.id)} onClick={()=>toggleFocus(f.id)}>
        <span><strong>{f.label}</strong>{value.primary===f.id&&<em>主要</em>}</span>{!compact?<small>{f.description}</small>:null}
      </button>)}</div>
      {value.focuses.length>1&&<label className="construction-controls__primary">主要侧重<select aria-label="主要侧重" value={value.primary} onChange={e=>onChange({...value,primary:e.target.value as ConstructionFocus})}>{CONSTRUCTION_FOCUSES.filter(f=>value.focuses.includes(f.id)).map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select></label>}
    </fieldset>
    <fieldset disabled={disabled} className="construction-controls__permissions">
      <legend>{defaults?'默认允许调整':'允许调整'}</legend>
      <div className="construction-controls__permission-heading">{!compact?<p>侧重决定优先检查什么；以下选项决定能改什么。</p>:null}<button type="button" onClick={()=>onChange({...value,allowed:defaultConstructionControls(value.primary).allowed})}>按主要侧重配置</button></div>
      <div className="construction-controls__groups">{['关系','领域','卡片'].map(group=><div key={group}><strong>{group}</strong>{CONSTRUCTION_OPERATIONS.filter(o=>o.group===group).map(o=><label key={o.id}><input type="checkbox" checked={value.allowed.includes(o.id)} onChange={e=>{
        let allowed=e.target.checked?[...value.allowed,o.id]:value.allowed.filter(id=>id!==o.id);
        if(e.target.checked&&o.id==='card_merge'&&!allowed.includes('card_edit'))allowed.push('card_edit');
        if(!e.target.checked&&o.id==='card_edit')allowed=allowed.filter(id=>id!=='card_merge');
        onChange({...value,allowed});
      }}/><span>{o.label}</span></label>)}</div>)}</div>
      {!value.allowed.length&&<p className="construction-controls__diagnosis" role="status">只诊断并记录建议，保留现有知识。</p>}
      <details><summary>{compact?'边界':'调整边界'}</summary><p>领域归属单独治理。同一卡片本批若调整归属，正文与关系留待后续处理。合并会整合承载卡并保留来源、已有关系和旧卡去向。</p><p>建构暂不执行领域新建、定义修改、拆分、合并、层级调整，以及卡片新建与拆分。相关发现保留为待办。</p></details>
    </fieldset>
  </div>;
}
