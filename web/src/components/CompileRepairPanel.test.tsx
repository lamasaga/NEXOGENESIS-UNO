import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {CompileRepairPanel,repairItemGuidance} from './CompileRepairPanel';
import type {UnoRepairDetail} from '../api/client';

it('未组织池的失败修复先给解决方案，并把旧错误折叠为记录',()=>{
  const item={id:'item',title:'待修复卡',repair_kind:'card',reason:'原问题',issues:['原问题'],sources:[],body:'',raw_response:null,candidate:null,revision:'r',type:'claim',summary:'',excerpt:'',source_groups:[],candidate_domains:[],organization_signals:[],created_at:null,last_evaluated_at:null,inbound_relation_count:0,outbound_relation_count:0,updated:'',last_repair:{job_id:'old',status:'ended',reason:'新增或改变关系前须读回目标卡当前完整正文：target-card'}} as UnoRepairDetail;
  expect(repairItemGuidance(item).action).toBe('读取最新依据并处理');
  const html=renderToStaticMarkup(<CompileRepairPanel item={item} libraryId="library" onRefresh={async()=>undefined} onLater={()=>undefined}/>);
  expect(html).toContain('系统可以自动补齐最新依据');expect(html).toContain('读取最新依据并处理');expect(html).toContain('稍后处理');
  expect(html).toContain('<summary>查看问题记录与处理状态</summary>');
});
