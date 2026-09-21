import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptOutput, PromptContent, type PromptRecord } from './PromptInspector';
it('实际输入作为文本展示，明确区分运行时快照和供应商报文',()=>{
 const record: PromptRecord={id:'id',created_at:'2026-09-15',stage:'独立审核',title:'测试',provider:'other',model:'model',status:'completed',chars:100,capture:'runtime',omissions:['历史推理块未保存'],input:{},sections:[{label:'系统规则',location:'system',chars:30,content:'<script>window.bad=true</script>'}]};
 const html=renderToStaticMarkup(<PromptContent record={record}/>);
 expect(html).toContain('此处不是 HTTP 原始报文');expect(html).toContain('历史推理块未保存');expect(html).toContain('导出 JSON');expect(html).not.toContain('<script>');
 expect(renderToStaticMarkup(<PromptContent record={{...record,capture:'wire'}}/>)).toContain('发送给供应商前的请求正文');
 const truncated=renderToStaticMarkup(<PromptContent record={{...record,status:'truncated',usage:{outputTokens:4000,reasoningTokens:4000}}}/>);
 expect(truncated).toContain('达到输出上限');expect(truncated).toContain('不能视为回答完成');expect(truncated).toContain('4,000');
});
it('显示完整输入治理前后字节、精简计数及估算边界，兼容旧快照',()=>{
 const record: PromptRecord={id:'governed',created_at:'2026-09-16',stage:'编译 · 阅读与制卡',title:'本批原文',provider:'kimi-coding',model:'kimi-for-coding',status:'completed',chars:5100,capture:'runtime',omissions:['历史推理块未保存'],input:{messages:[]},sections:[],context_governance:{version:'uno-request-context-v1',before_bytes:152000,after_bytes:91200,saved_bytes:60800,removed_progress:12,compacted_failed_calls:2,deduplicated_results:3,input_limit_bytes:128000,estimated_input_tokens:45600,token_estimate:true}};
 const html=renderToStaticMarkup(<PromptContent record={record}/>);
 expect(html).toContain('本次上下文治理');expect(html).toContain('治理前 152,000 字节');expect(html).toContain('治理后 91,200 字节');expect(html).toContain('减少 60,800 字节');
 expect(html).toContain('移除旧进度 12 份');expect(html).toContain('精简旧失败参数 2 次');expect(html).toContain('去重工具结果 3 份');
 expect(html).toContain('完整输入上限 128,000 字节');expect(html).toContain('输入 Token 估算 45,600');expect(html).toContain('不代表供应商 Token 或账单用量');expect(html).toContain('历史推理块未保存');
 const legacy=renderToStaticMarkup(<PromptContent record={{...record,context_governance:undefined}}/>);
 expect(legacy).not.toContain('本次上下文治理');expect(legacy).toContain('此处不是 HTTP 原始报文');
});
it('模型返回展示原文及工具调用，转义HTML并区分历史缺失与中断',()=>{
 const record:PromptRecord={id:'reply',created_at:'2026-09-17',stage:'编译',title:'测试',provider:'kimi',model:'kimi-for-coding',status:'completed',chars:10,capture:'runtime',input:{},sections:[],omissions:[],output:{version:1,blocks:[{index:0,type:'text',text:'```json\n{"card":{}}\n```\n<script>bad()</script>'},{index:1,type:'tool-call',id:'call1',name:'read_card',arguments:'{"id":"甲"}'}]}};
 const html=renderToStaticMarkup(<PromptOutput record={record}/>);expect(html).toContain('```json');expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('工具调用');expect(html).toContain('read_card');
 expect(renderToStaticMarkup(<PromptOutput record={{...record,status:'cancelled'}}/>)).toContain('仅展示已接收到的部分');
 expect(renderToStaticMarkup(<PromptOutput record={{...record,output:undefined}}/>)).toContain('历史记录未保存');
 expect(renderToStaticMarkup(<PromptOutput record={{...record,output:{version:1,blocks:[]}}}/>)).toContain('尚未记录到可见返回');
 expect(renderToStaticMarkup(<PromptContent record={record}/>)).toContain('模型返回内容');
});

