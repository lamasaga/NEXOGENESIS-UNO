import { resolve } from 'node:path';
import { readInstanceRegistry } from '../instances/registry.js';
import { sessionCompileJob, readCompileJob, saveCompileJob } from './state.js';
import { sha } from '../harness/uno-storage.js';

export function executionError(code, message, details) {
  return Object.assign(new Error(message), {code, ...(details ? {details} : {})});
}

// A native session's immutable creation directory owns its tools and prompt.
// The selected UI library is deliberately not an execution input.
export function sessionRootResolver(config) {
  const bindings = new Map();
  return context => {
    const session = context?.agent?.session ?? context?.session;
    const id = session?.id ?? session?.header?.id;
    if (!id) throw executionError('STALE_CONTEXT', '工具调用缺少所属会话');
    if (bindings.has(id)) return bindings.get(id);
    const roots = [...new Set([resolve(config.projectRoot), ...readInstanceRegistry(config.instanceRegistry).instances.map(i => resolve(i.root))])];
    const cwd = session.header?.cwd;
    const matches = roots.filter(root => (!cwd || root.toLowerCase() === resolve(cwd).toLowerCase()) && sessionCompileJob(root, id));
    if (matches.length !== 1) throw executionError('STALE_CONTEXT', '无法唯一定位会话所属知识库与任务，停止执行');
    bindings.set(id, matches[0]);
    return matches[0];
  };
}

/** Bound serialized Unicode pages before recording the delivered interval. */
export function evidencePage(chars, offset, limit, build, maxBytes = 32000) {
  let end = Math.min(chars.length, offset + limit), result = build(end);
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && end > offset) {
    end = offset + Math.floor((end - offset) * .75);
    result = build(end);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes || (end === offset && offset < chars.length)) {
    throw executionError('RESULT_TOO_LARGE', '对象元数据超过返回预算，未登记阅读；需要缩小对象或修订元数据。');
  }
  return {end, result};
}

/** Stop only identical consecutive failures, not valid rereads or revised attempts. */
export function guardRepeatedFailure(root, id, name, args, result, sessionId) {
  const job=readCompileJob(root,id);
  if(job.status!=='running'||(sessionId&&job.session_id!==sessionId))return result;
  const failed=result.ok===false||result.ready===false;
  if(!failed){if(job.repeated_failure){delete job.repeated_failure;saveCompileJob(root,job);}return result;}
  const hash=sha(JSON.stringify({name,args,result}));
  const count=job.repeated_failure?.hash===hash?job.repeated_failure.count+1:1;
  job.repeated_failure={hash,count,tool:name,session_id:job.session_id};
  if(count>=3){job.status='paused';job.detail='连续三次相同调用得到相同失败，已暂停以避免继续消耗。已有成果保留；请依据失败原因调整后恢复。';}
  saveCompileJob(root,job);
  return count>=3?{...result,stop:true,error:{code:'NO_PROGRESS',message:job.detail,recovery:'保留当前阶段与收据，修正失败原因后明确恢复；不要自动续跑。'}}:result;
}
