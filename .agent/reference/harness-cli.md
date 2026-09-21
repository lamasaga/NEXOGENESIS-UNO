---
scheme: "default"
version: "2.0.0"
updated: "2026-09-17"
---

# DSH Harness 与认知工具参考

  文件名为兼容旧索引保留。当前 DSH 不依赖 `python -m nexogenesis` CLI；模型可执行能力全部通过 DSH 原生工具目录暴露，参数以运行时 JSON Schema 为准。

## 认知运行时

| 工具 | 作用 |
|---|---|
| `start_cognitive_run` | 显式 general 的 nexo-talk 或 complexity_level 自动启用分析；同题只读侦察可保留观察并升级，不覆盖待确认项；可选 thinking_model 合并选择 |
| `inspect_cognitive_workspace` | view 默认为 brief；memory 返回有界综合窗口，full 排查完整状态；没有任务时不隐式创建 Run |
| `update_cognitive_workspace` | 更新假设、证据、反证、未知项、候选和待办 |
| `list_thinking_models` | 列出可版本化思考模型 |
| `select_thinking_model` | 为当前状态选择或切换思考模型 |
| `inspect_operator_contracts` | 查看 Operator 能力、模式、风险和成本 |
| `finish_cognitive_run` | 以改变、未改变、待办和停止理由结束并返回完整有界工作记忆；分析任务可用 audit_evidence=true 在一次调用内完成三项独立审计，失败仍拒绝完成 |

## 单元编译

材料选择器为新任务创建 `uno-unit-compile-v3`。宿主直接调用模型服务，book_read_source/read_cards/save_cards/progress 的原生工具循环已经移除。每次生成请求完整提交一个 Markdown 单元，并附最多 3 张完整旧卡与 5 张导航摘要；例行审核只提交候选卡与必要关系目标。审核输出必须区分 `card` 与 `relation`：单卡修复只提交问题卡和具体问题，关系修复额外提交明确且已完整核对的端点卡并只允许修改 `relations`。模型返回 `type + domains` 卡片 JSON，程序通过 HarnessGateway.checkBookCards 和 saveBookCards 校验并保存。生成与审核提示词均包含字段说明、正文骨架及正反例。编译按环节使用固定思考策略，不继承普通对话深度；生成达到输出上限时保留完整候选，恢复只请求剩余卡。历史 v2 任务按保存的旧请求契约恢复。

详细契约见 [单元编译](../../docs/UNO-单元编译实施.md)。

## 通用只读知识工具

| 工具 | 作用 |
|---|---|
| `list_inbox` / `read_inbox` | 列出原始材料或作有限预览，不创建编译任务 |
| `list_buffer` / `read_buffer` | 查看历史质料；不冻结消化范围，不登记贡献结算 |
| `retrieve` / `graph_search` | 统一联合召回与高级元数据筛选 |
| `read_card` / `read_cards` | 阅读当前卡片；返回真实阅读覆盖和有界正文 |
| `list_card_units` / `read_card_unit` / `search_card_units` | 定位已有卡片的语义单元 |
| `list_domains` | 获取当前领域信息 |

## 建构与图操作

| 工具 | 作用 |
|---|---|
| `retrieve` | 普通问题的统一首轮入口：直接召回、最多两跳 ready 图候选与可解释上下文计划 |
| `graph_search` | 与 `retrieve` 共享引擎，仅补充类型、成熟度、来源与学派等高级筛选 |
| `graph_walk` | 沿论证、情境或对象引用平面受控观察 1～3 跳邻域、完整路径或冲突；总量最多 24 |
| `trace_support_to_tension` | 兼容读取历史图：从核心判断沿旧 `supports` 入边回溯并寻找旧冲突语义；当前七类关系不被机械换算成支持链，空结果保留停止原因 |
| `probe_assumption_inversion` | 接受模型明确给出的原假设与反转假设，召回真实待核验候选；不判断反转成立、不创建关系，候选须精读 |
| `inspect_entity_candidates` | 核对模型已识别对象的既有实体、跨卡出现、来源与领域分布；只读，不做全库正则抽取 |
| `graph_members` / `inspect_domain_members` | 查看领域隶属及构成摘要 |
| `inspect_structure_issues` | 按 P0–P3 分页扫描结构问题，去重并返回稳定问题指纹；不读全库正文 |
| `inspect_unconnected_cards` | 按优先级分页列出未接入卡，默认跳过当前指纹下已审项；指定 card_ids 时仅检查指定对象，counts_scope 区分局部与全库计数 |
| `inspect_integration_candidates` | 以 E1–E3 信号召回少量候选端点；共同领域与词面接近不计为写入证据 |
| `inspect_relation_case` | 组装端点语义、来源、当前方向、互指、路径、邻域、镜像与移除影响 |
| `simulate_relation_patch` | 记录 keep/change/remove/defer 裁决并模拟确定性错误、路径、枢纽、跨域和 conflict 风险 |
| `record_structure_review` | 保存绑定 Card 指纹的结构处置；只写可重建运行记录，不写知识卡 |
| `graph_analogize` | 类比候选发现；可选 mechanism_query 以已读焦点机制线索寻找同领域/跨类型候选，仍需精读比较，不证明同构 |
| `simulate_split_domain` | 无写入领域拆分模拟 |
| `reassign_members` | 1–3 个成员的 membership 提案 |
| `propose_domain_retirement` | 空领域 lifecycle 退役提案 |
| `propose_relation_patch` | 从磁盘合并最新卡片，只增改或移除一条已核验证据的关系 |
| `propose_card_reclassification` | 保留来源与结构元数据，校验完整新类型正文及全部入出边后提出类型修正 |
| `propose_write` | 通用单层微变更提案；普通对话中 system 新卡必须提供非空 sources，仍须核对来源真实性与用户确认 |
| `graph_note` | 记录可重建结构债 |

  `graph_walk` 可传 `focus_query` 描述本次缺口，在真实关系内优先选取相关候选，并通过 `deferred_frontier` 保留未展开的 ready 分支。单次仍最多三跳/24 节点；补读桥接卡后可以另一次继续。`working_memory.exploration_budget` 提供建议前沿和资源余量，`exploration_read_reserve` 要求停止扩张并使用余量精读和验证；不自动执行下一步，不增加预算。

  建构写入前必须选择 Thinking Model，并已有真实结构 Observation 与 Workspace 候选操作。关系层还必须有同版本关系案件和通过的写前模拟；高风险调整要在第二次反对性复核后才能进入 Harness。`graph_walk` 收到领域卡时会自动切换为成员观察；这种纠正不属于图谱通道故障。最后一次写入后必须用原检测器和问题指纹复核同一对象。结束回执同时给出问题的发现、修复、排除、延期、开放、重新打开和写后新增错误。

## 建构局部改善

| 工具 | 参数要点 | 返回与边界 |
|---|---|---|
| `inspect_knowledge_gap` | `queries`：1–4 组概念或别名；可选 `limit`、`match_mode: any/all/phrase` | 通用只读，不限建构；受预算与工具范围约束。`not_located` 不表示不存在，rejected 表示未执行 |
| `plan_construct_improvement` | `kind`、`problem`、`benefit`、`card_ids`、`target_ids`、`alternatives`、`preservation`、`probes`；可选 `retire_ids` | 当前版本完整阅读后记录计划、入边与定位基线；不写卡 |
| `review_construct_improvement` | `outcome: verify/defer/keep`、`reason` | 检查结果、原文锚点、来源、入边和同题定位；语义收益仍为模型判断 |

  合并与拆分使用现有单层工具，不另设批处理写入器。建构关系只能经 propose_relation_patch，并与对应模拟的端点、类型、动作和说明一致；普通 propose_write 不再代办建构关系。退役有活跃入边的卡会被 Gateway 拒绝；退役文件仍可按精确旧 ID 读取，不进入活跃检索，也没有自动跳转。详细判断与撤回边界见 [知识组织与验收契约](construct-improvement.md)。

## Web / Harness 接口

| 接口 | 作用 |
|---|---|
| `POST /api/write/confirm` | 用户确认或拒绝；Receipt 回流原 session |
| `GET /api/cognition/runs/:id` | 查看 run、Workspace、Episode 与自然语言投影 |
| `POST /api/cognition/runs/:id/steer` | 在不中断 run 的情况下加入用户方向 |

  ORG 的 Python CLI 只在迁移测试中作为历史行为与算法来源使用，不得从 DSH Skill 中调用，也不得与 HarnessGateway 形成第二套写入权威。

## 领域说明与关系

`compile_guide(name="domains")` 读取领域契约与示例。宿主的 `HarnessGateway.writeDomain({key,id,revision,...fields})` 可以修订领域定义或出向 `relations`；省略字段保留，更新必须携带版本，事务保留历史。此方法尚未暴露为自动建构写入工具，不可声称已有自动连域能力。详细参数见[领域契约](../../docs/design/knowledge-guidance/domains.md)。
