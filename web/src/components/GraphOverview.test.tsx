import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Distribution} from './GraphOverview';

it('overlapping domain percentages use all cards as denominator',()=>{
 const html=renderToStaticMarkup(<Distribution title="领域比例" items={[{type:'国家治理',count:2},{type:'组织制度',count:2}]} total={3} colorFor={()=>'#fff'}/>);
 expect(html.match(/66\.7%/g)).toHaveLength(2);
 expect(html).not.toContain('50%');
});
it('large classification collections start bounded and offer search without changing the denominator',()=>{
 const html=renderToStaticMarkup(<Distribution title="领域比例" searchable items={Array.from({length:30},(_,i)=>({type:`领域${i}`,count:2}))} total={3} colorFor={()=>'#fff'}/>);
 expect(html.match(/<strong>66\.7%<\/strong>/g)).toHaveLength(12);
 expect(html).toContain('查找图谱分类');
 expect(html).toContain('显示更多分类');
});
it('empty and very small percentages stay meaningful',()=>{
 expect(renderToStaticMarkup(<Distribution title="领域比例" items={[]} total={0} colorFor={()=>'#fff'}/>)).toContain('暂无');
 const html=renderToStaticMarkup(<Distribution title="领域比例" items={[{type:'稀少领域',count:1}]} total={10000} colorFor={()=>'#fff'}/>);
 expect(html).toContain('&lt;0.1%');expect(html).not.toContain('NaN');
});
