export function pollAfterSettlement(task:()=>Promise<unknown>, interval:number) {
  let disposed=false,running=false,failures=0,timer:ReturnType<typeof setTimeout>;
  const run=async()=>{
    if(disposed||running)return;running=true;
    try {await task();failures=0;} catch {failures=Math.min(failures+1,4);}
    finally {running=false;if(!disposed){clearTimeout(timer);const inactive=document.hidden||navigator.onLine===false;timer=setTimeout(run,Math.max(interval*2**failures,inactive?15000:interval));}}
  };
  const wake=()=>{if(!document.hidden){clearTimeout(timer);void run();}};
  void run();window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  return()=>{disposed=true;clearTimeout(timer);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
}
