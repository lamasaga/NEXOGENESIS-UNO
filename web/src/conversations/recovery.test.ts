import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { completeStart, pendingStart, prepareStart, rejectStart, rememberConversation, savedView } from './recovery';
import { __resetLocalRequestTokenForTests, startUnoJob, subscribeEvents } from '../api/client';

beforeEach(()=>{
  const values=new Map<string,string>();
  vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
});
afterEach(()=>{vi.unstubAllGlobals();__resetLocalRequestTokenForTests();});

it('开始要求跨页面重建保留同一标识，知识库之间隔离，未确认前不能更换范围',()=>{
  const input={mode:'construct' as const,library_id:'one',domain:'state-governance'};
  const first=prepareStart(input);
  expect(prepareStart({...input}).id).toBe(first.id);
  expect(savedView('one')).toEqual({kind:'start',id:first.id});
  expect(prepareStart({domain:'state-governance',library_id:'one',mode:'construct'}).id).toBe(first.id);
  expect(()=>prepareStart({...input,domain:'another-domain'})).toThrow('尚未确认');
  expect(prepareStart({...input,library_id:'two'}).id).not.toBe(first.id);
});
it('迟到的开始回执不能覆盖已选择的另一会话或清除另一请求',()=>{
  const first=prepareStart({mode:'construct',library_id:'one'});
  rejectStart('one','unrelated');expect(pendingStart('one')?.id).toBe(first.id);
  rememberConversation('one','other');completeStart('one',first.id,'owner');
  expect(savedView('one')).toEqual({kind:'conversation',id:'other'});
  expect(pendingStart('one')).toBeNull();
});
it('开始请求的网络回执丢失后重试同一请求，确认后恢复主会话',async()=>{
  const ids:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
    if(url==='/api/security/session')return new Response(JSON.stringify({token:'local'}));
    ids.push(JSON.parse(init!.body as string).request_id);
    if(ids.length===1)throw Error('connection lost after acceptance');
    return new Response(JSON.stringify({id:ids[0],owner_session_id:'owner'}));
  }));
  const input={mode:'construct' as const,library_id:'one'};
  await expect(startUnoJob(input)).rejects.toThrow('connection lost');
  expect(pendingStart('one')?.id).toBe(ids[0]);
  await startUnoJob(input);expect(ids[1]).toBe(ids[0]);
  expect(pendingStart('one')).toBeNull();expect(savedView('one')).toEqual({kind:'conversation',id:'owner'});
});
it('明确的输入拒绝解除待确认请求，允许用户修正',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url==='/api/security/session'?{token:'local'}:{error:'invalid scope'}),{status:url==='/api/security/session'?200:400})));
  await expect(startUnoJob({mode:'construct',library_id:'one'})).rejects.toThrow();
  expect(pendingStart('one')).toBeNull();expect(savedView('one')).toBeNull();
});
it('事件重新连接触发快照恢复，切换会话后的迟到连接不触发恢复',()=>{
  let stream:{onopen:()=>void;onmessage:(event:{data:string})=>void;close:()=>void};
  vi.stubGlobal('EventSource',class{onopen=()=>{};onmessage=()=>{};close=vi.fn();constructor(){stream=this;}});
  const onEvent=vi.fn(),onOpen=vi.fn(),close=subscribeEvents('one',onEvent,onOpen);
  stream!.onopen();stream!.onopen();expect(onOpen).toHaveBeenCalledTimes(2);
  close();stream!.onopen();stream!.onmessage({data:JSON.stringify({type:'work.updated'})});
  expect(onOpen).toHaveBeenCalledTimes(2);expect(onEvent).not.toHaveBeenCalled();
});
