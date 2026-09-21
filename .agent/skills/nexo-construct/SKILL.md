---
name: nexo-construct
description: 建构知识体：探索并整理卡片关系、合并重复、拆分混杂内容、精修表达与调整领域，让检索、机制比较、反例和边界更容易被发现。用户要求「建构」「/construct」「结构校准」或整理既有知识体时使用；不处理 Buffer 消化。
compatibility: Nexogenesis DSH；CognitiveRun / Thinking Model / GraphOps / HarnessGateway
---

# 目标与边界

  改善知识的使用质量，而不是提高连边率、缩短正文或清空问题队列。卡内表达、卡间关系和领域组织都是建构对象；丰富细节与减少重复可以同时成立。不得把独有证据、分歧或失效边界当作冗余删去。

  使用 construct 任务与当前授权。遵守用户指定范围；未指定时，从结构问题、内容质量、检索失败或领域组织中连续选择值得解决的局部问题；完成一项后依据观察决定下一项。每批最多三项是事务限制，不是整轮任务的工作量限制。不要默认逐张接入孤立卡，也不必等全库低层错误清零才探索；当前调整依赖的确定性错误应先处理。

  新建建构保留旧任务；继续入口沿用原任务、授权范围与预算。用 inspect_cognitive_workspace(view=backlog, cursor=...) 分页读取当前实例历次建构的问题、延期计划和待办；不继承旧目标、旧证据或旧裁决。recovery_review 仅提供上轮未闭合收据的有限线索。按当前卡片核查已落盘内容与待复核项，禁止把原操作重新提交当作恢复。

# 根据发现选择行动

  Skill 不规定工具调用顺序。先明确“什么知识难以找到、理解、比较或使用”，依据新观察调整方案；同一问题可以组合不同 TM 与多次单层操作，无关问题记入 deferred_items。每个局部计划保留检索验收和必要的写后复核预算，不把写入上限当作配额。

- 一般组织问题使用 `knowledge-organization`；关系裁决用 `relation-integrity-audit`，明确孤立卡任务用 `isolated-card-integration`，领域问题用 `domain-overload-diagnosis`，真实分歧用 `conflict-differentiation`，跨域比较用 `bridge-analysis`。适用方法已知时直接选择，可与启动合并；不确定时才查看 TM 目录，换镜头不抹去当前计划与未决问题。
- 完全孤立指没有卡间入出关系；已有领域归属仍是孤立。fully_isolated 与 without_relations 采用相同口径；无可推理关系另用 without_ready_relations，不能用已审项被过滤后的空队列宣称全库没有孤立卡。
- 结构扫描会报告超过50张卡只有同一非领域邻居的集中结构，区分无向邻接、向心边与论证出向两跳。计数只定位问题；比较中介机制、互补、反例与边界，不能自动反转边或为跳数补边。用 kinds=single_neighbor_concentration 可单独分页检查，不让旧债淹没本类问题。
- 用 `inspect_structure_issues`、`inspect_knowledge_quality`、`inspect_domain_members` 或 `inspect_unconnected_cards` 选少量候选。计数和篇幅只提示摩擦，不能自动决定合并或拆分。
- 用 `retrieve` 定位知识，用 `read_card` / `read_cards` / `read_card_unit` 读取正文。局部候选不足时用 `inspect_knowledge_gap` 查别名及完整正文深处的材料，必要时换措辞、沿相邻节点继续探索。未命中、截断、旧边不能证明知识不存在。
- 全文定位默认 any：空格分隔关键词、任一命中；all 要求同卡全部词，phrase 才是连续短语。零命中拆词或换别名；仍不足记录 evidence_gap，不宣称主题尚未编译。合理独立须实际阅读并比较列出的候选。
- `graph_walk` / `graph_path` 依问题选择 1–3 跳、方向与关系类型：论证用 argument，时序或影响背景用 context；领域节点用于成员组织，旧候选边不能充当多跳中介。
- 类比可用 `graph_analogize`，沿支持链找张力可用 `trace_support_to_tension`，条件反转可用 `probe_assumption_inversion`。仅在能回答当前不确定性时使用，精读候选并比较机制映射、差异和失效点；不强制每轮制造洞见。

# 从比较到调整

  不存在唯一正确动作。比较“保持原状、精修、补关系、合并、拆分、改归属或聚合”的收益与损失。涉及合并、拆分、精修或综合入口时，先读 [知识组织与验收契约](../../reference/construct-improvement.md)；涉及写入时遵守 [事务规则](../../reference/write-transaction.md)。卡片类型与正文按 [卡片契约](../../reference/card-contracts/ontology.md) 和 [正文结构](../../reference/card-contracts/body-structure.md)。当前任务的分类版本必须从任务状态读取；新建建构冻结 `ordered-single-type-and-domains-v2`，按 `conflict → entity → case → concept → method → mechanism → model → claim → phenomenon → undetermined` 严格判断，旧在途任务不得中途换口径。不一次加载所有类型正例。

  `plan_construct_improvement` 绑定已完整阅读的源卡、改善问题、未选方案、关键原文保留去向、受影响入边和 1–3 个检索验证短语。它不是新建卡要求，也不是固定流水线；用现有单层写入工具实施，方向改变先明确延期旧计划再重新判断。

- 关系修改：双方实际阅读并 `compare_cards`，用 `inspect_relation_case` 与 `simulate_relation_patch` 检查证据、反证、方向与边界，再 `propose_relation_patch`。keep/remove 只用于既有边，change 用于新增或修改，defer 是合法结果。
- 当前新写关系只使用 `specialization/supplement/contrast/challenge/analogy/example/application`。每条关系必须回答两端在什么具体维度上成立；两个因素共同解释结果不等于二者互相补充或质疑。类比不等于证明。实质反对意见不能靠加长 note 消除；高风险先收到风险结果，再做反对性复核，仍不成立就延期。
- 同书同源不是建立关系的充分条件。仅展示某框架被使用，不能证明框架有效；区分例证与应用，并区分来源明示的联系和 `basis=navigation` 的阅读导航。没有明确新增阅读价值时保留不连。
- 内容、合并或拆分：复用 `propose_write` 的 content / creation / sources / lifecycle 单层操作；关系迁移只用 `propose_relation_patch` 绑定裁决。每批最多三个紧密相关操作，不物理删卡，不夹带另一层字段。
- 领域归属：比较已有领域后用 `assign_domain_members` / `reassign_members`；归属关系不代替论证。只有知识功能确实错型才用 `propose_card_reclassification`。
- 建构不使用 `propose_semantic_patch`，不结算 Buffer，不擅自升成熟度或激活系统理论；发现未消化材料只记录线索。

# 工作记忆、复核与停止

  工作记忆围绕当前问题保留发现、已读对象、替代方案、保留锚点、验证基线、未决分歧和预算；不是操作流水账。运行事实与问题状态由工具维护，禁止手填 issue_ledger、成功计数、模拟或验收结果。

  每次写后检查受影响对象。孤立卡仍须用原 scope/card_ids 复验并 `record_structure_review`；无写入也要说明合理独立、近重复、错型、归属或具体证据缺口。局部改善计划用 `review_construct_improvement` 重跑同题定位、检查来源和保留锚点，并说明实际语义收益。程序通过不等于内容正确。

  已连边但发现领域、正文或重复问题尚未处理时，在 record_structure_review 的 follow_up 中记录具体对象与下一步；其它观察用 deferred_items。历史待办经重验确已处理或应排除时，用 deferred_items 保存 {backlog_id, status: resolved 或 excluded, reason}，保留原标识和具体依据；这只是待办处置，不代表知识写入成功。历史待办不自动扩大当前授权。不能只在关系 note 或过程文字里说“另行处理”。

  当前问题改善并复核或保持现状更合理时，结束该局部计划并选择下一项；一般建构不能仅因做完三项或一个计划就结束整轮。用户限定的小范围目标完成、范围内不再有值得实施的候选、关键材料仍未定位或预算不足时才收束。持续建构仍有未决事项时以 blocked 保存部分成果与具体待办，使用“继续此任务”接续；不得通过新建任务规避预算。部分调整必须如实延期并说明下一步，不能报告保持原状或完整合并。失败收据回到同一任务：读清原因后修正、换方案或缩小范围；不得原样重复、换 TM 绕过保护。真正需要用户选择时用 `request_user_choice` 并等待，不替用户扩展授权。

  最终用白话说明检查了什么、实际改善、保留不动的内容、语义不确定性和最多三项重要待办；写入成功与改善成功分开。过程说明侧重知识内容与判断，不逐条播报工具、内部编号或字段。全库没有、已穷尽、完全验证等结论必须有足够范围的证据。

领域说明与领域关系语义见[领域契约](../../../docs/design/knowledge-guidance/domains.md)，也可通过 `compile_guide(name="domains")` 按需读取。领域关系的 Gateway 保存与阅读基础已提供，但自动连域尚未接入当前建构工具，不能把普通卡片关系工具用于写领域关系。
