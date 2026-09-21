import { Component, lazy, Suspense, useMemo, useState, useRef, type ComponentType, type ReactNode, type ReactElement } from 'react';

class PanelBoundary extends Component<{children:ReactNode;fallback:ReactNode;onError:(error:Error)=>void},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(error:Error){this.props.onError(error);}
  render(){return this.state.failed?this.props.fallback:this.props.children;}
}
export function recoverablePanel<P extends {onClose:()=>void}>(load:()=>Promise<{default:(props:P)=>ReactElement}>,name:string,exportName:string) {
  return function Recoverable(props:P) {
    const [attempt,setAttempt]=useState(0);
    const failedURL=useRef<string|null>(null);
    const onError=(error:Error)=>{
      const match=error.message.match(/https?:\/\/[^\s]+\.js(?:\?[^\s]*)?/);
      if(!match)return;
      const url=new URL(match[0]);
      if(url.origin===location.origin&&url.pathname.startsWith('/assets/'))failedURL.current=url.href;
    };
    const Panel=useMemo(()=>lazy(async()=>{
      if(attempt&&failedURL.current){
        const url=new URL(failedURL.current);url.searchParams.set('uno_panel_retry',String(attempt));
        const module=await import(/* @vite-ignore */ url.href);
        if(typeof module[exportName]!=='function')throw Error('面板模块版本不匹配，请保留输入后刷新。');
        return {default:module[exportName] as (props:P)=>ReactElement};
      }
      return load();
    }),[attempt]) as unknown as ComponentType<P>;
    const notice=(failed:boolean)=><section className="async-panel-notice" role="dialog" aria-label={name}>
      <strong>{failed?`${name}未能加载`:`正在加载${name}…`}</strong>
      <p>{failed?'外层对话仍保留。可以重试加载或关闭；若仍失败，请复制未提交内容后刷新页面。':'可以关闭此面板返回，后台任务不会重新启动。'}</p>
      {failed&&<button onClick={()=>setAttempt(value=>value+1)}>重试加载</button>}
      <button onClick={props.onClose}>关闭面板</button>
    </section>;
    return <PanelBoundary key={attempt} fallback={notice(true)} onError={onError}><Suspense fallback={notice(false)}><Panel {...props}/></Suspense></PanelBoundary>;
  };
}
