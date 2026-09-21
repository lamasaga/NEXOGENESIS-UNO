export const CARD_TYPES = Object.freeze([
  'conflict', 'entity', 'case', 'concept', 'method', 'mechanism', 'model', 'claim', 'phenomenon', 'undetermined'
]);
export const CARD_CLASSIFICATION_CONTRACT = 'ordered-single-type-and-domains-v2';
export const LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT = 'single-type-and-domains-v1';
export const LEGACY_SINGLE_CARD_TYPES = Object.freeze([
  'concept', 'claim', 'mechanism', 'model', 'method', 'phenomenon', 'case', 'entity', 'conflict'
]);

// The order is contractual: test each eligibility gate in sequence and stop
// at the first one the card's main knowledge function fully satisfies.
export const CARD_TYPE_PRECEDENCE = CARD_TYPES;

export const CARD_TYPE_LABELS = Object.freeze({
  concept: '概念', claim: '观点', mechanism: '机制', model: '模型', method: '方法',
  phenomenon: '现象', case: '案例', entity: '实体', conflict: '争议', undetermined: '未定'
});

export const MAX_CARD_DOMAINS = 3;
export const LEGACY_CARD_TYPE = 'domain';

export function isCardType(value) { return CARD_TYPES.includes(value); }
export function cardTypeLabel(value) { return CARD_TYPE_LABELS[value] ?? String(value || '未分类'); }
export function classificationContractForJob(job) {
  const contract=job?.card_classification;
  if (contract === undefined || contract === null || contract === '') return LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT;
  if ([CARD_CLASSIFICATION_CONTRACT,LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT].includes(contract)) return contract;
  throw new Error(`未知卡片分类契约：${contract}`);
}
export function cardTypesForClassificationContract(contract) {
  if (contract === LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT) return LEGACY_SINGLE_CARD_TYPES;
  if (contract === CARD_CLASSIFICATION_CONTRACT) return CARD_TYPES;
  throw new Error(`未知卡片分类契约：${contract}`);
}

export function classificationWorkflowSummary(contract = CARD_CLASSIFICATION_CONTRACT) {
  if (contract === LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT) return '分类字段只有 type 与 domains。type 必须单选：concept 概念、claim 观点、mechanism 机制、model 模型、method 方法、phenomenon 现象、case 案例、entity 实体、conflict 争议；按整张卡的主要知识结构选择一类。domains 只能从 compile_task domains 返回的领域目录选择，通常 1–2 个、最多 3 个；选择最具体领域，不同时填写父子领域，没有合适领域时用空数组，不能自行发明。不得写 tags/topics。完整解释和正反示例按需调用 compile_guide types。';
  if (contract !== CARD_CLASSIFICATION_CONTRACT) throw new Error(`未知卡片分类契约：${contract}`);
  return '分类字段只有 type 与 domains。type 必须按 conflict 争议 → entity 实体 → case 案例 → concept 概念 → method 方法 → mechanism 机制 → model 模型 → claim 观点 → phenomenon 现象 → undetermined 未定 的顺序逐项检查，只有满足该类全部最低条件才能命中，取第一个合格类型。phenomenon 必须有可观察对象与依据，不作无条件兜底；其他九类均不成立但内容仍完整、可独立阅读且可复用时才用 undetermined。不得为套入类型补写来源没有的结构。domains 只能从 compile_task domains 返回的领域目录选择，通常 1–2 个、最多 3 个；选择最具体领域，不同时填写父子领域，没有合适领域时用空数组，不能自行发明。不得写 tags/topics。完整门槛、正文骨架和正反示例按需调用 compile_guide types。';
}

export function normalizeDomainIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

export function domainCatalogRows(domains = []) {
  return domains.filter(domain => !['retired','archived'].includes(domain.lifecycle)).map(domain => ({
    id: domain.id,
    title: domain.title,
    summary: domain.summary ?? '',
    core_questions: normalizeDomainIds(domain.core_questions),
    includes: normalizeDomainIds(domain.includes),
    excludes: normalizeDomainIds(domain.excludes),
    parents: normalizeDomainIds(domain.parents),
    lifecycle: domain.lifecycle ?? 'active',
    revision: domain.revision ?? null
  }));
}

export function domainAncestors(catalog, id) {
  const byId = new Map(catalog.map(domain => [domain.id, domain]));
  const found = new Set();
  const visit = current => {
    for (const parent of normalizeDomainIds(byId.get(current)?.parents)) {
      if (found.has(parent)) continue;
      found.add(parent); visit(parent);
    }
  };
  visit(id);
  return found;
}

export function validateCardClassification({ type, domains }, catalog = [], allowedTypes = CARD_TYPES) {
  const issues = [];
  if (!Array.isArray(domains)) issues.push({ code: 'INVALID_DOMAINS', message: 'domains 必须是数组；没有合适领域时使用空数组。' });
  else {
    if (domains.some(id => typeof id !== 'string' || !id.trim())) issues.push({ code: 'INVALID_DOMAINS', message: 'domains 只能包含非空领域 ID。' });
    if (domains.some(id => typeof id === 'string' && id.trim().length > 100)) issues.push({ code: 'INVALID_DOMAINS', message: '领域 ID 最多 100 个字符。' });
    if (new Set(domains).size !== domains.length) issues.push({ code: 'DUPLICATE_DOMAIN', message: 'domains 不得重复填写同一领域。' });
  }
  const selected = normalizeDomainIds(domains);
  if (!allowedTypes.includes(type)) issues.push({ code: 'INVALID_TYPE', message: `type 必须是 ${allowedTypes.join('/')} 之一。` });
  if (selected.length > MAX_CARD_DOMAINS) issues.push({ code: 'TOO_MANY_DOMAINS', message: `domains 最多 ${MAX_CARD_DOMAINS} 个。` });
  const known = new Map(catalog.map(domain => [domain.id, domain]));
  for (const id of selected) if (!known.has(id)) issues.push({ code: 'INVALID_DOMAIN', message: `领域不存在或不在本次允许目录中：${id}` });
  for (const id of selected) {
    const ancestors = domainAncestors(catalog, id);
    const redundant = selected.find(other => other !== id && ancestors.has(other));
    if (redundant) issues.push({ code: 'REDUNDANT_DOMAIN', message: `已选择子领域 ${id} 时不要重复选择其父领域 ${redundant}。` });
  }
  return { type, domains: selected, issues };
}

export function classificationInstructions(catalog = [], contract = CARD_CLASSIFICATION_CONTRACT) {
  cardTypesForClassificationContract(contract);
  const allowed = catalog.length
    ? catalog.map(domain => `- ${domain.id}｜${domain.title}${domain.summary ? `：${domain.summary}` : ''}${domain.core_questions?.length ? `；核心问题：${domain.core_questions.join('、')}` : ''}${domain.includes?.length ? `；纳入：${domain.includes.join('、')}` : ''}${domain.excludes?.length ? `；排除：${domain.excludes.join('、')}` : ''}${domain.parents?.length ? `（父领域：${domain.parents.join('、')}）` : ''}`).join('\n')
    : '- 当前知识库尚未建立领域目录。此时 domains 必须为 []，不要自行发明领域。';
  const firstDomain = catalog[0]?.id;
  const childDomain = catalog.find(domain => normalizeDomainIds(domain.parents).some(parent => catalog.some(item => item.id === parent)));
  const parentDomain = childDomain ? normalizeDomainIds(childDomain.parents).find(parent => catalog.some(item => item.id === parent)) : null;
  const positiveDomainExample = firstDomain
    ? `{"type":"mechanism","domains":["${firstDomain}"]} —— 正文的主要问题确实属于目录中的 ${firstDomain}。`
    : '{"type":"mechanism","domains":[]} —— 当前目录为空，如实留空，等待建构阶段组织。';
  const secondPositiveExample = catalog.length > 1
    ? `{"type":"case","domains":["${catalog[0].id}","${catalog[1].id}"]} —— 只有正文确实同时服务这两个长期问题空间时才可多选。`
    : '{"type":"concept","domains":[]} —— 没有第二个确定适用的既有领域，不为凑分类而新增。';
  const hierarchyError = childDomain && parentDomain
    ? `{"type":"mechanism","domains":["${parentDomain}","${childDomain.id}"]} —— 已选子领域 ${childDomain.id}，不要重复选择其父领域 ${parentDomain}。`
    : '{"type":"mechanism","domains":["父领域","子领域"]} —— 若目录声明两者为父子关系，只保留更具体的子领域；示意名称不能照抄为领域 ID。';
  if (contract === LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT) return `【分类字段只有两个】
1. type：单值，只描述这张卡的主要知识结构。只能选 ${LEGACY_SINGLE_CARD_TYPES.join('/')}。
   - concept：定义、辨析一个概念；claim：提出可争论的主张；mechanism：解释条件如何沿链条产生结果；
   - model：组织多个变量或部件的结构；method：可执行的分析或操作步骤；phenomenon：可观察的稳定模式；
   - case：有具体主体、情境、过程和结果的实例；entity：人物、组织、制度或文书等对象；conflict：并列保存真实分歧。
2. domains：卡片属于哪些长期知识问题空间。只能从下列领域目录选择，通常 1–2 个，最多 ${MAX_CARD_DOMAINS} 个；选择最具体的适用领域，不同时填写其父领域。没有合适领域时返回 []，不得用书名、作者、章节名、临时关键词或新造 ID 代替。

允许的领域目录：
${allowed}

正确示例：
${positiveDomainExample}
${secondPositiveExample}

错误示例：
{"type":["claim","mechanism"],"domains":["第八章"]} —— type 不能多选，章节名不是领域。
${hierarchyError}
{"type":"model","domains":["not-in-catalog"]} —— 这个 ID 不在上方目录中，编译不能创建领域。`;
  return `【分类字段只有两个】
1. type：单值，只描述这张卡的主要知识结构。只能选 ${CARD_TYPES.join('/')}。

【必须依次执行的判定顺序】
先确定这张卡要保存的主要知识功能，再按下列顺序逐项检查。只有满足该类的全部最低条件才能命中；命中第一个合格类型后立即停止。正文仅提到某个对象、概念、案例、步骤或因果词，都不等于满足该类；不得为套入类型而补写来源没有的结构。

1. conflict（争议）：围绕同一可判定问题，至少有两个可识别的真实立场，它们在结论、解释或行动选择上确实不相容，并能说清分歧点及各自依据或代价。仅有比较、权衡、语义差异或不确定性不成立。
2. entity（实体）：主要目的是建立一个可持续识别的人物、组织、制度、文书或其他对象的身份档案；有稳定指称、身份边界与关键属性。只是提到专名或以某对象为话题不成立。
3. case（案例）：保存已发生的、有边界的具体实例；必须有可识别主体、时空或制度情境、实际过程和结果证据。假设场景、未实施方案、地名或机构名的出现不成立。
4. concept（概念）：概念或范畴本身是知识对象；必须说清定义、关键特征、适用范围以及与近邻概念的差异。仅使用一个术语不成立。
5. method（方法）：提供别人可复用的行动、研究或分析程序；必须有明确目标或输入、可执行且有顺序或规则的步骤、预期输出与适用条件。政策目标、原则口号、方向建议或任务清单不成立。
6. mechanism（机制）：解释结果如何生成；必须有起点条件、至少一个可说明的中间作用或传导环节、结果与成立边界。相关性、影响因素清单或“A 导致 B”一句话不成立。
7. model（模型）：以一套简化表示来解释、比较或推演现实；必须有明确组件或变量、组件之间的显式关系或运行规则、边界，且整体可在多个对象或情境中复用。分类表、目录、指标清单、政策任务体系或只有方框的“框架”不成立。
8. claim（观点）：主要价值是保存某个人物、学派、机构或来源对某问题的可争论命题，且归属对理解命题必不可少；应有命题、依据与适用条件。不是每个陈述句都是观点，编译者的综合摘要也不自动成为观点。
9. phenomenon（现象）：主要保存可直接或间接观察的状态、趋势、分布、差异或反复出现的模式；必须给出观察范围、时期、样本或具体实例中的至少一项依据。预测、建议、计划、来源背景或无法说明观察对象的综合文本不成立。
10. undetermined（未定）：该内容仍然是完整、可独立阅读且可复用的知识单元，但经过上述全部门槛后没有任何实质类型成立。“未定”是诚实保留，不是内容不完整或未读完的占位符。

2. domains：卡片属于哪些长期知识问题空间。只能从下列领域目录选择，通常 1–2 个，最多 ${MAX_CARD_DOMAINS} 个；选择最具体的适用领域，不同时填写其父领域。没有合适领域时返回 []，不得用书名、作者、章节名、临时关键词或新造 ID 代替。

允许的领域目录：
${allowed}

正确示例：
${positiveDomainExample}
${secondPositiveExample}

错误示例：
{"type":["claim","mechanism"],"domains":["第八章"]} —— type 不能多选，章节名不是领域。
${hierarchyError}
{"type":"model","domains":["not-in-catalog"]} —— 这个 ID 不在上方目录中，编译不能创建领域。`;
}

export function classificationReviewInstructions(catalog = [], contract = CARD_CLASSIFICATION_CONTRACT) {
  cardTypesForClassificationContract(contract);
  const allowedExample = catalog[0]?.id;
  const childDomain = catalog.find(domain => normalizeDomainIds(domain.parents).some(parent => catalog.some(item => item.id === parent)));
  const parentDomain = childDomain ? normalizeDomainIds(childDomain.parents).find(parent => catalog.some(item => item.id === parent)) : null;
  const correctReviewExample = allowedExample
    ? `候选卡 type=mechanism，正文完整解释“考核指标→行为选择→积压结果”，domains=["${allowedExample}"]，且正文确实属于该领域。应通过分类审核，即使正文还含一个地方案例。`
    : '候选卡 type=mechanism，正文完整解释“考核指标→行为选择→积压结果”，domains=[]。当前领域目录为空，应通过分类审核，不能要求模型发明领域。';
  const domainReviewError = childDomain && parentDomain
    ? `候选卡同时选择父领域 ${parentDomain} 与其子领域 ${childDomain.id}。应报告："只保留更具体的 ${childDomain.id}。"`
    : '候选卡选择 not-in-catalog，但该 ID 不在允许目录。应报告："删除不存在的领域；没有合适领域时使用空数组。"';
  if (contract === LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT) return `${classificationInstructions(catalog, contract)}

【审核如何判定】
- 先依据正文的主要结构判断 type，不因正文顺带包含案例、观点或机制词就增加类型；type 只能有一个。
- 再逐个检查 domains 是否真是正文长期讨论的问题空间；领域相近、同一书出现或关键词命中都不够。
- domains 为空不是错误；只有使用不存在的领域、超过三个、同时选择父子领域或正文明确不属于该领域时才报错。
- 审核只指出可验证的具体错误。不要把“可以再丰富”“可考虑增加领域”当作阻止保存的问题。

正确审核示例：
${correctReviewExample}

错误审核示例：
候选卡 type=case，但正文没有具体主体、情境、过程和结果，只提出一般判断。应报告："type 应改为 claim；正文是一项可争论主张，没有案例结构。"
${domainReviewError}`;
  return `${classificationInstructions(catalog, contract)}

【审核如何判定】
- 必须从 conflict 开始，按 conflict → entity → case → concept → method → mechanism → model → claim → phenomenon → undetermined 顺序逐项检查最低成立条件，并选择第一个完整满足且符合整张卡主要知识功能的类型。
- 不因正文顺带包含案例、观点、机制词或实体名就命中对应类型；type 只能有一个，不得用改名、换标签或补空话伪造成立条件。
- 只有满足可观察模式门槛时才能选 phenomenon；其他类型都不成立时选 undetermined，不得用 phenomenon 收纳计划、建议、来源背景或混合文本。
- 再逐个检查 domains 是否真是正文长期讨论的问题空间；领域相近、同一书出现或关键词命中都不够。
- domains 为空不是错误；只有使用不存在的领域、超过三个、同时选择父子领域或正文明确不属于该领域时才报错。
- 审核只指出可验证的具体错误。不要把“可以再丰富”“可考虑增加领域”当作阻止保存的问题。

正确审核示例：
${correctReviewExample}

错误审核示例：
候选卡 type=case，但正文没有具体情境、实际过程和结果，只保存某学者的可归属、可争论主张及依据。应报告："type 应改为 claim；归属对理解该命题必不可少，且没有案例的实际过程。"
候选卡 type=model，正文只列出政策目标与任务，没有组件间的显式关系、运行规则和可复用推理用途，其他实质类型也都不成立。若内容仍完整可复用，应改为 undetermined，不得改为 phenomenon 兜底。
${domainReviewError}`;
}
