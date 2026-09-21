import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSessionJob } from '../../nexogenesis-tools/lib/uno/state.js';
import { getUnoRequestGovernance } from '../../nexogenesis-tools/lib/uno/request-context.js';
import { HttpError, json } from './rpc.js';

const activeCapture = new AsyncLocalStorage();
const generation = randomUUID();
const stores = new Map();
const LIMIT = 60;
const RECORD_BYTES = 8 * 1024 * 1024;
const STORE_BYTES = 64 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const format = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const finishStatus = kind => ['max-tokens', 'length'].includes(kind) ? 'truncated' : kind === 'error' ? 'failed' : kind === 'aborted' ? 'cancelled' : ['stop', 'tool-calls'].includes(kind) ? 'completed' : 'incomplete';

function governanceMetadata(messages) {
  const stats = getUnoRequestGovernance(messages);
  if (!stats) return undefined;
  // Diagnostics retain counters only, never the original request or replay state.
  const counts = ['before_bytes', 'after_bytes', 'saved_bytes', 'removed_progress', 'compacted_failed_calls',
    'deduplicated_results', 'input_limit_bytes', 'estimated_input_tokens'];
  return { ...(typeof stats.version === 'string' || typeof stats.version === 'number' ? {version:stats.version} : {}),
    ...Object.fromEntries(counts.filter(key => Number.isFinite(stats[key]) && stats[key] >= 0).map(key => [key, stats[key]])),
    ...(stats.token_estimate === true ? {token_estimate:true} : {}) };
}

// Record visible input/output only; transport credentials and internal reasoning are excluded.
export function visibleInput(value, omissions = []) {
  if (Array.isArray(value)) return value.filter(item => {
    if (!['reasoning', 'thinking', 'redacted_thinking'].includes(item?.type)) return true;
    omissions.push('历史推理块未保存'); return false;
  }).map(item => visibleInput(item, omissions));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (key === 'replayState' || value.role === 'assistant' && key === 'reasoning_content') { omissions.push('历史推理或不透明状态未保存'); return []; }
    if (value.type === 'base64' && key === 'data' && typeof item === 'string') { omissions.push('图片二进制未保存'); return [[key, '[图片数据未保存]']]; }
    if (key === 'url' && typeof item === 'string' && item.startsWith('data:')) { omissions.push('图片二进制未保存'); return [[key, '[图片数据未保存]']]; }
    return [[key, visibleInput(item, omissions)]];
  }));
  return value;
}

export class PromptStore {
  constructor(root) {
    this.dir = join(resolve(root), '.nexogenesis', 'prompt-inspector');
    this.warning = '';
    this.inputs = new WeakMap();
    this.pending = new Map();
    try { this.items = JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')).slice(0, LIMIT).map(item => item.status === 'running' && item.generation !== generation ? { ...item, status: 'interrupted' } : item); }
    catch (error) { this.items = []; if (error.code !== 'ENOENT') this.warning = '旧请求索引无法读取；新调用仍会继续。'; }
  }
  write(file, value) {
    mkdirSync(this.dir, { recursive: true });
    const text=JSON.stringify(value);
    if(Buffer.byteLength(text)>RECORD_BYTES)throw new Error('请求诊断记录超过单文件 8 MiB 上限');
    writeFileSync(join(this.dir, file + '.tmp'), text, 'utf8');
    renameSync(join(this.dir, file + '.tmp'), join(this.dir, file));
  }
  save(record) {
    const pending=this.pending.get(record.id);if(pending){clearTimeout(pending);this.pending.delete(record.id);}
    if (!this.items.some(item => item.id === record.id)) return; // Late completion must not resurrect an evicted call.
    record.chars = record.sections.reduce((n, part) => n + part.chars, 0);
    record.output_chars = record.output?.blocks.reduce((n,b)=>n+(b.type==='text'?b.text.length:b.arguments.length),0);
    const { input, sections, output, ...summary } = record;
    this.items = this.items.map(item => item.id === record.id ? summary : item);
    if(this.inputs.get(record)!==input){this.write(record.id+'.input',input);this.inputs.set(record,input);}
    this.write(record.id + '.json', { ...summary, input_file:record.id+'.input', ...(output ? {output} : {}) });
    this.write('index.json', this.items);
    let bytes=0;
    for(const item of [...this.items]) {
      if(!/^[a-f0-9-]{36}$/.test(item.id))continue;
      const paths=[join(this.dir,item.id+'.json'),join(this.dir,item.id+'.input')];
      for(const path of paths)if(existsSync(path))bytes+=statSync(path).size;
      if(bytes>STORE_BYTES){this.items=this.items.filter(current=>current.id!==item.id);clearTimeout(this.pending.get(item.id));this.pending.delete(item.id);for(const path of paths)if(existsSync(path))unlinkSync(path);}
    }
    if(bytes>STORE_BYTES){this.warning='请求诊断目录达到 64 MiB 预算，较早记录已移出；正式账本与收据不受影响。';this.write('index.json',this.items);}
  }
  schedule(record) {
    if(this.pending.has(record.id)||!this.items.some(item=>item.id===record.id))return;
    const timer=setTimeout(()=>{this.pending.delete(record.id);try{this.save(record);}catch{this.warning='请求记录保存延迟或失败，模型执行未被中断。';}},0);
    timer.unref();this.pending.set(record.id,timer);
  }
  begin(options, metadata) {
    const omissions = [];
    const input = visibleInput({ provider: options.provider, model: options.model, system: options.system ?? '', messages: options.messages, tools: options.tools ?? [], maxTokens: options.maxTokens, reasoningEffort: options.reasoningEffort, temperature: options.temperature, stop: options.stop }, omissions);
    const governance = governanceMetadata(options.messages);
    const record = { id: randomUUID(), generation, created_at: new Date().toISOString(), status: 'running', provider: options.provider, model: options.model, ...metadata, ...(governance ? {context_governance:governance} : {}), capture: 'runtime', omissions: [...new Set(omissions)], input, output:{version:1,blocks:[]}, sections: inputSections(input, false) };
    const removed = this.items.slice(LIMIT - 1);
    this.items = [{ id: record.id }, ...this.items].slice(0, LIMIT);
    this.save(record);
    for (const item of removed) if (/^[a-f0-9-]{36}$/.test(item.id)) {
      clearTimeout(this.pending.get(item.id));this.pending.delete(item.id);
      const file = join(this.dir, item.id + '.json'); if (existsSync(file)) unlinkSync(file);
      const inputFile=join(this.dir,item.id+'.input');if(existsSync(inputFile))unlinkSync(inputFile);
    }
    return record;
  }
  list() { return { limit: LIMIT, items: clone(this.items).map(item => item.finish ? { ...item, status: finishStatus(item.finish) } : item), warning: this.warning }; }
  get(id) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !this.items.some(item => item.id === id)) throw new HttpError(404, '该请求已不在最近 60 次记录中，请刷新列表。');
    const record = JSON.parse(readFileSync(join(this.dir, id + '.json'), 'utf8'));
    if(record.input_file===id+'.input')record.input=JSON.parse(readFileSync(join(this.dir,record.input_file),'utf8'));
    // Old snapshots may predate nested native replay/thinking redaction. Sanitize
    // on read too, without rewriting the original diagnostic file.
    const omissions=[...(record.omissions??[])];record.input=visibleInput(record.input,omissions);record.omissions=[...new Set(omissions)];
    const summary = this.items.find(item => item.id === id);
    const sections = inputSections(record.input, record.capture === 'wire');
    return { ...record, sections, chars: sections.reduce((n, part) => n + part.chars, 0), status: record.finish ? finishStatus(record.finish) : summary.status };
  }
}
export function promptStore(root) {
  const key = resolve(root); if (!stores.has(key)) stores.set(key, new PromptStore(key)); return stores.get(key);
}

export function inputSections(input, wire) {
  const sections = [];
  const add = (label, content, location) => { const text = format(content); sections.push({ label, location, chars: text.length, content: text }); };
  const textPart = (label, content, location) => {
    const marker = '\n本任务固定目标与偏好：\n', offset = content.indexOf(marker);
    if (offset >= 0) {
      add(label, content.slice(0, offset), location + '[0:' + offset + ']');
      add('本次目标与冻结偏好', content.slice(offset), location + '[' + offset + ':]');
    } else add(label, content, location);
  };
  if (!wire && input.system) textPart('系统规则与任务要求', input.system, 'system');
  const messages = input.messages ?? [];
  messages.forEach((message, index) => {
    const content = format(message.content ?? '');
    const label = message.role === 'system' ? '系统规则与任务要求' : message.role === 'tool' || message.content?.some?.(b => b.type === 'tool-result') ? '工具返回 · 正文或执行结果'
      : message.role === 'assistant' ? '历史模型回复与工具调用' : content.includes('【本轮相关材料') ? '检索材料与本轮问题'
      : content.includes('UNO 当前执行状态') ? '当前任务进度' : index === messages.length - 1 ? '本轮问题或执行指令' : '历史用户输入或运行上下文';
    const location = `messages[${index}]`;
    if (typeof message.content === 'string') textPart(`${index + 1}. ${label} · ${message.role}`, message.content, location + '.content');
    else if (Array.isArray(message.content)) message.content.forEach((block, part) => {
      const path = location + `.content[${part}]`;
      if (block.type === 'text') textPart(`${index + 1}. ${label} · ${message.role}`, block.text, path);
      else add(`${index + 1}. ${block.type} · ${message.role}`, block, path);
    });
    if (message.tool_calls?.length) add(`${index + 1}. 历史工具调用`, message.tool_calls, location + '.tool_calls');
  });
  if (input.tools?.length) add(`可用工具定义 · ${input.tools.length} 个`, input.tools, 'tools');
  const { system, messages: ignored, tools, ...parameters } = input;
  add('模型参数', parameters, 'parameters');
  return sections;
}

// Called at the actual HTTP dispatch boundary by UNO's OpenAI-compatible adapter.
export function captureWireInput(body) {
  const capture = activeCapture.getStore(); if (!capture) return;
  try {
    const omissions = []; const input = visibleInput(body, omissions);
    Object.assign(capture.record, { capture: 'wire', input, sections: inputSections(input, true), omissions: [...new Set(omissions)] });
    capture.store.save(capture.record);
  } catch { capture.store.warning = '部分请求正文保存失败，模型执行未被中断。'; }
}

export function requestPurpose(root, options) {
  const hint = options.nexoPrompt ?? {};
  const job = options.sessionId ? readSessionJob(root, options.sessionId) : null;
  const auxiliary = { compaction: '历史压缩', 'session-title': '对话命名' }[options.purpose];
  const stage = auxiliary ?? ({ 'construction-strategy':'建构 · 策略与选卡', 'construction-author':'建构 · 专用执行', 'construction-review':'建构 · 独立审核', 'construction-repair':'建构 · 局部修复', 'construction-verify':'建构 · 修复复核', 'unit-collision': '编译 · 同名卡核对', 'unit-supplement': '编译 · 遗漏补全', 'unit-generate': '编译 · 单元制卡', 'unit-check': '编译 · 卡片检查', 'unit-repair': '编译 · 单卡修复', 'unit-verify': '编译 · 单卡核对', 'unit-relation-repair': '编译 · 关系修复', 'unit-relation-verify': '编译 · 关系核对', 'unit-recovery':'编译 · 响应恢复', 'single-card-rewrite':'未组织池 · 单卡完整重写', 'single-card-review':'未组织池 · 单卡独立审核', 'single-card-repair':'未组织池 · 单卡局部修复', 'single-card-verify':'未组织池 · 单卡修复核对', 'single-card-domain-review':'未组织池 · 单卡领域核对', intent: '意图判断／直接回答', answer: '检索后回答' }[hint.phase]) ?? (job ? (job.mode === 'construct' ? '建构' : '编译') + ' · ' + (job.role === 'reviewer' ? '独立审核' : ({ select: '选材判断', read: job.mode === 'construct' ? '检查与修订' : '阅读与制卡', organize: '整理检查' }[job.phase] ?? job.phase)) : '对话／模型辅助调用');
  return { stage, session_id: options.sessionId ?? null, job_id: job?.id ?? null, title: job?.title ?? '', phase: hint.phase ?? job?.phase ?? options.purpose ?? null, route: hint.route ?? null, batch: job ? job.batch_index + 1 : null };
}

// block-end replaces accumulated deltas; it must never duplicate the returned text.
export function captureVisibleOutput(output,chunk){
  const closed=chunk.type==='block-end'?chunk.block:null;
  if(!['text-delta','tool-call-delta'].includes(chunk.type) && !['text','tool-call'].includes(closed?.type))return false;
  const type=closed?.type??(chunk.type==='text-delta'?'text':'tool-call'),index=chunk.index??0;
  let block=output.blocks.find(b=>b.index===index && b.type===type);
  if(!block){block=type==='text'?{index,type,text:''}:{index,type,id:'',name:'',arguments:''};output.blocks.push(block);output.blocks.sort((a,b)=>a.index-b.index);}
  if(type==='text')block.text=closed?String(closed.text??''):block.text+String(chunk.text??'');
  else if(closed){block.id=closed.id??block.id;block.name=closed.name??block.name;block.arguments=typeof closed.arguments==='string'?closed.arguments:JSON.stringify(closed.arguments??{});}
  else{if(chunk.id)block.id=chunk.id;if(chunk.name)block.name=chunk.name;block.arguments+=chunk.argumentsDelta??'';}
  return true;
}

export function registerPromptInspector(ctx, getRoot) {
  return ctx.on('llm/stream', (options, next) => (async function* () {
    let capture, iterator, finished = false, lastOutputSave = 0, lastOutputChars=0;
    try {
      let ownedRoot;
      try {
        const sessionRoot = options.sessionId ? ctx.get?.('sessions')?.get(options.sessionId)?.header?.cwd : undefined;
        if(sessionRoot && readSessionJob(sessionRoot,options.sessionId)) ownedRoot=sessionRoot;
      } catch { /* Diagnostic lookup cannot prevent model execution. */ }
      const root = options.nexoPrompt?.root ?? ownedRoot ?? getRoot(); const store = promptStore(root);
      try { capture = { store, record: store.begin(options, requestPurpose(root, options)) }; }
      catch { store.warning = '请求快照保存失败；请检查本地磁盘空间与权限。'; }
      iterator = next()[Symbol.asyncIterator]();
      while (true) {
        const result = await activeCapture.run(capture, () => iterator.next());
        if (result.done) { finished = true; break; }
        const chunk = result.value;
        if(capture && captureVisibleOutput(capture.record.output,chunk) && Date.now()-lastOutputSave>=2000 && capture.record.output.blocks.reduce((sum,block)=>sum+(block.text?.length??block.arguments?.length??0),0)-lastOutputChars>=4096){
          lastOutputSave=Date.now();
          lastOutputChars=capture.record.output.blocks.reduce((sum,block)=>sum+(block.text?.length??block.arguments?.length??0),0);
          capture.store.schedule(capture.record);
        }
        if (capture && chunk.type === 'usage') capture.record.usage = clone(chunk.usage);
        if (capture && chunk.type === 'finish') {
          capture.record.status = finishStatus(chunk.reason?.kind);
          capture.record.finish = chunk.reason?.kind;
        }
        yield chunk;
      }
    } catch (error) { if (capture) capture.record.status = options.signal?.aborted ? 'cancelled' : 'failed'; throw error; }
    finally {
      try { if (!finished) await iterator?.return?.(); }
      finally { if (capture) {
        if (capture.record.status === 'running') capture.record.status = options.signal?.aborted ? 'cancelled' : 'incomplete';
        capture.record.elapsed_ms = Date.now() - Date.parse(capture.record.created_at);
        try { capture.store.save(capture.record); } catch { capture.store.warning = '请求结束状态保存失败。'; }
      } }
    }
  })(), { global: true });
}

export function handlePromptInspector(req, res, root) {
  if (req.method !== 'GET') throw new HttpError(405, '仅支持查看请求');
  res.setHeader('cache-control', 'no-store');
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/prompt-inspector') return json(res, 200, promptStore(root).list());
  const match = /^\/api\/prompt-inspector\/([^/]+)$/.exec(path);
  if (!match) throw new HttpError(404, 'not found');
  return json(res, 200, promptStore(root).get(match[1]));
}
