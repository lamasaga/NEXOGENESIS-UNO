import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { chars } from './unit-card-request.js';

const user = text => createUserMessage({ source:{ kind:'user' }, content:[{ type:'text', text }] });

const SYSTEM = `你负责一次有界的领域治理检查点。领域是跨材料、可长期扩充、能说明核心问题与边界的知识问题空间；不是书名、章节、作者、临时关键词或论证关系。
只输出一个 JSON 对象，不输出代码围栏、过程说明或其他文字：
{"assignments":[{"card_id":"卡片id","domains":["既有领域id"],"reason":"为什么属于这些领域"}],"proposals":[{"proposal_id":"安全英文id","id":"领域安全英文id","title":"领域名","summary":"一句话范围","core_questions":["长期核心问题"],"includes":["纳入边界"],"excludes":["排除边界"],"parents":["既有父领域id"],"representative_card_ids":["最多5张本批卡"],"member_card_ids":["至少3张本批卡"],"closest_domains":["最接近既有领域id"],"why_new":"为什么不能挂入既有领域","alternative":"不建域时如何处理"}],"unassigned":[{"card_id":"卡片id","reason":"为何暂缓"}]}。
每张输入卡必须且只能出现在 assignments、某一个 proposal.member_card_ids 或 unassigned 中。
assignments 只能选择该卡 candidate_domain_ids 中的 1–3 个既有领域；宁可留空待组织，也不要按词面相似强行挂靠。若同时选择父领域和子领域，只保留最具体项。
自动发现的新领域至少需要 3 张围绕同一稳定问题的卡。优先要求跨两个来源或独立材料单元；材料不足时可以提案，但必须在 why_new 说明证据限制。不得创建“其他”“综合”、书名或章节领域。
提案由宿主按本任务授权批准，不能声称已经创建领域或修改卡片。
说明必须可供独立阅读：summary 说明对象与问题，不重复名称；core_questions 写长期可追问的问题；includes 写归属依据；excludes 写容易混入的相邻内容及边界。不重复生成正文，不为了图谱连通生成领域关系。
完整说明正例：{"title":"组织治理与授权","summary":"研究正式组织如何配置决策权、信息与责任，以及这些安排对执行的影响。","core_questions":["哪些信息条件适合集中或分散决策？","授权后如何设置责任与反馈？"],"includes":["组织层级中的授权、激励、监督与信息反馈机制"],"excludes":["仅列出机构名称而不分析组织机制的材料","不涉及正式组织安排的个人决策技巧"]}。代表卡只选输入中实际存在且有代表性的 ID，尚无合适项时可以为空。
正例：三张分别讨论中央地方授权、行政发包和运动式治理的卡，可提议“国家治理与组织制度”，并排除只记录单项政策的材料。
反例：因为十张卡来自同一本《某某经济学》，建立“某某经济学”领域；或把每个卡片标题直接改写成一个领域。`;

export function buildDomainGovernanceRequest(job, pack) {
  const payload = structuredClone(pack);
  let text = '本次未组织卡、正式领域目录及版本快照：\n' + JSON.stringify(payload), total = chars(SYSTEM) + chars(text);
  if (total > 60000) {
    for (const card of payload.cards.toReversed()) {
      if (!Object.hasOwn(card, 'body')) continue;
      delete card.body; card.delivery = 'summary';
      text = '本次未组织卡、正式领域目录及版本快照：\n' + JSON.stringify(payload); total = chars(SYSTEM) + chars(text);
      if (total <= 60000) break;
    }
  }
  if (total > 60000) throw Object.assign(new Error(`领域治理上下文 ${total}/60000 字符；未截断或发送。`), { code:'DOMAIN_CONTEXT_LIMIT' });
  return { ...job.model_selection, reasoningEffort:job.workflow_reasoning?.domain ?? 'low', system:SYSTEM, messages:[user(text)], tools:[], maxTokens:32768,
    nexoPrompt:{phase:'domain-governance'}, unit_context:{source_chars:0,other_chars:total} };
}
