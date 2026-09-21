import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCards, parseCardFile } from '../cards.js';
import { safeId, safeCardId, displayType } from '../uno-contract.js';
import { CARD_TYPES, CARD_TYPE_LABELS } from './card-classification.js';
import { activeDomain, validateDomainDefinition, validateDomainRelations } from './domain-contract.js';
import { selectPassages } from '../runtime/text-edits.js';
import { sha, unoPath, unoMarkdown, unoCardRef, unoRevision, transaction, expect, readUnoUnit } from '../harness/uno-storage.js';

export const TYPES=CARD_TYPES.map(id=>({id,label:CARD_TYPE_LABELS[id]}));
export const RELATIONS={specialization:'细分',supplement:'补充',contrast:'对照',challenge:'质疑',analogy:'类比',example:'例证',application:'应用'};
export const SYMMETRIC=new Set(['contrast','analogy']);
const cache=new Map();
const materialPaths=new Map();
function materialStamp(root,ref){
  const path=unoPath(root,ref),s=statSync(path),key=resolve(root)+'\0'+ref;
  const stamp=[s.mtimeMs,s.ctimeMs,s.size].join(':');let entry=materialPaths.get(key);
  if(!entry||entry.stamp!==stamp){
    const target=ref.startsWith('05-Buffer/_index/')?parseCardFile(path).meta.target:ref;
    if(typeof target!=='string'||!target.startsWith('05-Buffer/')||target.startsWith('05-Buffer/_index/'))throw Error('原文索引目标无效');
    entry={stamp,target};materialPaths.set(key,entry);
  }
  const physical=statSync(unoPath(root,entry.target));
  return [ref,stamp,entry.target,physical.mtimeMs,physical.ctimeMs,physical.size];
}
export function readKnowledgeCard(root,id) { return loadCards(root,{includeInactive:true}).get(id); }
export function resolveCardTarget(root,id,cards=loadCards(root,{includeInactive:true})) {
  const visited=new Set();
  while(cards.get(id)?.meta.lifecycle==='superseded'){
    if(visited.has(id))return null;visited.add(id);id=cards.get(id).meta.superseded_by;
  }
  return cards.has(id)&&(!cards.get(id).meta.lifecycle||cards.get(id).meta.lifecycle==='active')?id:null;
}
const guideRoot=fileURLToPath(new URL('../../../../docs/design/knowledge-guidance/',import.meta.url));
export function readGuide(name='overview') {
  const file={overview:'README.md',types:'card-types.md',relations:'relations.md',domains:'domains.md',examples:'examples.md'}[name];
  if(!file)throw new Error('可读约定：overview、types、relations、domains、examples');return readFileSync(resolve(guideRoot,file),'utf8');
}
export function preprocessSource(root,source,signal,modern=false,materialKind,unitCharLimit=60000) {
  if(!source.startsWith('00-Inbox/'))throw new Error('只能预处理本轮选定的 Inbox 材料');
  return new Promise((resolveResult,reject)=>{
    const child=spawn(process.env.UNO_PYTHON||'python',['-B','-X','utf8',fileURLToPath(new URL('./preprocess.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
    const out=[],err=[];let size=0;
    child.stdout.on('data',data=>{size+=data.length;if(size>40*1024*1024){child.kill();reject(new Error('预处理输出超过 40 MiB'));}else out.push(data);});
    child.stderr.on('data',data=>err.push(data));child.on('error',reject);
    child.on('close',code=>{try{if(code!==0)throw new Error(Buffer.concat(err).toString('utf8')||'Python 预处理失败');resolveResult(JSON.parse(Buffer.concat(out).toString('utf8')));}catch(e){reject(e);}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({path:unoPath(root,source),root:resolve(root),modern,material_kind:materialKind,unit_char_limit:unitCharLimit}));
  });
}
export function readMaterial(root,ref,offset=0,limit=12000) {
  const unit=readUnoUnit(root,ref);offset=Math.max(0,Math.trunc(Number(offset)||0));limit=Math.max(1,Math.min(30000,Math.trunc(Number(limit)||12000)));
  const sequence=ref.startsWith('05-Buffer/_index/')?Array.from(unit.body):unit.body;const slice=sequence.slice(offset,offset+limit),text=Array.isArray(slice)?slice.join(''):slice,next=offset+slice.length;
  return {ref,title:unit.meta.title,locator:unit.meta.locator,source:unit.meta.source,revision:unit.revision,offset,text,total:sequence.length,truncated:next<sequence.length,next_offset:next<sequence.length?next:null};
}
export function listDomainsV2(root) {
  const dir=unoPath(root,'01-Cards/_meta/domains');if(!existsSync(dir))return [];
  return readdirSync(dir).filter(n=>n.endsWith('.md')).map(n=>{const ref='01-Cards/_meta/domains/'+n,c=parseCardFile(unoPath(root,ref));
    const representative_card_ids=strings(c.meta.representative_card_ids??c.meta.card_ids);
    return {...c.meta,representative_card_ids,body:c.body,ref,revision:unoRevision(root,ref)};});
}
function tokens(text) {
  const found=String(text).normalize('NFKC').toLowerCase().match(/[a-z]+(?:[-'][a-z]+)*|\d+(?:\.\d+)?|[\p{Script=Han}]+/gu)??[];
  return found.flatMap(s=>/\p{Script=Han}/u.test(s)?s.length===1?[s]:[...[...segmenter.segment(s)].filter(w=>w.isWordLike).map(w=>w.segment),...Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2))]:[s]);
}
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
function rawRefs(root) {
  const base='05-Buffer/themes/_sources',dir=unoPath(root,base),newDir=unoPath(root,'05-Buffer/_index');
  const modern=existsSync(newDir)?readdirSync(newDir).filter(n=>n.endsWith('.md')).map(n=>'05-Buffer/_index/'+n):[];
  return [...modern,...(existsSync(dir)?readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.isSymbolicLink()).flatMap(d=>readdirSync(unoPath(root,base+'/'+d.name)).filter(f=>/^(chapter-|u\d).*\.md$/.test(f)).map(f=>base+'/'+d.name+'/'+f)):[])];
}
function index(root) {
  // Repeated searches inspect file stamps, not every Buffer body. Markdown remains authoritative.
  const cards=loadCards(root),refs=rawRefs(root),signature=sha(JSON.stringify([...refs.map(ref=>materialStamp(root,ref)),...[...cards.values()].map(c=>{const ref=unoCardRef(root,c),s=statSync(unoPath(root,ref));return [ref,s.mtimeMs,s.ctimeMs,s.size];})].sort((a,b)=>a[0].localeCompare(b[0]))));
  const cached=cache.get(resolve(root));if(cached?.signature===signature)return cached;
  const file=unoPath(root,'.nexogenesis/uno-sparse-index.json');
  if(existsSync(file)){try{const saved=JSON.parse(readFileSync(file,'utf8'));if(saved.version===6&&saved.signature===signature){cache.set(resolve(root),saved);return saved;}}catch{/* Rebuild disposable index. */}}
  const docs=[];
  for(const [id,c] of cards){if(c.meta.type==='domain'||c.meta.lifecycle==='superseded'||c.meta.lifecycle==='archived')continue;
    docs.push({kind:'card',id,title:c.meta.title??id,type:displayType(c.meta),summary:c.meta.summary??c.body.slice(0,240),domains:c.meta.domains??[],quality:c.meta.quality_notes??[],text:c.body,ref:unoCardRef(root,c),relations:(c.meta.relations??[]).map(r=>({...r,target:resolveCardTarget(root,r.target)??r.target})).filter(r=>r.target!==id)});}
  for(const ref of refs){const unit=readUnoUnit(root,ref),sequence=ref.startsWith('05-Buffer/_index/')?Array.from(unit.body):unit.body;for(let offset=0;offset<sequence.length;offset+=1040){docs.push({kind:'buffer',id:ref+':'+offset,ref,offset,title:unit.meta.title??ref,locator:unit.meta.locator,attention:unit.meta.attention??'standard',source:unit.meta.source,text:Array.isArray(sequence)?sequence.slice(offset,offset+1200).join(''):sequence.slice(offset,offset+1200)});if(offset+1200>=sequence.length)break;}}
  const df={};let total=0;
  for(const doc of docs){const words=tokens([doc.title,doc.title,doc.summary,doc.type,...(doc.domains??[]),...(doc.relations??[]).map(r=>r.note),doc.text].join(' '));doc.tf={};for(const w of words)doc.tf[w]=(doc.tf[w]??0)+1;doc.length=words.length;total+=words.length;for(const w of Object.keys(doc.tf))df[w]=(df[w]??0)+1;}
  const result={version:6,signature,docs,df,average:total/Math.max(1,docs.length)};mkdirSync(dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(result));renameSync(file+'.tmp',file);cache.set(resolve(root),result);return result;
}
export function searchKnowledge(root,{query='',kind='all',type,domain,relation,neighbor,limit=8,offset=0}={}) {
  limit=Math.max(1,Math.min(30,Number(limit)||8));offset=Math.max(0,Number(offset)||0);const data=index(root),words=[...new Set(tokens(query))];
  const domainIds=new Set(domain?[domain]:[]),domains=domain?listDomainsV2(root):[];
  for(let changed=true;changed;){changed=false;for(const d of domains)if(!domainIds.has(d.id)&&(d.parents??[]).some(p=>domainIds.has(p))){domainIds.add(d.id);changed=true;}}
  if(neighbor)neighbor=resolveCardTarget(root,neighbor)??neighbor;
  const all=data.docs.filter(d=>(kind==='all'||d.kind===kind)&&(!type||d.type===type)&&(!domain||(d.domains??[]).some(id=>domainIds.has(id))));
  const links=neighbor?data.docs.filter(d=>d.kind==='card').flatMap(d=>(d.relations??[]).filter(r=>(!relation||r.type===relation)&&(d.id===neighbor||r.target===neighbor)).map(r=>({from:d.id,to:r.target,type:r.type,note:r.note,basis:r.basis??(r.origin==='navigation'?'navigation':'source')}))):[];
  const ranked=all.filter(d=>!neighbor||links.some(r=>r.from===d.id||r.to===d.id)).filter(d=>!relation||neighbor||(d.relations??[]).some(r=>r.type===relation)).map(d=>{
    let score=0;for(const w of words){const tf=d.tf[w]??0;if(tf)score+=Math.log(1+(data.docs.length-(data.df[w]??0)+.5)/((data.df[w]??0)+.5))*tf*2.2/(tf+1.2*(.25+.75*d.length/Math.max(1,data.average)));}
    return {d,score};}).filter(x=>!words.length||x.score>0).sort((a,b)=>b.score-a.score||a.d.id.localeCompare(b.d.id));
  // Diversity changes presentation order only: no result is discarded.
  const selected=[],overflow=[],counts=new Map();
  for(const item of ranked){const key=item.d.kind==='buffer'?item.d.source:item.d.id;const n=counts.get(key)??0;counts.set(key,n+1);(n<2?selected:overflow).push(item);}
  ranked.splice(0,ranked.length,...selected,...overflow);
  const result = {total:ranked.length,offset,next_offset:offset+limit<ranked.length?offset+limit:null,items:ranked.slice(offset,offset+limit).map(({d,score})=>{
    const {text}=d,clip=(v,n)=>String(v??'').slice(0,n),matchingLinks=links.filter(l=>l.from===d.id||l.to===d.id);
    // Search is a locator, not another full metadata/card read. Preserve exact IDs and refs.
    return {kind:d.kind,id:d.id,ref:d.ref,title:clip(d.title,160),summary:clip(d.summary,400),metadata_truncated:true,
      quality:(d.quality??[]).slice(0,6).map(v=>clip(v,240)),quality_total:(d.quality??[]).length,
      type:d.type,domains:(d.domains??[]).slice(0,6),score,
      ...(d.kind==='buffer'?{text,truncated:true,offset:d.offset,source:d.source,locator:d.locator}:selectPassages(text,words,500)),
      links:matchingLinks.slice(0,4).map(l=>({...l,note:clip(l.note,240)})),links_total:matchingLinks.length,
      expand:d.kind==='card'?'compile_read_card':'compile_read_material'};
  })};
  while(result.items.length>1 && Buffer.byteLength(JSON.stringify(result))>24000)result.items.pop();
  result.next_offset=offset+result.items.length<ranked.length?offset+result.items.length:null;
  return result;
}
const strings=v=>Array.isArray(v)?[...new Set(v.filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean))]:[];
function history(root,writes,id,ref,key) {
  const old=readFileSync(unoPath(root,ref));const version=sha(old);
  const backup='03-Archive/card-history/'+id+'/'+version+'.md';if(!existsSync(unoPath(root,backup)))writes.set(backup,old);
  return {version,ref:backup,key};
}
export function writeDomain(root, input) {
  const { key, id, revision = null, ...patch } = input;
  const fields = new Set(['title','summary','body','core_questions','includes','excludes','parents','representative_card_ids','relations']);
  if (!safeId(id) || Object.keys(patch).some(field => !fields.has(field))) throw new Error('领域 ID 或更新字段无效。');
  const ref = '01-Cards/_meta/domains/' + id + '.md';
  return transaction(root, key, input, () => {
    expect(root, { [ref]: revision });
    const known = new Map(listDomainsV2(root).map(domain => [domain.id, domain])), previous = known.get(id);
    if (previous && !activeDomain(previous)) throw new Error('不能修改退役领域。');
    const domain = { schema:'uno-domain-v2', kind:'uno-domain-index', lifecycle:'active', parents:[], representative_card_ids:[], relations:[], body:'', ...previous, ...patch, id };
    const contentChanged = !previous || Object.keys(patch).some(field => field !== 'relations');
    if (contentChanged) validateDomainDefinition(domain);
    if (typeof domain.body !== 'string') throw new Error('领域正文必须是 Markdown 文本。');
    for (const field of ['parents','representative_card_ids']) if (!Array.isArray(domain[field]) || domain[field].some(value => typeof value !== 'string' || !value.trim())) throw new Error(`领域 ${field} 必须是 ID 数组。`);
    if (domain.parents.some(parent => parent === id || !activeDomain(known.get(parent)))) throw new Error('父领域必须有效且不能指向自身');
    const visited = new Set();
    const walk = parent => { if (parent === id) throw new Error('领域层级形成循环'); if (visited.has(parent)) return; visited.add(parent); for (const ancestor of known.get(parent)?.parents ?? []) walk(ancestor); };
    domain.parents.forEach(walk);
    const cards = loadCards(root);
    if (domain.representative_card_ids.some(card => !cards.has(card) || cards.get(card).meta.type === 'domain')) throw new Error('领域代表卡必须是已发布卡片');
    validateDomainRelations(id, domain.relations, known, cards, previous?.relations);
    const writes = new Map();
    if (previous) history(root, writes, 'domain-' + id, ref, key);
    const { body, ref: _ref, revision: _revision, card_ids: _legacyMembers, ...meta } = domain;
    writes.set(ref, unoMarkdown(meta, body));
    return { writes, result:{ summary:'更新领域索引：' + domain.title, card_ids:[], domain_ids:[id] } };
  });
}
export function cardVersions(root,id){if(!safeCardId(id))throw new Error('卡片 ID 无效');const dir=unoPath(root,'03-Archive/card-history/'+id);return existsSync(dir)?readdirSync(dir).filter(n=>/^[a-f0-9]{64}\.md$/.test(n)).map(n=>({version:n.slice(0,-3),at:statSync(unoPath(root,'03-Archive/card-history/'+id+'/'+n)).mtime.toISOString()})):[];}
