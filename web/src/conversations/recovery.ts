import type { UnoStartInput } from '../api/client';

type View = {kind:'conversation';id:string}|{kind:'start';id:string};
export type PendingStart = {input:UnoStartInput;id:string};
const key=(library:string,part:string)=>`uno.recovery.v1.${library}.${part}`;
function read<T>(library:string,part:string):T|null {
  try{return JSON.parse(sessionStorage.getItem(key(library,part))??'null');}catch{return null;}
}
function write(library:string,part:string,value:unknown){
  if(typeof sessionStorage==='undefined')return;
  sessionStorage.setItem(key(library,part),JSON.stringify(value));
}
export const savedView=(library:string)=>read<View>(library,'view');
export const pendingStart=(library:string)=>read<PendingStart>(library,'start');
export function rememberConversation(library:string,id:string){try{write(library,'view',{kind:'conversation',id});}catch{/* navigation remains usable without storage */}}
export function forgetView(library:string){try{write(library,'view',null);}catch{}}
const signature=(input:UnoStartInput)=>JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k])=>k!=='request_id').sort(([a],[b])=>a.localeCompare(b))));
export function prepareStart(input:UnoStartInput):PendingStart {
  const library=input.library_id??'legacy',previous=pendingStart(library);
  if(previous&&signature(previous.input)!==signature(input))throw Error('上次开始请求尚未确认，请先核对原任务，或使用保留的要求重试。');
  const pending=previous??{input,id:input.request_id??crypto.randomUUID()};
  write(library,'start',pending);write(library,'view',{kind:'start',id:pending.id});return pending;
}
export function completeStart(library:string,id:string,owner:string){
  if(pendingStart(library)?.id===id)write(library,'start',null);
  const view=savedView(library);if(view?.kind==='start'&&view.id===id)rememberConversation(library,owner);
}
export function rejectStart(library:string,id:string){
  if(pendingStart(library)?.id===id)write(library,'start',null);
  if(savedView(library)?.id===id)forgetView(library);
}
