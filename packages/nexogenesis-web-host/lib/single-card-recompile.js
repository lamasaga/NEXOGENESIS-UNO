import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadCards, parseCardFile, invalidateKnowledgeSnapshot } from '../../nexogenesis-tools/lib/cards.js';
import { cardBodyInstructions } from '../../nexogenesis-tools/lib/harness/knowledge-quality.js';
import { unoCardRef, unoPath, unoRevision, readUnoUnit, readUnoReceipt, sha } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { HarnessGateway } from '../../nexogenesis-tools/lib/harness/gateway.js';
import { CARD_TYPES, validateCardClassification } from '../../nexogenesis-tools/lib/uno/card-classification.js';
import { validateSource, readDraft } from '../../nexogenesis-tools/lib/uno/drafts.js';
import { batchTask } from '../../nexogenesis-tools/lib/uno/construction-workflow.js';
import { buildDomainGovernancePackage, synchronizeUnassignedPool } from '../../nexogenesis-tools/lib/uno/domain-governance.js';
import { inspectBookUnit } from '../../nexogenesis-tools/lib/uno/book-sources.js';
import { isBookMaterialPath } from '../../nexogenesis-tools/lib/uno/book-paths.js';
import { bindProviderBudgetSession } from '../../nexogenesis-tools/lib/uno/request-budget.js';
import { readCompileJob, saveCompileJob } from '../../nexogenesis-tools/lib/uno/state.js';
import { assertBoundedModel, budgetStopCode } from './uno-orchestration.js';
import { broadcastGraphEvent } from './events-bus.js';
import { parseUnitJSON } from './unit-card-request.js';

export const SINGLE_CARD_RECOMPILE_CONTRACT = 'single-card-source-rewrite-v2';
const LEGACY_SINGLE_CARD_RECOMPILE_CONTRACT = 'single-card-source-rewrite-v1';
const CONTEXT_LIMIT = 60000;
const UNANCHORED_SOURCE_LIMIT = 24000;
const FIXED_FIELDS = ['id', 'sources', 'domains', 'relations'];
const TYPE_GUIDE = `type 只描述整张卡的主要知识功能，并依次选择第一个满足全部条件的类型：
- conflict：同一可判定问题上存在至少两个真实且不相容的立场；
- entity：建立可持续识别对象的身份、边界与关键属性；
- case：保存有主体、情境、过程和结果证据的已发生实例；
- concept：定义概念、关键特征、适用范围及近邻差异；
- method：给出目标或输入、可执行步骤、输出与适用条件；
- mechanism：说明起点条件、中间作用、结果与成立边界；
- model：给出可复用的组件、关系或运行规则及边界；
- claim：保存有明确归属、依据与条件的可争论命题；
- phenomenon：保存有观察对象和具体依据的状态、趋势或模式；
- undetermined：内容完整可复用，但以上类型均不成立。
不得为了命中类型补写来源没有的结构。`;
const BODY_GUIDE = cardBodyInstructions(CARD_TYPES);
const chars = value => Array.from(String(value ?? '')).length;
const user = text => ({ role:'user', content:[{ type:'text', text }] });
const fail = (message, code) => Object.assign(new Error(message), { code });

function activeJob(root, id, signal) {
  signal.throwIfAborted();
  const job = readCompileJob(root, id);
  if (!['unassigned-card-recompile','unassigned-card-domain'].includes(job.operation) || job.status !== 'running' || job.pause_requested || job.end_requested)
    throw fail('未组织池单卡任务已经停止，未执行新的写入。', 'SINGLE_CARD_JOB_STOPPED');
  return job;
}

function cardContent(card) {
  return { title:card.title, type:card.type, summary:card.summary, boundary:card.boundary, body:card.body };
}

function sourceBody(root, file) {
  if (isBookMaterialPath(file) && file.includes('/units/')) return inspectBookUnit(root, {book_units:[{ref:file}]}, file);
  if (file.startsWith('05-Buffer/')) return readUnoUnit(root, file);
  if (!file.endsWith('.md')) throw fail('当前来源不是可直接重编译的 Markdown 正文：' + file, 'SINGLE_CARD_SOURCE_UNREADABLE');
  return parseCardFile(unoPath(root, file));
}

function anchoredText(body, ref) {
  const anchor = ref.includes('#') ? ref.slice(ref.indexOf('#') + 1) : '';
  if (!anchor) {
    if (chars(body) > UNANCHORED_SOURCE_LIMIT)
      throw fail(`来源 ${ref} 没有局部锚点且超过 ${UNANCHORED_SOURCE_LIMIT} 字符；未发送整份长材料。`, 'SINGLE_CARD_SOURCE_TOO_BROAD');
    return body;
  }
  const range = /^char-(\d+)-(\d+)$/.exec(anchor);
  if (range) return Array.from(body).slice(Number(range[1]), Number(range[2])).join('');
  const marker = '^' + anchor, index = body.indexOf(marker);
  if (index < 0) throw fail('来源锚点已经失效：' + ref, 'SINGLE_CARD_SOURCE_CHANGED');
  const start = Math.max(0, body.lastIndexOf('\n\n', index) + 2);
  const next = body.indexOf('\n\n', index + marker.length);
  return body.slice(start, next < 0 ? body.length : next).replace(marker, '').trim();
}

export function singleCardSnapshot(root, job) {
  const id = job.scope?.[0], formal = loadCards(root).get(id);
  if (!id || !formal || formal.meta.type === 'domain' || (formal.meta.domains ?? []).length)
    throw fail('目标卡片已不存在、已退役或已不在未组织池。', 'SINGLE_CARD_SCOPE_CHANGED');
  const ref = unoCardRef(root, formal), revision = unoRevision(root, ref);
  const sources = [...new Set(formal.meta.sources ?? [])].map(sourceRef => {
    const binding = validateSource(root, sourceRef), unit = sourceBody(root, binding.file);
    return { ref:sourceRef, revision:binding.revision, title:unit.meta?.title ?? binding.file,
      locator:unit.meta?.locator ?? null, text:anchoredText(unit.body, sourceRef) };
  });
  if (!sources.length) throw fail('目标卡片没有可回查来源，未发送重编译请求。', 'SINGLE_CARD_SOURCE_MISSING');
  const sourceChars = sources.reduce((total, row) => total + chars(row.text), 0);
  if (sourceChars > CONTEXT_LIMIT)
    throw fail(`目标卡片的已绑定来源片段共 ${sourceChars} 字符，超过 ${CONTEXT_LIMIT} 字符；未截断或发送。`, 'SINGLE_CARD_CONTEXT_LIMIT');
  return { id, ref, revision, original:{ ...formal.meta, body:formal.body }, sources, source_chars:sourceChars };
}

function request(job, phase, system, context, sourceFragments, maxTokens, reasoningEffort) {
  const contextText = JSON.stringify(context), sourceText = sourceFragments?.length ? '已绑定来源片段：\n' + JSON.stringify({source_fragments:sourceFragments}) : '';
  const sourceChars=(sourceFragments??[]).reduce((total,row)=>total+chars(row.text),0);
  const otherChars = chars(system) + chars(contextText) + Math.max(0, chars(sourceText) - sourceChars);
  if (otherChars > CONTEXT_LIMIT) throw fail(`单卡重编译规则与卡片上下文共 ${otherChars} 字符，超过 ${CONTEXT_LIMIT} 字符；未发送。`, 'SINGLE_CARD_CONTEXT_LIMIT');
  if(sourceChars>CONTEXT_LIMIT)throw fail(`单卡重编译来源片段共 ${sourceChars} 字符，超过 ${CONTEXT_LIMIT} 字符；未发送。`,'SINGLE_CARD_CONTEXT_LIMIT');
  return { ...job.model_selection, reasoningEffort, system, messages:[user(contextText),...(sourceText?[user(sourceText)]:[])], tools:[], maxTokens,
    nexoPrompt:{phase}, unit_context:{source_chars:sourceChars, other_chars:otherChars} };
}

export function buildSingleCardRewriteRequest(job, snapshot) {
  const system = `你只处理一张已有知识卡。来源片段是事实依据，current_card 只是可能有问题的旧稿。
必须先重新识别来源中的知识对象，再从空白开始写出完整卡片；不能只补一段说明、换标题、改类型或调整元数据来冒充重编译。保留来源中的作者归属、限定条件、反例和不确定性，不把编译者综合写成原作者主张。卡片须可独立阅读，不写编译过程、修改说明或长篇原文摘录。
只重写 title/type/summary/boundary/body。卡片 ID、sources、domains 和 relations 由宿主绑定，不得输出或讨论；正文审核通过后，宿主会用独立请求和治理事务处理领域归属。
${TYPE_GUIDE}
正文按最终 type 使用以下完整骨架，每个段落都必须有实质内容：
${BODY_GUIDE}
能够重写时只返回 {"action":"rewrite","card":{"title":"...","type":"...","summary":"...","boundary":"...","body":"..."},"note":"本次重写所覆盖的知识对象"}。
只有来源缺失、不可读或根本不足以形成完整卡片时，才返回 {"action":"cannot_revise","reason":"具体阻碍"}。只输出 JSON。`;
  const context = { contract:SINGLE_CARD_RECOMPILE_CONTRACT, current_card:{ id:snapshot.id, ...cardContent(snapshot.original) }, source_refs:snapshot.sources.map(({text,...row})=>row) };
  return request(job, 'single-card-rewrite', system, context, snapshot.sources, 32768, 'low');
}

export function buildSingleCardReviewRequest(job, snapshot, candidate) {
  const system = `你是单卡重编译的独立审核人。只核对 supplied_candidate 是否依据 source_fragments 对 current_card 做了实质性的完整重写。
依次检查：知识对象是否准确；事实、作者归属、条件和边界是否受来源支持；type 与正文骨架是否匹配；标题、摘要和正文能否独立使用；是否只是表面增补或元数据调整；是否引入来源没有的结论。domains、relations、sources 和 ID 已由宿主冻结，不在本次审核范围。
按整段 source_fragments 判断来源支持，不要求候选沿用原文段落位置。来源明确支持的压缩、改写和在正文骨架中的重新组织不算问题。只有出现具体矛盾、来源外事实或因果关系、错误归属、遗漏必要限定、类型或骨架不成立、没有实质重写时才提出问题；如果一项修复需要联动多个字段，必须分别列出每个字段。每个问题必须给出完成修复所需的短证据，不能写泛泛建议。
通过时返回 {"decision":"approve","issues":[],"note":"通过依据"}；可局部修复时返回 {"decision":"repair","issues":[{"field":"title|type|summary|boundary|body","message":"具体问题和修改目标","evidence":"短证据"}],"note":"审核范围"}；来源不足以支持完整卡片时返回 decision="reject" 和具体 issues。只输出 JSON。`;
  const context = { contract:SINGLE_CARD_RECOMPILE_CONTRACT, current_card:{ id:snapshot.id, ...cardContent(snapshot.original) }, supplied_candidate:cardContent(candidate),
    source_refs:snapshot.sources.map(({text,...row})=>row) };
  return request(job, 'single-card-review', system, context, snapshot.sources, 8192, 'off');
}

export function buildSingleCardRepairRequest(job, candidate, issues) {
  const system = `只修复 supplied_candidate 中列出的 issues，并返回整张卡的完整替换内容。问题中的 evidence 是本次修复可使用的全部局部证据；没有原文、旧卡、其他卡片、领域目录或历史消息。
只允许改动 issues 明确列出的字段，未列出的 title/type/summary/boundary/body 必须原样保留；保留现有 type 和正文骨架，除非它们本身被列为问题。不得扩大问题范围，不得添加新知识对象、来源、关系或领域，不得输出修改说明。
只返回 {"action":"rewrite","card":{"title":"...","type":"...","summary":"...","boundary":"...","body":"..."},"note":"已处理的问题"}。只输出 JSON。`;
  return request(job, 'single-card-repair', system, { contract:SINGLE_CARD_RECOMPILE_CONTRACT, supplied_candidate:cardContent(candidate), issues }, [], 32768, 'low');
}

export function buildSingleCardVerifyRequest(job, candidate, priorIssues) {
  const system = `你只核对 repaired_candidate 是否逐项解决 prior_issues。问题中的 evidence 是本次核对可使用的全部局部证据；没有原文、旧卡、其他卡片、领域目录或历史消息。
不要重新审核未被 prior_issues 指出的内容，不要新增问题范围。全部解决时返回 {"decision":"approve","issues":[],"note":"逐项核对结果"}；仍有未解决项时返回 {"decision":"repair","issues":[{"field":"title|type|summary|boundary|body","message":"仍未解决的具体问题","evidence":"对应 prior_issues 的短证据"}],"note":"逐项核对结果"}。只输出 JSON。`;
  return request(job, 'single-card-verify', system, { contract:SINGLE_CARD_RECOMPILE_CONTRACT, repaired_candidate:cardContent(candidate), prior_issues:priorIssues }, [], 8192, 'off');
}

export function buildSingleCardDomainRequest(job, pack) {
  const card=pack.cards[0], candidates=new Set(card?.candidate_domain_ids??[]);
  const domains=pack.domains.filter(domain=>candidates.has(domain.id));
  const system=`你只处理一张已经完成正文审核、但尚无领域归属的正式卡片。根据 card 的知识对象和 candidate_domains 的核心问题、纳入边界与排除边界，判断它能否归入 1–3 个既有领域。
领域是长期问题空间，不按书名、章节名、作者名或表面词语归类。关系目标属于某领域只能作为线索，不能代替对当前卡正文的判断。优先选择最具体的领域；不能同时选择父领域和其子领域。不得改写卡片、创建新领域或输出候选列表之外的 ID。
有可靠匹配时返回 {"decision":"assign","domains":["既有领域id"],"reason":"卡片内容与领域边界的具体对应"}；没有可靠匹配时返回 {"decision":"defer","domains":[],"reason":"缺少匹配的具体原因"}。只输出 JSON。`;
  return request(job,'single-card-domain-review',system,{contract:SINGLE_CARD_RECOMPILE_CONTRACT,card,candidate_domains:domains},[],8192,'low');
}

function parseRewrite(text) {
  const value = parseUnitJSON(text);
  if (value.action === 'cannot_revise') {
    if (typeof value.reason !== 'string' || !value.reason.trim()) throw fail('无法重写的响应缺少具体原因。', 'INVALID_SINGLE_CARD_RESPONSE');
    return { action:value.action, reason:value.reason.trim() };
  }
  const card = value.action === 'rewrite' ? value.card : null;
  if (!card || typeof card !== 'object' || Array.isArray(card) || !CARD_TYPES.includes(card.type)
    || ['title','summary','boundary','body'].some(key => typeof card[key] !== 'string' || !card[key].trim())
    || typeof value.note !== 'string' || !value.note.trim())
    throw fail('单卡重写响应缺少完整 title/type/summary/boundary/body 或 note。', 'INVALID_SINGLE_CARD_RESPONSE');
  if (FIXED_FIELDS.some(key => Object.hasOwn(card, key))) throw fail('单卡重写响应越过了宿主冻结字段。', 'INVALID_SINGLE_CARD_RESPONSE');
  return { action:'rewrite', card:Object.fromEntries(['title','type','summary','boundary','body'].map(key => [key, card[key].trim()])), note:value.note.trim() };
}

function parseReview(text) {
  const value = parseUnitJSON(text), decisions = new Set(['approve','repair','reject']);
  if (!decisions.has(value.decision) || !Array.isArray(value.issues) || value.issues.length > 8 || typeof value.note !== 'string' || !value.note.trim())
    throw fail('单卡审核响应不符合 decision/issues/note 契约。', 'INVALID_SINGLE_CARD_REVIEW');
  const issues = value.issues.map(issue => {
    if (!issue || !['title','type','summary','boundary','body'].includes(issue.field) || typeof issue.message !== 'string' || !issue.message.trim()
      || typeof issue.evidence !== 'string' || !issue.evidence.trim()) throw fail('单卡审核问题缺少字段、具体说明或短证据。', 'INVALID_SINGLE_CARD_REVIEW');
    return { field:issue.field, message:issue.message.trim(), evidence:issue.evidence.trim().slice(0,1200) };
  });
  if ((value.decision === 'approve') !== (issues.length === 0)) throw fail('单卡审核决定与问题列表不一致。', 'INVALID_SINGLE_CARD_REVIEW');
  return { decision:value.decision, issues, note:value.note.trim() };
}

function parseDomainReview(text, pack) {
  const value=parseUnitJSON(text),card=pack.cards[0],allowed=new Set(card?.candidate_domain_ids??[]);
  if(!['assign','defer'].includes(value.decision)||!Array.isArray(value.domains)||typeof value.reason!=='string'||!value.reason.trim())
    throw fail('单卡领域核对响应不符合 decision/domains/reason 契约。','INVALID_SINGLE_CARD_DOMAIN_REVIEW');
  const domains=[...new Set(value.domains.filter(id=>typeof id==='string').map(id=>id.trim()).filter(Boolean))];
  if(value.decision==='defer'){
    if(domains.length)throw fail('暂缓领域归属时 domains 必须为空。','INVALID_SINGLE_CARD_DOMAIN_REVIEW');
    return {decision:'defer',domains:[],reason:value.reason.trim()};
  }
  if(!domains.length||domains.length>3||domains.some(id=>!allowed.has(id)))
    throw fail('单卡领域归属只能选择候选列表中的 1–3 个既有领域。','INVALID_SINGLE_CARD_DOMAIN_REVIEW');
  const classification=validateCardClassification({type:card.type,domains},pack.domains);
  if(classification.issues.length)throw fail('单卡领域归属未通过分类校验：'+classification.issues.map(issue=>issue.message).join('；'),'INVALID_SINGLE_CARD_DOMAIN_REVIEW');
  return {decision:'assign',domains:classification.domains,reason:value.reason.trim()};
}

function bindCandidate(snapshot, content) {
  return { ...content, id:snapshot.id, sources:[...(snapshot.original.sources ?? [])], domains:[...(snapshot.original.domains ?? [])],
    relations:(snapshot.original.relations ?? []).map(row => ({...row})) };
}

function substantive(candidate, snapshot) {
  const before = cardContent(snapshot.original), after = cardContent(candidate);
  if (after.body === before.body || isDeepStrictEqual(after, before))
    throw fail('模型没有重新编写正文；原卡保持不变。', 'SINGLE_CARD_NOT_REWRITTEN');
}

function validateRepairScope(before, after, issues) {
  const fields=['title','type','summary','boundary','body'], targeted=new Set(issues.map(issue=>issue.field));
  const changed=fields.filter(field=>before[field]!==after[field]);
  const expanded=changed.filter(field=>!targeted.has(field));
  if(expanded.length)throw fail(`局部修复改动了未被审核点名的字段：${expanded.join('、')}。原卡保持不变。`,'SINGLE_CARD_REPAIR_SCOPE_EXPANDED');
  const unresolved=[...targeted].filter(field=>before[field]===after[field]);
  if(unresolved.length)throw fail(`局部修复没有改动审核点名的字段：${unresolved.join('、')}。原卡保持不变。`,'SINGLE_CARD_REPAIR_NOT_APPLIED');
}

function stageCandidate(root, job, snapshot, candidate) {
  const task = batchTask(job), current = readDraft(root, task, snapshot.id);
  const payload = { task, key:`${task}:single-card-stage:${sha(JSON.stringify(cardContent(candidate))).slice(0,24)}`, action:'patch', id:snapshot.id,
    revision:current?.revision ?? snapshot.revision, title:candidate.title, type:candidate.type, summary:candidate.summary,
    boundary:candidate.boundary, body:candidate.body };
  const result = new HarnessGateway(root).stageUnoKnowledge(payload);
  return { result, draft:readDraft(root, task, snapshot.id) };
}

function saveWork(root, job, patch) {
  job.single_card_work = { ...(job.single_card_work ?? {}), ...patch, updated_at:new Date().toISOString() };
  saveCompileJob(root, job);
  return readCompileJob(root, job.id);
}

function settlePartial(root, job, detail, code, issues=[]) {
  job.status='partial';job.phase='done';job.error_code=code;job.detail=detail;
  const rows=(issues.length ? issues : [{message:detail}]).map(issue => ({ id:job.scope?.[0], kind:'single-card-recompile', code,
    detail:issue.message ?? detail, field:issue.field, evidence:issue.evidence, status:'open' }));
  job.issues=[...(job.issues ?? []).filter(row => row.kind !== 'single-card-recompile'),...rows];
  const published=job.single_card_work?.content_publication?[job.scope?.[0]].filter(Boolean):[];
  job.completed_batches=[{index:0,published,pending:1,at:new Date().toISOString()}];
  saveCompileJob(root,job);return job;
}

function addReceipt(job, receipt) {
  if(receipt&&!job.receipts.some(row=>row.key===receipt.key))job.receipts.push(receipt);
  return job;
}

function contentReceiptKey(job) {
  const revision=job.single_card_work?.draft_revision;
  return revision?`${batchTask(job)}:single-card-publish:${revision}`:null;
}

function recordedContentReceipt(root, job) {
  const key=contentReceiptKey(job);if(!key)return null;
  const receipt=readUnoReceipt(root,key),id=job.scope?.[0];
  return receipt?.publication?.cards?.some(row=>row.id===id)?receipt:null;
}

function domainReceiptKey(job, domains) {
  return `${batchTask(job)}:single-card-domain:${sha(JSON.stringify([...domains].sort())).slice(0,24)}`;
}

function recordedDomainReceipt(root, job) {
  const decision=job.single_card_work?.domain_review;
  if(decision?.decision!=='assign')return null;
  return readUnoReceipt(root,domainReceiptKey(job,decision.domains));
}

function completeSingleCardJob(root, job, detail) {
  const id=job.scope[0];job.touched=[...new Set([...(job.touched??[]),id])];job.outcomes[id]='published';
  job.completed_batches=[{index:0,published:[id],pending:0,at:new Date().toISOString()}];job.status='completed';job.phase='done';job.detail=detail;
  job.issues=(job.issues??[]).filter(row=>row.kind!=='single-card-recompile');delete job.error_code;saveCompileJob(root,job);return job;
}

function deferSingleCardDomain(root, job, decision, candidateIds=[]) {
  const id=job.scope[0],prefix=job.operation==='unassigned-card-domain'?'单卡仍未找到可靠的既有领域':'单卡正文已重写并发布，但尚未找到可靠的既有领域',detail=`${prefix}：${decision.reason}`;
  synchronizeUnassignedPool(root,{card_ids:[id],job_id:job.id,reason:decision.reason,candidate_domains:candidateIds});
  job.status='partial';job.phase='done';job.error_code='SINGLE_CARD_DOMAIN_UNRESOLVED';job.detail=detail;
  job.issues=[...(job.issues??[]).filter(row=>row.kind!=='single-card-recompile'),{id,kind:'single-card-recompile',code:'SINGLE_CARD_DOMAIN_UNRESOLVED',detail:decision.reason,status:'open'}];
  job.completed_batches=[{index:0,published:job.operation==='unassigned-card-domain'?[]:[id],pending:1,at:new Date().toISOString()}];invalidateKnowledgeSnapshot(root);saveCompileJob(root,job);return job;
}

async function organizeSingleCardDomain(ctx, root, job, signal, generate) {
  const target=loadCards(root).get(job.scope[0]);
  if(!target||target.meta.type==='domain'||(target.meta.domains??[]).length)return settlePartial(root,job,'目标卡片已不存在、已退役或已不在未组织池。','SINGLE_CARD_SCOPE_CHANGED');
  const ref=unoCardRef(root,target),pack=buildDomainGovernancePackage(root,[target.meta.id]),work=job.single_card_work??{},candidateIds=pack.cards[0]?.candidate_domain_ids??[];
  let domainReview=work.domain_review;
  if(!pack.cards.length||!candidateIds.length){
    domainReview={decision:'defer',domains:[],reason:pack.domains.length?'当前卡片与既有领域边界没有可靠匹配。':'当前知识库尚无可挂靠的正式领域；单张卡不足以创建稳定新领域。'};
    job=saveWork(root,job,{domain_review:domainReview});return deferSingleCardDomain(root,job,domainReview,candidateIds);
  }
  if(!domainReview){
    job.role='reviewer';job.phase='organize';job.detail='正在独立核对这张卡片的既有领域归属。';saveCompileJob(root,job);
    domainReview=parseDomainReview(await generate(ctx,root,job,buildSingleCardDomainRequest(job,pack),signal),pack);
    job=saveWork(root,readCompileJob(root,job.id),{domain_review:domainReview,domain_dependencies:{card_revision:pack.card_revisions[target.meta.id],domain_revisions:Object.fromEntries(domainReview.domains.map(domain=>[domain,pack.domain_revisions[domain]]))}});
  }
  if(domainReview.decision==='defer')return deferSingleCardDomain(root,job,domainReview,candidateIds);
  activeJob(root,job.id,signal);job=readCompileJob(root,job.id);
  const domainReceipt=new HarnessGateway(root).applyDomainGovernance({key:domainReceiptKey(job,domainReview.domains),assignments:[{card_id:target.meta.id,domains:domainReview.domains}],create_domains:[],
    expected_cards:{[target.meta.id]:job.single_card_work.domain_dependencies.card_revision},expected_domains:job.single_card_work.domain_dependencies.domain_revisions});
  addReceipt(job,domainReceipt);synchronizeUnassignedPool(root,{card_ids:[target.meta.id],job_id:job.id});invalidateKnowledgeSnapshot(root);
  const revision=unoRevision(root,ref);job=saveWork(root,job,{domain_publication:{domains:domainReview.domains,reason:domainReview.reason,receipt_key:domainReceipt.key,revision}});
  const prefix=job.operation==='unassigned-card-domain'?'单卡已归入既有领域':'单卡已依据来源完整重写、通过独立审核并归入既有领域';
  return completeSingleCardJob(root,job,`${prefix} ${domainReview.domains.join('、')}，已退出未组织池。`);
}

/** A stateless provider call: no tools, native agent history, evidence pack or compaction. */
export async function generateSingleCardResponse(ctx, root, job, request, signal) {
  activeJob(root, job.id, signal);assertBoundedModel(job, job.model_selection, ctx);
  const reviewer=request.nexoPrompt.phase.endsWith('review')||request.nexoPrompt.phase.endsWith('verify'),role=reviewer?'reviewer':'author';
  bindProviderBudgetSession(root,{jobId:job.id,sessionId:job.session_id,packageId:'single-card',role,
    stageId:request.nexoPrompt.phase,stageLimit:2,reviewReserve:2});
  const call={id:randomUUID(),phase:request.nexoPrompt.phase,role,batch:0,status:'running',started_at:new Date().toISOString(),context:request.unit_context};
  let current=readCompileJob(root,job.id);current.calls.push(call);saveCompileJob(root,current);
  broadcastGraphEvent(job.owner_session_id??job.session_id,{type:'work.updated',payload:{workflow:'compile',job_id:job.id,phase:request.nexoPrompt.phase,role}});
  let text='',finish;
  try{
    for await(const chunk of ctx.get('llm').stream({...request,sessionId:job.session_id,signal,nexoPrompt:{...request.nexoPrompt,root}})){
      signal.throwIfAborted();if(chunk.type==='text-delta')text+=chunk.text;if(chunk.type==='usage')call.usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason;
    }
    activeJob(root,job.id,signal);
    if(finish?.kind!=='stop')throw Object.assign(new Error(`模型响应未完整结束：${finish?.failure?.message??finish?.kind??'连接中断'}。原卡保持不变。`),{code:['max-tokens','length'].includes(finish?.kind)?'MODEL_OUTPUT_TRUNCATED':'MODEL_INCOMPLETE_RESPONSE'});
    if(!text.trim())throw fail('模型没有返回内容；原卡保持不变。','MODEL_EMPTY_RESPONSE');
    call.status='completed';return text;
  }catch(error){call.status=signal.aborted?'cancelled':'failed';call.error=error.message;throw error;}
  finally{call.finished_at=new Date().toISOString();call.response=text;current=readCompileJob(root,job.id);const index=current.calls.findIndex(row=>row.id===call.id);if(index>=0)current.calls[index]=call;saveCompileJob(root,current);
    broadcastGraphEvent(job.owner_session_id??job.session_id,{type:'work.updated',payload:{workflow:'compile',job_id:job.id,phase:request.nexoPrompt.phase}});}
}

export async function executeSingleCardRecompile(ctx, root, initial, controller, generate=generateSingleCardResponse) {
  const id=initial.id,signal=controller.signal,timer=setTimeout(()=>controller.abort(new Error('单卡重编译达到 30 分钟，已请求暂停。')),30*60*1000);
  try{
    let job=readCompileJob(root,id);job.status='running';job.phase='read';job.role='author';delete job.error_code;saveCompileJob(root,job);
    const organizeDomain=job.single_card_recompile_contract===SINGLE_CARD_RECOMPILE_CONTRACT;
    const formal=loadCards(root).get(job.scope?.[0]),formalDomains=formal?.meta?.domains??[];
    if(formalDomains.length){
      const domainReceipt=organizeDomain?recordedDomainReceipt(root,job):null,decision=job.single_card_work?.domain_review;
      if(domainReceipt&&decision?.decision==='assign'&&isDeepStrictEqual([...formalDomains].sort(),[...decision.domains].sort())){
        addReceipt(job,recordedContentReceipt(root,job));addReceipt(job,domainReceipt);job.single_card_work.domain_publication={domains:decision.domains,receipt_key:domainReceipt.key,revision:unoRevision(root,unoCardRef(root,formal))};
        return completeSingleCardJob(root,job,`单卡已依据来源完整重写、通过独立审核并归入既有领域 ${decision.domains.join('、')}，已退出未组织池。`);
      }
      return settlePartial(root,job,'目标卡片的领域归属已经变化，未覆盖当前正式版本。','SINGLE_CARD_SCOPE_CHANGED');
    }
    let snapshot=singleCardSnapshot(root,job),contentReceipt=recordedContentReceipt(root,job);
    const contentRow=contentReceipt?.publication?.cards?.find(row=>row.id===snapshot.id),contentPublished=contentRow?.revision===snapshot.revision;
    if(job.single_card_work?.base_revision&&job.single_card_work.base_revision!==snapshot.revision&&!contentPublished)
      return settlePartial(root,job,'正式卡在本次重编译期间已经变化，未覆盖新版本。','SINGLE_CARD_REVISION_CONFLICT');
    job=saveWork(root,job,{contract:job.single_card_recompile_contract??LEGACY_SINGLE_CARD_RECOMPILE_CONTRACT,target_id:snapshot.id,
      base_revision:job.single_card_work?.base_revision??snapshot.revision,source_bindings:snapshot.sources.map(row=>({ref:row.ref,revision:row.revision}))});
    if(contentPublished){addReceipt(job,contentReceipt);job=saveWork(root,job,{content_publication:{revision:snapshot.revision,receipt_key:contentReceipt.key}});}
    else{
      let work=job.single_card_work,candidate=work.candidate,review=work.review;
      if(!candidate){
        job.role='author';job.phase='read';job.detail='正在依据已绑定来源从头重写单张卡片。';saveCompileJob(root,job);
        const parsed=parseRewrite(await generate(ctx,root,job,buildSingleCardRewriteRequest(job,snapshot),signal));
        activeJob(root,id,signal);
        if(parsed.action==='cannot_revise')return settlePartial(root,readCompileJob(root,id),parsed.reason,'SINGLE_CARD_CANNOT_REVISE');
        candidate=bindCandidate(snapshot,parsed.card);substantive(candidate,snapshot);
        const staged=stageCandidate(root,readCompileJob(root,id),snapshot,candidate);
        job=readCompileJob(root,id);job=saveWork(root,job,{candidate:cardContent(candidate),author_note:parsed.note,draft_revision:staged.draft.revision,
          deterministic_issues:staged.result.issues??[]});work=job.single_card_work;
        if(staged.result.issues?.length){review={decision:'repair',issues:staged.result.issues.map(message=>({field:'body',message,evidence:'Gateway 确定性预检'})),note:'先修复确定性预检问题。'};
          job=saveWork(root,job,{review});work=job.single_card_work;}
      }else candidate=bindCandidate(snapshot,candidate);
      if(!review){
        job=readCompileJob(root,id);job.role='reviewer';job.phase='organize';job.detail='正在独立核对重写结果与来源。';saveCompileJob(root,job);
        review=parseReview(await generate(ctx,root,job,buildSingleCardReviewRequest(job,snapshot,candidate),signal));
        job=saveWork(root,readCompileJob(root,id),{review});work=job.single_card_work;
      }
      if(review.decision==='reject')return settlePartial(root,readCompileJob(root,id),review.note,'SINGLE_CARD_REVIEW_REJECTED',review.issues);
      if(review.decision==='repair'){
        let repaired=work.repaired_candidate;
        if(!repaired){
          job=readCompileJob(root,id);job.role='author';job.phase='read';job.detail='正在只按审核问题修复这张卡片。';saveCompileJob(root,job);
          const parsed=parseRewrite(await generate(ctx,root,job,buildSingleCardRepairRequest(job,candidate,review.issues),signal));
          if(parsed.action!=='rewrite')return settlePartial(root,readCompileJob(root,id),parsed.reason,'SINGLE_CARD_REPAIR_UNAVAILABLE',review.issues);
          repaired=bindCandidate(snapshot,parsed.card);validateRepairScope(cardContent(candidate),cardContent(repaired),review.issues);substantive(repaired,snapshot);
          const staged=stageCandidate(root,readCompileJob(root,id),snapshot,repaired);
          if(staged.result.issues?.length)return settlePartial(root,readCompileJob(root,id),'局部修复后仍未通过确定性预检，原卡保持不变。','SINGLE_CARD_REPAIR_INVALID',staged.result.issues.map(message=>({field:'body',message,evidence:'Gateway 确定性预检'})));
          job=saveWork(root,readCompileJob(root,id),{repaired_candidate:cardContent(repaired),repair_note:parsed.note,draft_revision:staged.draft.revision});work=job.single_card_work;
        }else repaired=bindCandidate(snapshot,repaired);
        if(!work.verification){
          job=readCompileJob(root,id);job.role='reviewer';job.phase='organize';job.detail='正在核对单卡修复是否解决原问题。';saveCompileJob(root,job);
          const verification=parseReview(await generate(ctx,root,job,buildSingleCardVerifyRequest(job,repaired,review.issues),signal));
          job=saveWork(root,readCompileJob(root,id),{verification});work=job.single_card_work;
        }
        review=work.verification;candidate=repaired;
        if(review.decision!=='approve')return settlePartial(root,readCompileJob(root,id),review.note,'SINGLE_CARD_VERIFY_REJECTED',review.issues);
      }
      activeJob(root,id,signal);job=readCompileJob(root,id);const task=batchTask(job),draft=readDraft(root,task,snapshot.id);
      if(!draft||draft.state!=='pending')return settlePartial(root,job,'待发布草稿没有通过确定性预检，原卡保持不变。','SINGLE_CARD_DRAFT_INVALID',draft?.errors?.map(message=>({message}))??[]);
      const approval={revision:draft.revision,note:review.note,issues:[]};job.reviewed={[snapshot.id]:approval};saveCompileJob(root,job);
      activeJob(root,id,signal);
      contentReceipt=new HarnessGateway(root).publishUnoKnowledge({task,key:`${task}:single-card-publish:${draft.revision}`,ids:[snapshot.id],reviews:{[snapshot.id]:approval}});
      job=readCompileJob(root,id);addReceipt(job,contentReceipt);job.touched=[snapshot.id];job.outcomes[snapshot.id]='published';
      const contentRevision=contentReceipt.publication.cards.find(row=>row.id===snapshot.id).revision;
      job=saveWork(root,job,{content_publication:{revision:contentRevision,receipt_key:contentReceipt.key}});invalidateKnowledgeSnapshot(root);
      snapshot=singleCardSnapshot(root,job);
    }
    if(!organizeDomain){
      synchronizeUnassignedPool(root,{card_ids:[snapshot.id],job_id:job.id});invalidateKnowledgeSnapshot(root);
      return completeSingleCardJob(root,job,'单卡已依据来源完整重写并通过独立审核，正式版本已更新；历史 v1 任务保留原有空领域行为。');
    }
    return await organizeSingleCardDomain(ctx,root,readCompileJob(root,id),signal,generate);
  }catch(error){
    const job=readCompileJob(root,id),budgetCode=budgetStopCode(error),code=budgetCode??error.code??'SINGLE_CARD_RECOMPILE_FAILED';
    if(signal.aborted||budgetCode){job.status='paused';job.detail=error.message;job.error_code=code;saveCompileJob(root,job);}
    else settlePartial(root,job,error.message,code);
  }finally{clearTimeout(timer);try{broadcastGraphEvent(initial.owner_session_id??initial.session_id,{type:'graph_changed',data:{}});}catch{}}
}

export async function executeSingleCardDomainOrganization(ctx, root, initial, controller, generate=generateSingleCardResponse) {
  const id=initial.id,signal=controller.signal,timer=setTimeout(()=>controller.abort(new Error('单卡领域整理达到 30 分钟，已请求暂停。')),30*60*1000);
  try{
    let job=readCompileJob(root,id);job.status='running';job.phase='organize';job.role='reviewer';delete job.error_code;saveCompileJob(root,job);
    const formal=loadCards(root).get(job.scope?.[0]),decision=job.single_card_work?.domain_review,receipt=recordedDomainReceipt(root,job);
    if(formal&&(formal.meta.domains??[]).length){
      if(receipt&&decision?.decision==='assign'&&isDeepStrictEqual([...(formal.meta.domains??[])].sort(),[...decision.domains].sort())){
        addReceipt(job,receipt);job.single_card_work.domain_publication={domains:decision.domains,receipt_key:receipt.key,revision:unoRevision(root,unoCardRef(root,formal))};
        return completeSingleCardJob(root,job,`单卡已归入既有领域 ${decision.domains.join('、')}，已退出未组织池。`);
      }
      return settlePartial(root,job,'目标卡片的领域归属已经变化，未覆盖当前正式版本。','SINGLE_CARD_SCOPE_CHANGED');
    }
    job=saveWork(root,job,{contract:'single-card-domain-assignment-v1',target_id:job.scope[0]});
    return await organizeSingleCardDomain(ctx,root,job,signal,generate);
  }catch(error){
    const job=readCompileJob(root,id),budgetCode=budgetStopCode(error),code=budgetCode??error.code??'SINGLE_CARD_DOMAIN_FAILED';
    if(signal.aborted||budgetCode){job.status='paused';job.detail=error.message;job.error_code=code;saveCompileJob(root,job);}
    else settlePartial(root,job,error.message,code);
  }finally{clearTimeout(timer);try{broadcastGraphEvent(initial.owner_session_id??initial.session_id,{type:'graph_changed',data:{}});}catch{}}
}
