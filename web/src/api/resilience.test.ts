import { afterEach, expect, it, vi } from 'vitest';
import { __resetLocalRequestTokenForTests, fetchCognitiveSession, fetchGraph, setRequestInstance, suspendInstanceWrites, testModelConnection } from './client';
import { pollAfterSettlement } from './poll';
import { waitForSignal } from './abort';
import { prepareStart, completeStart, pendingStart, savedView } from '../conversations/recovery';
import { resetStorageMemoryForTests } from '../conversations/safeStorage';
afterEach(()=>{__resetLocalRequestTokenForTests();setRequestInstance(null);resetStorageMemoryForTests();vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});

it('进入等待前已取消也收尾底层拒绝，不产生未处理 Promise',async()=>{
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  await expect(waitForSignal(Promise.reject(new Error('late network failure')),controller.signal)).rejects.toThrow('cancelled');
  await new Promise(resolve=>setTimeout(resolve,0));
});
it('读取 403 错误正文期间可取消，不重发业务请求',async()=>{
  const controller=new AbortController(),reading=vi.fn(()=>new Promise<never>(()=>{}));
  const denied=new Response('',{status:403});vi.spyOn(denied,'clone').mockReturnValue({json:reading} as unknown as Response);
  const fetcher=vi.fn(async(url:string)=>url==='/api/security/session'?new Response('{"token":"safe"}'):denied);vi.stubGlobal('fetch',fetcher);
  const input={provider:'deepseek',model:'deepseek-chat'} as Parameters<typeof testModelConnection>[0];
  const pending=testModelConnection(input,'',controller.signal);await vi.waitFor(()=>expect(reading).toHaveBeenCalled());
  controller.abort(new Error('cancelled'));await expect(pending).rejects.toThrow('cancelled');expect(fetcher).toHaveBeenCalledTimes(2);
});

it('取令牌期间取消独立等待者，不中断其他调用，也不发送已取消业务',async()=>{
  let token!:(value:Response)=>void;const calls:string[]=[];
  vi.stubGlobal('fetch',vi.fn((url:string)=>{calls.push(url);return url==='/api/security/session'?new Promise<Response>(resolve=>token=resolve):Promise.resolve(new Response('{}'));}));
  const controller=new AbortController();
  const input={provider:'deepseek',model:'deepseek-chat'} as Parameters<typeof testModelConnection>[0];
  const cancelled=testModelConnection(input,'',controller.signal);const healthy=testModelConnection(input,'');
  controller.abort();await expect(cancelled).rejects.toThrow();expect(calls).toEqual(['/api/security/session']);
  token(new Response(JSON.stringify({token:'safe'})));await healthy;expect(calls).toHaveLength(2);
});
it('存储读写均失败时保留同一请求 ID，成功结算不会再提交一次',()=>{
  vi.stubGlobal('sessionStorage',{getItem(){throw Error('denied');},setItem(){throw Error('full');}});
  const input={mode:'construct' as const,library_id:'memory-only'},first=prepareStart(input);
  expect(prepareStart(input).id).toBe(first.id);expect(pendingStart('memory-only')?.id).toBe(first.id);
  completeStart('memory-only',first.id,'owner');expect(pendingStart('memory-only')).toBeNull();expect(savedView('memory-only')).toEqual({kind:'conversation',id:'owner'});
});
it('相同资源合并在途读取，切库后旧请求拒绝交付',async()=>{
  let finish!:(value:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(resolve=>finish=resolve));vi.stubGlobal('fetch',fetcher);
  setRequestInstance('A');const one=fetchCognitiveSession('same'),two=fetchCognitiveSession('same');expect(one).toBe(two);expect(fetcher).toHaveBeenCalledTimes(1);
  setRequestInstance('B');finish(new Response(JSON.stringify({active:false})));await expect(one).rejects.toThrow('知识库已切换');await expect(two).rejects.toThrow();
});
it('响应头先到但 JSON 在切库后完成，也拒绝旧正文',async()=>{
  let finish!:(value:unknown)=>void;
  const response=new Response('{}');response.json=()=>new Promise(resolve=>finish=resolve);
  vi.stubGlobal('fetch',vi.fn(async()=>response));setRequestInstance('A');
  const request=fetchGraph();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  setRequestInstance('B');finish({nodes:[],edges:[]});await expect(request).rejects.toThrow('知识库已切换');
});
it('安全会话超时可结算并重新连接，旧令牌晚到不能污染新令牌',async()=>{
  const controllers:AbortController[]=[],finish:Array<(value:Response)=>void>=[],sent:string[]=[];
  vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>{const controller=new AbortController();controllers.push(controller);return controller.signal;});
  vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{
    if(url==='/api/security/session')return new Promise<Response>(resolve=>finish.push(resolve));
    sent.push(new Headers(init?.headers).get('X-Nexogenesis-CSRF')!);return Promise.resolve(new Response('{}'));
  }));
  const input={provider:'deepseek',model:'deepseek-chat'} as Parameters<typeof testModelConnection>[0];
  const first=testModelConnection(input,'');controllers[0].abort(new Error('timeout'));await expect(first).rejects.toThrow('timeout');expect(sent).toHaveLength(0);
  const second=testModelConnection(input,'');finish[1](new Response('{"token":"new-token"}'));await second;
  finish[0](new Response('{"token":"old-token"}'));await new Promise(resolve=>setTimeout(resolve,0));
  await testModelConnection(input,'');expect(sent).toEqual(['new-token','new-token']);
});
it('身份未核对时阻止写操作，业务 403 不自动重发',async()=>{
  const input={provider:'deepseek',model:'deepseek-chat'} as Parameters<typeof testModelConnection>[0];
  const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);return url==='/api/security/session'?new Response('{"token":"safe"}'):new Response('{"code":"NOT_ALLOWED","detail":"denied"}',{status:403});}));
  suspendInstanceWrites();await expect(testModelConnection(input,'')).rejects.toThrow('身份待核对');expect(calls).toHaveLength(0);
  setRequestInstance('A');await expect(testModelConnection(input,'')).rejects.toThrow();expect(calls).toHaveLength(2);
});
it('轮询等待结算、不重叠，错误退避且停止后不再调度',async()=>{
  vi.useFakeTimers();vi.stubGlobal('window',new EventTarget());const document=new EventTarget();Object.assign(document,{hidden:false});vi.stubGlobal('document',document);vi.stubGlobal('navigator',{onLine:true});
  let finish!:()=>void;const task=vi.fn(()=>new Promise<void>(resolve=>finish=resolve));
  const stop=pollAfterSettlement(task,100);await vi.advanceTimersByTimeAsync(1000);expect(task).toHaveBeenCalledTimes(1);
  finish();await vi.advanceTimersByTimeAsync(99);expect(task).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(task).toHaveBeenCalledTimes(2);stop();finish();await vi.advanceTimersByTimeAsync(1000);expect(task).toHaveBeenCalledTimes(2);
  const failed=vi.fn(async()=>{throw Error('offline');});const end=pollAfterSettlement(failed,100);await vi.advanceTimersByTimeAsync(199);expect(failed).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(failed).toHaveBeenCalledTimes(2);end();
});
