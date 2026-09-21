import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unoPath, sha } from '../harness/uno-storage.js';
import {defaultConstructionControls,validateConstructionControls,knowledgePreferenceText} from '../construction-controls.js';

export const PREFERENCE_LIMIT = 3000;
export const DEFAULT_PREFERENCES = Object.freeze({prompt:'',purpose:'',construction:defaultConstructionControls(),organization:{cards:'independent',domains:'broad',cross_domain:'normal'},cleaning:'clear',compile_quality:'standard',external_images:false,delivery:'auto',budget_calls:120});
export function readPreferences(root) {
  const file=unoPath(root,'.nexogenesis/knowledge-processing.json');
  const saved=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
  return {...DEFAULT_PREFERENCES,...saved,revision:existsSync(file)?sha(readFileSync(file)):null};
}
function validatePreferenceValues(input,minimumBudget) {
  input={...DEFAULT_PREFERENCES,...input};
  if(typeof input.purpose!=='string'||input.purpose.length>2000)throw Error('知识库用途须为 2000 字符以内的文字。');
  input.construction=validateConstructionControls(input.construction);
  if(!['independent','integrated'].includes(input.organization?.cards)||!['broad','focused'].includes(input.organization?.domains)||!['normal','priority'].includes(input.organization?.cross_domain))throw Error('知识组织偏好无效。');
  input.organization=Object.fromEntries(['cards','domains','cross_domain'].map(key=>[key,input.organization[key]]));
  if(typeof input.prompt!=='string'||Buffer.byteLength(input.prompt)>128000)throw new Error('编译偏好必须是文本，传输大小不能超过 128 KB');
  if(!['clear','retain'].includes(input.cleaning)||!['standard','refine-each-card-v1'].includes(input.compile_quality)||!['auto','manual'].includes(input.delivery)||typeof input.external_images!=='boolean')throw new Error('知识处理选项无效');
  if(!Number.isInteger(input.budget_calls)||input.budget_calls<minimumBudget||input.budget_calls>2000)throw new Error(`累计模型请求预算为 ${minimumBudget}–2000 次`);
  return Object.fromEntries(Object.keys(DEFAULT_PREFERENCES).map(k=>[k,input[k]]));
}
export function validatePreferences(input) { return validatePreferenceValues(input,10); }
export function savePreferences(root,input) {
  const old=readPreferences(root);
  if(input.revision!==old.revision)throw new Error('知识处理设置已变化，请重新加载后保存');
  const value=validatePreferences({...old,...input}),file=unoPath(root,'.nexogenesis/knowledge-processing.json');
  mkdirSync(dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(value,null,2));renameSync(file+'.tmp',file);
  return readPreferences(root);
}
export function preferenceText(longTerm,notes){return [longTerm,notes].filter(Boolean).join('\n\n');}
export const longTermPreferenceText=knowledgePreferenceText;
export async function countPreferences(text,model='',appRoot='') {
  if(!text)return {tokens:0,limit:PREFERENCE_LIMIT,exact:true,method:'empty'};
  return new Promise(resolveResult=>{
    let output='',error='',done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolveResult({...result,limit:PREFERENCE_LIMIT});};
    const fallback=()=>finish({tokens:Math.ceil([...text].reduce((n,c)=>n+(/[\x00-\x7f]/.test(c)?.3:1),0)),exact:false,method:'estimate',warning:'当前模型未配置兼容分词器，显示估计值，不代表供应商精确计量。'});
    const child=spawn(process.env.UNO_PYTHON||'python',['-B','-X','utf8',fileURLToPath(new URL('./token-count.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const timer=setTimeout(()=>{child.kill();fallback();},12000);
    child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);
    child.on('error',fallback);child.on('close',code=>{try{if(code!==0)throw Error(error);finish(JSON.parse(output));}catch{fallback();}});
    child.stdin.on('error',fallback);child.stdin.end(JSON.stringify({text,model,tokenizer_dir:existsSync(resolve(appRoot||'.','.nexogenesis/tokenizers/models.json'))?resolve(appRoot||'.','.nexogenesis/tokenizers'):fileURLToPath(new URL('../../../../.nexogenesis/tokenizers',import.meta.url))}));
  });
}
export async function freezePreferences(root,input,model,appRoot) {
  const saved=readPreferences(root);
  const long_term=input.inherit_preferences===false?'':longTermPreferenceText(saved),notes=String(input.notes??'');
  if(Buffer.byteLength(notes)>128000)throw new Error('本次要求超过传输大小限制');
  const usage=await countPreferences(preferenceText(long_term,notes),model,appRoot);
  if(usage.tokens>PREFERENCE_LIMIT)throw new Error(`长期偏好与本次要求合计${usage.exact?'':'估计'} ${usage.tokens} tokens，超过 3000；请精简要求，原文未被裁剪。`);
  const preferences=validatePreferenceValues({...saved,...Object.fromEntries(['cleaning','compile_quality','external_images','delivery','budget_calls'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))},input.orchestration_profile==='bounded-workflow-v1'?4:10);
  return {long_term,notes,usage,preferences,settings_revision:saved.revision,model,at:new Date().toISOString()};
}
