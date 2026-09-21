---
scheme: "default"
version: "1.3.0"
updated: "2026-09-05"
---

# 分析契约：普通分析、研判与报告共用

## 新版试用分析：先看运行回执中的策略版本

  仅当宿主返回 `run.analysis_policy_version="conversation-v2"` 时，本节替代下文旧版的完成门、最少阅读数量、固定两跳和特殊探索复盘配额。策略由宿主冻结，不能用提示、Workspace 补丁或新建 Run 自行启用。旧运行、固定 deep-inquiry/judge 测试继续适用原验收；摄入和建构不受此节影响。

  先回应原问题，区分需要解释、比较机制、检验事实还是自由讨论。TM 提供观察角度，不是工具配额；预算、实际阅读、版本、原目标、实例边界和零知识写入仍是硬约束。重要验证没有做时明确“部分回答”，不能把“检验预测是否兑现”偷换为“介绍预测理论”。普通追问不自动延长上次研究；新实质问题由用户启动新回合，同题插入保留累计用量。

### 主动沿关系推理，不等待用户点名走图

  已读焦点显示隐藏前提、竞争解释、中介变量、适用边界或跨簇桥接时，主动考虑它能否改变哪一项判断。可以用 inspect_argument 定位关键依赖，用 graph_walk 的 focus_query、方向与平面探索，用 graph_path 比较具体端点；选择由新发现决定，不固定调用顺序或跳数。关键节点优先读取足够的机制 unit；没有价值的分支直接停止，不提交“不走图证明”。

  有价值的行为包括：追溯依赖、接合两个机制、比较竞争路径、将边界传播到真正依赖它的判断、检查跨簇组合或反馈。不能只并列卡片摘要：说明上一机制的输出为什么满足下一机制的输入条件；条件不相容就留下断点。

  对最终采用的关键跨越核对：对象和变量口径、关系方向和功能、国家/部门/时期/制度相容性、前提是否同时成立、同源与循环支持、结论力度。当前七类关系都只是带边界的阅读联系，不自动传递为证明；对照不等于冲突，质疑不等于推翻，例证和应用不等于有效性验证，类比不等于同构。历史卡中的 supports、involves、precedes、influences 等旧关系只按其原义兼容读取，也不得自动推出因果或证明。图中有环不等于自我强化，去重没有返回环也不等于不存在反馈。

  例如财富效应解释连接到债务泡沫、再读到权益/债务损失传播差别后，应缩小判断为“还要区分风险资本吸收与保证金、银行资本等约束”，而不是把访问三张卡称为三跳验证。作者转述对手不能写成对手自认；通用模型参数不能冒充中国实证；历史预测没有事后检验就仍是未检验。

### 有界收尾与公开论证结果

  用少量 hypotheses 保留会影响回答的判断、范围与未知；不要每步复写账本。准备回答时调用 finish_cognitive_run(status="completed", coverage="answered|partial|unanswered|unknown", evidence_anchors=最终引用, pending=原请求未完成项)，提交 changed/unchanged/stop_reason。新版在该工具内检查引用与证据结构，不再循环三项审计。无效引用明确保留为未核验；可补读、修正角色、撤回该声明或带缺口回答，不为消灭提示重复调用。

  真正改变判断的关系推理可选填 relation_findings（最多8项）：claim_id、path（实际访问顺序）、anchors（必要正文地址）、finding、conditions、outcome（composed/narrowed/alternative/unchanged/rejected/inconclusive）。程序关联真实 Observation 步骤和边，检查当前关系与正文阅读。它不是新增完成义务；没有采用的普通分支留在 Observation 即可。拒绝不恰当的接合也是有效结果。检查路径与阅读不代表认证语义，最终措辞仍须受条件约束。

  工具成功只表示 prepared，不是答案已交付或研究已证明。随后直接给用户答案，不继续自主探索；新增要求或修正判断会使快照失效，但不重置预算。同内容重试返回相同快照，不重复扣认知步骤；真正变化的检查受有界收尾额度限制。供应商额度耗尽不保证还能生成完整答案。

  宿主在真实回合结束后记录 closed（执行结束），按持久化完整消息另记 delivered；中断片段为 interrupted，无法确认则 unknown/未交付。正常带缺口回答不使用 blocked，blocked 只用于真实外部阻碍；真实待答问题仍是 waiting_user。不要为状态对账再次生成回答，也不把 prepared 核验宣称为全文认证。

## 旧版与固定测试的分析规范

  本文仅在 analytical 对话、assess 或 report 时加载。Skill 决定任务与交付形式；TM 组织审视问题的方法；OPS 返回观察；Runtime 管预算与验收；Harness 管知识写入。下一步由新证据与重要缺口决定，不运行固定语义流水线，不以调用数或耗时评价智能。

## 任务与资源

  每个实质问题建立一个 CognitiveRun，绑定当前 session、goal、scope。talk 显式启动时用 mode="general"、skill="nexo-talk" 与 complexity_level，Runtime 自动启用 iterative；assess/report 用对应 mode。简单聊天与窄问题不显式建 Run。同题只读侦察升级会保留检索与阅读，不覆盖原受控范围或待确认项；不同问题仍须结束旧任务后新建，不能通过重写目标复用旧完成状态。

| complexity_level | 选择依据 | 默认步数 / 读取次数 | 可申请范围 |
|---|---|---|---|
| light | 小范围、低风险但仍需分析核验 | 12 / 6 | 8–16 / 4–8 |
| standard | 常规比较、机制或条件判断 | 24 / 16 | 20–32 / 12–20 |
| deep | 明确深思、多机制多阶段、重要争议或高影响判断 | 48 / 24 | 40–60 / 20–32 |

  在 scope.complexity_reasons 留少量真实理由；档位是上限不是配额。分析写入额度恒为零；运行中不能降档绕过义务。检索、精读和探索共享预算，证据集合、锚点、充分性三类收尾审计共享最多三步尾部额度。deep 还为候选精读和验证预留 2–4 次读取；无信息收益时换向或结束，不自动提额。

## 根据发现选择方法与观察

  开始分析时选择一个主要 TM；已经知道适用方法时，在 start_cognitive_run 的 thinking_model 一并指定，不另做选择调用。机制解释用 mechanism-contrast，可靠性核对用 evidence-triangulation，条件分叉用 scenario-conditions；存在冻结前次判断才用 sequential-belief-update。不确定适用范围时才 list_thinking_models。普通“深入思考”使用这些方法，不触发 deep-inquiry；只有 /deep-think 或明确测试 TM/OPS 才走专用执行测试。

  方法应产生不同的分析内容，不只是不同的标题：机制比较要有动作链、竞争解释和区分它们的观察；证据核对要有来源依赖、最强挑战与可靠性边界；情景分析要有共同前提、分叉变量和触发信号。缺少材料时明确保留未知，不能用结构齐全冒充答案成立。

  新证据需要时可切换 TM，并用简短公开说明记录换向理由。同一问题内的精读仍可复用，最终锚点要核对当前版本；新 TM 的比较、来源、情景等专属观察仍需执行，不能用旧方法交差。重复选择同一版本不清空观察窗口。

  未定位焦点时用 retrieve，按[检索契约](retrieval-design.md)把问题转为具体 intent；标题、候选、路径与关系 note 不替代正文。关键材料用 read_cards、read_card 或 read_card_unit 精读，截断正文不能冒充全文。完整 Card 地址需全文覆盖，局部证据优先用完整 unit 地址；涉及重要数字、历史经验或归因时按需 trace_source。

  已有焦点后，凭什么成立用 inspect_argument，对象差异用 compare_cards，两点关系用 graph_path。需要结构推理时设 scope.structure_need="required"，执行两跳尝试并读新到达卡；图不足时记具体缺口，不凑边。历史演化使用 context，论证使用 argument，引用归因使用 reference，不能混成一条证明链。

## 让探索服务于重要缺口

  deep 在少量已读焦点上给意外发现一次机会；standard 有实际需要也可探索，不要求每轮有洞见。可选择支持链寻张力 trace_support_to_tension、关键前提反转 probe_assumption_inversion，或 graph_analogize。选择由“哪项判断可能因它改变”决定，不固定顺序，不要求全部调用。

  类比可提供 mechanism_query，使用焦点正文中的具体动作与条件寻找候选；允许同领域、跨类型比较，不要求已有边。工具只是词面与关系线索召回，不懂得自动证明机制同构。补读双方后说明角色、方向、条件的对应及 break_point；没有可比性就放弃，不制造潜在线边作为事实。

  信息不足时看 working_memory.exploration_budget：对 graph_walk.focus_query 写具体缺口，精读桥接卡后可从它继续 1–3 跳，或换 deferred_branches。单次三跳不是整题终点，但总预算不自动增长。连续无新增时优先消费已有候选、换角度或停止；阅读旧候选可能产生新认识，不算空转。

  特殊探索后在 extension.insight_reviews 保存 operation_step、outcome、finding、anchors、next_check；step 取工具实际 observation.step。有候选至少补读一个，结果可 unchanged/inconclusive，不把空结果当失败；空结果用 empty/inconclusive。确实不适用时可用 not_applicable，但须有完整精读的 focus_card、具体理由与 next_check。

  声称 revised/narrowed/alternative 时，claim_id 指向受影响的 hypotheses.id，challenge_step 指向探索后真实的定向检索、比较、论证、冲突或来源检查。finding 写清原判断与修订判断，next_check 说明挑战结果；类比另附 mapping 与 break_point。仅调用了挑战工具不保证语义有效，应检查其确实针对该项新判断。

## 判断、证据与收束

  deep 用 hypotheses 保存 1–8 个重要判断：id、statement、status、scope、uncertainty、anchors。标准分析形成需要综合的主张时也应保存少量判断，避免最终工作窗口只有材料、没有判断与证据对应。status 为 supported/inference/unresolved/rejected；scope 保留时期、地域、样本或制度条件。不在每次读取后记流水账，只在判断、证据或重要缺口改变时更新。

  为核心判断分配 claim_id，并给精读地址标 support/counter/boundary/background/inference。explanation 简述原文怎样支持、否定或限定它，尤其 counter 要说明真正被否定的环节。竞争机制不一定互斥，背景事实不是反例，同源章节不构成独立验证。库内观点只能支持“该理论如何解释”，不能自动支持无条件的现实规律。

  inspect_evidence_set 的 role_review_needed 与工作窗口 evidence_cautions 提示尚未解释的反证；针对它补充真实语义理由或改正角色，不靠增加卡数消除提示。该检查只要求可审阅解释，不能自动证明解释正确。

  准备交付时优先一次提交 finish_cognitive_run(status="completed", audit_evidence=true, evidence_anchors=最终同组证据)。程序顺次执行证据集合、锚点和充分性三项确定性审计，每项仍有独立 Observation、权限与预算检查；缺口返回后由模型补证或修订判断，不原样重试。需要中途诊断或固定执行测试时仍可单独调用 inspect_evidence_set、verify_evidence_anchors、inspect_cognitive_sufficiency。轻量至少读一对象、标准至少两对象、deep 至少四对象；deep 需支持和边界，并有真实反例或有依据的挑战未果记录。不得通过改角色、删核心问题或填无关证据凑通过。

  若认真挑战仍未找到反例，普通分析可在 extension.challenge_reviews 记录 {claim_id, operation_step, outcome:"not_found", finding, limitation}；operation_step 指向实际定向 retrieve/inspect_conflicts/inspect_argument/probe_assumption_inversion。只意味着此次检查未定位，不等于反例不存在或结论得到证明。专用执行测试仍遵从其固定验收，不以此跳过测试。

  finish 同时提交 changed/unchanged/pending，通过后直接回答用户；不再为确认成功重读工作区。选择单独审计时，最后用未变更的证据收束，不必再启用合并审计。证据或预算不足时以 blocked 收束，并交付可支持的局部判断及具体缺口；任务受阻不等于不给用户任何帮助。不得把受限结论写成完整证明，也不得完成后继续工具流水。

## 工作记忆与日常表达

  普通过程回执只返回 working_memory 的进度、待办、预算和证据提醒，避免反复复制同一摘录与账本；finish 返回完整的有界综合窗口。中途需要整合或恢复时用 inspect_cognitive_workspace(view="memory")，排查原始状态才用 view="full"。已知的 1–3 张待读卡可合并 read_cards；覆盖按实际完整对象核对，截断仍需补读，不为满足调用次数拆成多轮。

  完整 working_memory 按判断聚合证据、反例/边界摘录、解释与未知，保留本轮精读和探索。它是 Episode/Workspace 的派生窗口，不是新知识库，也不是已替换整个模型上下文的独立写作调用。窗口裁剪有提示；重要材料未保留时用明确地址补读并重新核验，不能假装全部正文都在窗口内。只在判断或重要缺口改变时更新 Workspace，不复制工具已维护的运行账本。

  最终回答依据[交付契约](thinking-output-contract.md)：先回答问题，保留最有辨识力的依据与边界，不复述工具调用。摘要的确定性不能高于材料；少用“必然”“几乎总是”“决定一切”等无法支撑的概括。下一步只给一两项真正有价值的选择，不将每轮分析都变为报告或保存邀请。

  用户明确要保存思想时，结束只读分析后转 nexo-emerge；明确修订既有卡则转 nexo-refine。继承讨论的原意、来源线索与未决条件，但按当前卡复查新建/丰富，实际写入必须用户确认。

## 状态边界

  CognitiveRun 保存任务，Workspace 保存公开判断、证据和待办，Episode 保存可审计操作；都不保存隐藏思维链，不自动成为知识事实。跨会话自动注意力、策略学习与自动晋升尚未实现；attention.yaml 仍是历史模板。编译、消化和建构使用自己的任务与工作窗口，不套用普通分析义务。
