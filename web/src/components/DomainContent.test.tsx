import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DomainContent, DomainRelations } from './DomainContent';

describe('领域说明与关系',()=>{
  it('displays boundaries and bounded entry cards, not all member bodies',()=>{
    const html=renderToStaticMarkup(<DomainContent content={{core_questions:['如何授权？'],includes:['组织责任'],excludes:['部门名录'],parents:[],representative_cards:[{id:'a',title:'授权机制'}],member_count:600,missing_fields:[]}} onNavigate={()=>{}}/>);
    for(const text of ['核心问题','如何授权？','纳入范围','排除范围','授权机制','600','不是完整成员清单'])expect(html).toContain(text);
  });
  it('shows direction, use conditions and limits explicitly; missing old fields are not invented',()=>{
    const html=renderToStaticMarkup(<DomainRelations relations={[{direction:'incoming',target:'domain:a',target_title:'组织治理',type:'bridge',note:'比较责任安排',use_when:'讨论授权时',limits:'不能互推结论',anchors:[{id:'m',title:'参考机制'}]},{direction:'outgoing',target:'domain:c',target_title:'历史领域',type:'adjacent',note:'已有交界'}]} onNavigate={()=>{}}/>);
    for(const text of ['来自','前往','桥接','何时使用','讨论授权时','适用边界','不能互推结论','参考机制','尚待补充'])expect(html).toContain(text);
  });
});
