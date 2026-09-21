import { randomUUID } from 'node:crypto';

const subscribers = new Map();
const histories = new Map();
const connections = new Map();
const MAX_QUEUE_BYTES = 256 * 1024;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 256;
const IDLE_MS = 5 * 60 * 1000;
let historyBytes = 0;

function evict(id) {
  const history = histories.get(id);
  if (history) historyBytes -= history.bytes;
  histories.delete(id);
}
function prune(now = Date.now()) {
  for (const [id, history] of histories) if (!subscribers.has(id) && now-history.at > IDLE_MS) evict(id);
  while (histories.size > MAX_SESSIONS || historyBytes > MAX_HISTORY_BYTES) evict(histories.keys().next().value);
}
const cleanupTimer = setInterval(prune, 60000);
cleanupTimer.unref();

export function graphEventStats() {
  prune();
  return { sessions: histories.size, history_bytes: historyBytes, connections: connections.size,
    queued_bytes: [...connections.values()].reduce((sum,state)=>sum+state.bytes,0) };
}
function disconnect(res) {
  const state=connections.get(res);
  if (!state) return;
  unsubscribeGraphEvents(state.id,res);
  res.destroy?.();
}
function flush(res) {
  const state=connections.get(res);
  if (!state) return;
  state.blocked=false;
  while (state.queue.length && !state.blocked) {
    const text=state.queue.shift();state.bytes-=Buffer.byteLength(text);
    try { state.blocked=res.write(text)===false; } catch {disconnect(res);return;}
  }
}
function writeFrame(res, frame) {
  const state=connections.get(res);if(!state)return;
  const text=`id: ${frame.epoch}:${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`;
  if (Buffer.byteLength(text)>MAX_QUEUE_BYTES) {disconnect(res);return;}
  if(state.blocked) {
    state.bytes+=Buffer.byteLength(text);
    if(state.bytes>MAX_QUEUE_BYTES || state.queue.length>=96){disconnect(res);return;}
    state.queue.push(text);return;
  }
  try {state.blocked=res.write(text)===false;} catch {disconnect(res);}
}
export function subscribeGraphEvents(conversationId,res,{after=null,epoch=null}={}) {
  prune();
  if(!subscribers.has(conversationId))subscribers.set(conversationId,new Set());
  subscribers.get(conversationId).add(res);
  const drain=()=>flush(res),close=()=>unsubscribeGraphEvents(conversationId,res);
  connections.set(res,{id:conversationId,queue:[],bytes:0,blocked:false,drain,close});
  res.on?.('drain',drain);res.on?.('close',close);
  const history=histories.get(conversationId);
  if(Number.isFinite(after) && (!epoch || epoch===history?.epoch)) {
    for(const frame of history?.frames??[])if(frame.seq>after)writeFrame(res,frame);
  }
  return close;
}
export function unsubscribeGraphEvents(conversationId,res) {
  const state=connections.get(res);
  if(state){res.off?.('drain',state.drain);res.off?.('close',state.close);connections.delete(res);}
  const set=subscribers.get(conversationId);set?.delete(res);if(!set?.size)subscribers.delete(conversationId);
}
export function broadcastGraphEvent(conversationId,event) {
  prune();
  const history=histories.get(conversationId)??{epoch:randomUUID(),seq:0,frames:[],bytes:0,at:Date.now()};
  const seq=++history.seq;
  const frame={type:event.type,ts:Date.now(),epoch:history.epoch,seq,payload:{...(event.payload??{}),seq}};
  const size=Buffer.byteLength(JSON.stringify(frame));
  history.frames.push(frame);history.bytes+=size;historyBytes+=size;history.at=Date.now();
  while(history.frames.length>96){const removed=history.frames.shift();const bytes=Buffer.byteLength(JSON.stringify(removed));history.bytes-=bytes;historyBytes-=bytes;}
  histories.delete(conversationId);histories.set(conversationId,history);prune();
  for(const res of [...(subscribers.get(conversationId)??[])]) {
    if(res.writableEnded||res.destroyed){unsubscribeGraphEvents(conversationId,res);continue;}
    writeFrame(res,frame);
  }
}
export function broadcastCognitiveEvent(conversationId,event) {broadcastGraphEvent(conversationId,{type:'cognitive.event',payload:event});}
