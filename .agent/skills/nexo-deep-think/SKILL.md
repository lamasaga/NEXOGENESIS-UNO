---
name: nexo-deep-think
description: |
  Nexogenesis TM/OPS 执行压力测试。仅当用户明确要求「测试 TM/OPS」、
  「按固定步骤做执行压力测试」或使用 `/deep-think` 时触发；固定执行
  信息搜集、机制分析、受控认知偏移、结构类比、反例搜索、证据验收与任务收尾。只读知识体，
  不自动写卡。普通分析、日常问答和仅要求更详细的回答仍使用 nexo-talk。
compatibility: Nexogenesis 项目；需要 CognitiveRun、Thinking Model 与 GraphOps
---

# 目的与边界

  本 Skill 是专门的可观察执行测试，不是把回答写得更长。它检验模型能否在明确命令下选择指定 TM、实际调用 OPS、根据新观察改变下一步，并在证据不足时继续或停止。所有结论只留在对话；`max_writes=0`，不得调用知识写入、提案或捕获工具。

  本入口是 nexo-judge 的工具执行测试兼容入口；只在用户明确测试时使用。用户说「深入思考」「分析一下」「详细一点」或问题本身较难，仍由 nexo-talk 按共享分析契约分配预算，不自动升级为固定测试。

# 固定执行契约

> 阶段顺序用于测试命令服从与工具闭环。不能用内部概括、常识推演或最终长文替代真实 Observation；也不展示隐藏思维链，只向用户报告可核对的依据、反例、边界与执行收据。

1. **建立深度 Run**：调用 `start_cognitive_run(mode="general", skill="nexo-deep-think", complexity_level="deep")`。`scope.analysis_depth="iterative"`、`scope.structure_need="required"`、`scope.execution_profile="deep-think-v1"`，并在 `scope.complexity_reasons` 记录本题需要深入测试的理由。使用 Runtime 默认 48 步、24 次知识读取、0 次写入；预算是上限，不是必须耗尽的配额。
2. **选择专用 TM**：在任何知识观察前调用 `select_thinking_model(id="deep-inquiry")`。不得用其他 TM 冒充本流程；若模型或 Operator 不可用，记录真实阻断并结束，不得口头声称已经执行。
3. **搜集信息**：至少用两个有区分度的查询角度调用 `retrieve`，并根据第一次返回的角色覆盖与缺口设计第二次查询；不得在 `retrieve` 与 `graph_search` 间随机换入口。定位焦点后按 `suggested_args` 执行一次 `graph_walk(hops=2)`，并精读两跳新到达的卡。进入机制分析前至少精读三张不同卡片，整轮至少精读六张不同卡片。候选、上下文计划、标题与关系 note 都不是正文证据。
4. **思考分析**：先对焦点卡调用 `inspect_argument`，再对至少两张卡调用 `compare_cards`，比较问题所需的机制、脆弱性、缓冲、时间尺度、政策反应或反证。必要时用 `graph_path` 核验两个判断之间是否真的存在可解释路径。工具返回材料，不替模型裁决。
5. **受控认知偏移**：机制比较后必须且只需选择一种特殊 OPS。若焦点判断已有较密的支持链但反方不明，调用 `trace_support_to_tension`，沿 ready `supports` 入边回溯，直到首次遇到真实 `conflicts-with` 或 conflict 卡；若核心判断依赖一个可明确陈述的前提，或支持链已耗尽，调用 `probe_assumption_inversion`，同时提交原假设和它的真正反转版本。不得把同义改写当反转，也不得用词面反义制造关系。特殊 OPS 返回候选时至少精读一张再决定它是推翻结论、缩窄边界、增加竞争解释，还是没有形成有效挑战；空结果是合法结果，应保留 `stop_reason` 并继续后续阶段，不循环调用特殊 OPS 凑出“灵光”。
6. **类比联想**：完成受控认知偏移后，从一张适格的 model、claim 或 method 卡调用 `graph_analogize`。若返回跨领域同型候选，至少精读一张后才能使用类比；输出必须同时说明「对应结构」和「类比断裂点」。空结果也是有效测试结果，但必须明确知识图谱没有提供可用类比，不能用同领域词面相似替代。
7. **寻找反例**：类比阶段之后调用 `inspect_conflicts`；无直接冲突时，根据当前覆盖缺口改换否证性查询角度再次调用 `retrieve`。随后至少新增一次正文精读，并把可用证据标为 `counter`；不得把措辞差异或未知项伪装成反例。
8. **验收证据**：为核心判断分配稳定 `claim_id`，给精读地址标注 `support`、`counter`、`boundary`、`background` 或 `inference`。最后一次反例精读之后调用 `inspect_evidence_set`，必须同时出现 support、counter、boundary，且没有未覆盖的核心判断；随后调用 `verify_evidence_anchors`。若验收带来新缺口，返回相应阶段补读，再重新验收。
9. **检查与关闭**：调用 `inspect_cognitive_sufficiency`。未通过时只执行它给出的下一项最小行动，并在新增观察后重新检查；通过后只调用一次 `finish_cognitive_run(status="completed")`，提交同一组已核验锚点。预算用尽、连续三次定向观察无新增或必要工具不可用时，以 `blocked` 结束并保留缺口。

# 用户可见输出

  本流程同时遵守普通 deep 的工作记忆契约。最终验收前，用 `update_cognitive_workspace.hypotheses` 登记 1–8 个 `{id, statement, status, scope, uncertainty, anchors}`；status 区分 supported / inference / unresolved / rejected，scope 保留时期、地域、样本和方法边界。每次特殊 OPS 和类比，用 `extension.insight_reviews` 登记 `{operation_step, outcome, finding, anchors, next_check}`，operation_step 取真实返回的 observation.step；有候选须补读，类比附 mapping 和 break_point，声称 revised / narrowed / alternative 时用 challenge_step 指向后续真实反方或比较观察。无候选记 empty 或 inconclusive；本专用流程不能用 not_applicable 跳过其必需 OPS。读取是否充分看 reading.coverage 与完整 unit，不以工具名认定。

  依据结束工具返回的 working_memory 组织最终分析，不复述调用流水，不把未检验的类比或历史预测升级为实证结论。工作区只保存公开判断、证据和探索结果，不保存隐藏思维链。

  回答先给直接结论，再依次给出机制链、受控认知偏移的尝试与结果、知识库类比及断裂点、最强反例、适用边界与未知项。最后附一个简短的「执行收据」，只报告可观察事实：所选 TM、检索轮数、不同精读对象数、实际图跳数、特殊 OPS 及其停止原因、其余关键 OPS、证据角色是否齐全、完成门状态。不得输出隐藏思维链，也不得把工具调用次数当作答案质量本身。

# 成功与失败判据

- **通过**：`deep-inquiry` 被真实选择；两个检索角度、两跳图观察、机制检查、语义比较、一次特殊 OPS、特殊候选补读（若有）、跨域类比、冲突检查、反例补读、证据集合检查、锚点核验和充分性检查均留下有效 Observation；完成门接受 `completed`。
- **部分通过**：某个结构通道返回真实空结果，模型说明缺口、使用允许的替代检索并完成其余验收；不得伪造类比或冲突。
- **失败**：跳过阶段、为了得到惊奇结果反复调用特殊 OPS、把反转假设当成事实、调用被拒绝后仍声称成功、只有候选没有精读、把一般比较当成类比、没有反证或边界、未通过完成门便直接回答、完成后重复调用 finish。
