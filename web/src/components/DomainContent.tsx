import type { DomainContentDetail, CardRelation } from '../api/client';

export function DomainContent({ content, onNavigate }: { content:DomainContentDetail; onNavigate:(id:string)=>void }) {
  return <section className="domain-reading" aria-label="领域说明">
    {content.missing_fields.length > 0 && <p role="note">领域说明尚待补充：{content.missing_fields.map(field => ({summary:'摘要',core_questions:'核心问题',includes:'纳入范围',excludes:'排除范围'} as Record<string,string>)[field] ?? field).join('、')}。</p>}
    {([['核心问题',content.core_questions],['纳入范围',content.includes],['排除范围',content.excludes]] as const).map(([title,items]) => items.length > 0 && <section key={title}><h3>{title}</h3><ul>{items.map((item,index) => <li key={index}>{item}</li>)}</ul></section>)}
    {content.parents.length > 0 && <section><h3>上级领域</h3>{content.parents.map(parent => <button type="button" key={parent.id} onClick={()=>onNavigate(parent.id)}>{parent.title}</button>)}</section>}
    <section><h3>代表卡片</h3><p>直接归属此领域的知识卡：{content.member_count} 张。代表卡片是阅读入口，不是完整成员清单。</p>
      {content.representative_cards.length ? content.representative_cards.map(card => <button type="button" key={card.id} onClick={()=>onNavigate(card.id)}>{card.title}</button>) : <p>尚未选定代表卡片。</p>}
    </section>
  </section>;
}

export function DomainRelations({ relations, onNavigate }: { relations:CardRelation[]; onNavigate:(id:string)=>void }) {
  if (!relations.length) return null;
  return <section className="domain-reading" aria-label="关联领域"><h3>关联领域</h3><p>关系用于组织阅读与比较，不代表领域之间存在因果或论证关系。</p>
    {relations.map((relation,index) => <article key={`${relation.direction}-${relation.target}-${relation.type}-${index}`}>
      <button type="button" onClick={()=>onNavigate(relation.target)}>{relation.direction === 'incoming' ? '来自' : '前往'} · {({adjacent:'邻接',contrast:'对照',bridge:'桥接'} as Record<string,string>)[relation.type] ?? relation.type} · {relation.target_title}</button>
      {relation.note && <p>{relation.note}</p>}
      {relation.use_when && <p><strong>何时使用：</strong>{relation.use_when}</p>}
      {relation.limits && <p><strong>适用边界：</strong>{relation.limits}</p>}
      {(!relation.use_when || !relation.limits) && <p>此关系的使用条件或边界尚待补充。</p>}
      {!!relation.anchors?.length && <div aria-label="关联锚点卡">{relation.anchors.map(card => <button type="button" key={card.id} onClick={()=>onNavigate(card.id)}>参考卡 · {card.title}</button>)}</div>}
    </article>)}
  </section>;
}
