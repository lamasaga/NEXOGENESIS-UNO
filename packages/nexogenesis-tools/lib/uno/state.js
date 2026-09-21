import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { unoPath } from '../harness/uno-storage.js';
import { safeId } from '../uno-contract.js';
import { isBookWorkflow } from './book-sources.js';
import { STRATEGY_CONSTRUCTION_WORKFLOW } from './construction-strategy.js';
export function jobRef(id) { if(!safeId(id))throw new Error('任务 ID 无效');return '.nexogenesis/uno-jobs/'+id+'.json'; }
export function readCompileJob(root,id) { return JSON.parse(readFileSync(unoPath(root,jobRef(id)),'utf8')); }
export function saveCompileJob(root,job) {
  job.version=(job.version??0)+1;job.updated_at=new Date().toISOString();
  const path=unoPath(root,jobRef(job.id));mkdirSync(dirname(path),{recursive:true});
  const staging=path+'.'+randomUUID()+'.tmp';writeFileSync(staging,JSON.stringify(job));
  try {
    for(let attempt=0;;attempt++)try{renameSync(staging,path);break;}catch(error){
      if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10*(attempt+1));
    }
  } finally { if(existsSync(staging))unlinkSync(staging); }
  return job;
}
/** Historical lookup is read-only and does not make a saved job executable. */
export function readSessionJob(root,sessionId) {
  if(!sessionId)return null;
  const dir=unoPath(root,'.nexogenesis/uno-jobs');if(!existsSync(dir))return null;
  for(const name of readdirSync(dir).filter(n=>n.endsWith('.json'))) {
    const job=JSON.parse(readFileSync(unoPath(root,'.nexogenesis/uno-jobs/'+name),'utf8'));
    if(job.session_id===sessionId||job.sessions?.includes(sessionId))return job;
  }return null;
}
export function sessionCompileJob(root,sessionId) {
  const job=readSessionJob(root,sessionId);
  return job&&(isBookWorkflow(job.workflow)||job.mode==='construct'&&['uno-compile-v3',STRATEGY_CONSTRUCTION_WORKFLOW].includes(job.workflow))?job:null;
}
