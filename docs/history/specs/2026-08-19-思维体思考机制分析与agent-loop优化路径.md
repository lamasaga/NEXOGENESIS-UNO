# 思维体思考机制分析 · GRAPHOPS 移植评估 · agent-loop 优化路径

> 日期：2026-08-19
> 状态：分析 + 可行性评估（供决策，非实施计划）
> 更新（2026-08-19 晚）：上游 v2.2 GraphOps 思考循环已入库（`dd41a0b`）；**P1 已移植完成**（graph_search / graph_walk / graph_members / graph_analogize / graph_note + read_card slots + 观察学分，见 §3.1）。
> 关联：`thinking-body.md`（S0–S4 设计）、`retrieval-design.md`（双轨检索）、融合设计 §4

---

## 1. 当前架构下思维体究竟如何思考（NEXO-DSH 现状）

### 1.1 运行载体：DSH agent-loop 会话

```
Web UI → POST /api/chat/stream → session.prompt（mode: queue）
       → DSH agent-loop：turn = 用户消息 → 系统提示组装 → 模型请求
         → 工具调用步（可多步） → 工具结果回灌 → turn 结束
       → 事件流（agent/*、tool/call、tool/result、turn/end）
       → 兼容层 SSE 桥 → 前端激活引擎（图谱认知运动）
```

- **系统提示** = 部署 persona（被 preset persona 遮蔽：宪法/检索纪律/写入纪律/M5 能力）+ web-surface 段 + 按需加载的 nexo-* 技能内容。
- **每步思考**：模型在上下文上推理 → 结构化工具调用（JSON Schema，无文本协议解析错误）→ 结果回灌 → 下一步或收尾。

### 1.2 思考的实际管道（每轮真实发生什么）

1. **意图分派**：技能按需加载——talk/emerge/assess/refine/report/compile/digest/construct 九个 SKILL.md 中选一。
2. **检索（纪律：先检索）**：`retrieve` → BM25（标题 3x / 领域 2x / 正文 1x + IDF）取前 6 core，**一阶图扩散**取 ≤4 expansion（至多 10 卡）。
3. **精读**：`read_card` 读少量关键节点全文。
4. **推理/回答**：模型在提示 + 卡片上组织回答（分析默认留在对话）。
5. **写入**：`propose_write`（新建完整记录 / enrich 补丁）→ UI ConfirmCard 确认 → `/api/write/confirm` 原子落盘（staging→rename）+ Journal。
6. **认知运动可视化**：retrieve.query → graph.hit(seed/expand) → context.ready → card.read → session.idle（chat.js 桥 + 激活引擎）。

### 1.3 与「思维体设计」（thinking-body.md S0–S4）的差距

| 设计层 | 现状（NEXO-DSH） | 差距 |
|---|---|---|
| **STM 短期记忆**（focus / claims / tensions / cited_cards / user_directives / bridge_hints，≈10 会话滚动） | ❌ 无（`.nexogenesis/` 只有 `graph/layout.json`） | 未实现——每轮检索从零开始，`cited_cards` 不跨轮累计 |
| **注意力组装**（Working Set：core / expansion / conflict 双预算账户，新奇度加权） | ⚠️ retrieve 扁平返回 core+expansion；无 conflict 保底席位、无新奇度/去重加权 | 部分（约 1/3） |
| **强信号**（可解释触发 + 冷却 + 轻问） | ⚠️ 仅 emerge 被动响应「记一下」 | 未实现主动层 |
| **双轨检索**（结构图 + 质料 RAG + 归因 nascent/document/user） | ⚠️ 只有结构轨（BM25+图扩散）；质料轨按 M4 决策延后 | 部分（结构轨 ✅，质料轨 ⏳） |
| **图操作**（traverse 多跳 / analyze 结构诊断 / 快照索引） | ❌ 无 graph_expand / graph_analyze 工具 | 未移植 |

### 1.4 当前思考质量的真实水平

- **优点**：单体系闭环；检索纪律由 persona 软约束；写入审批完备；事件可视化真实对应 agent 动作（2026-08-13 语法已移植）。
- **局限**：一次思考 ≈ 「一次 BM25 检索 + 至多 1 跳 + 模型直接推理」——没有跨轮工作记忆、不能沿关系**多跳追链**（结构导航）、不能**诊断结构**（枢纽/桥接/孤立/冲突缺口）、冲突视角不保证在场。这是「想得浅」的结构性原因，不是模型问题。

---

## 2. GRAPHOPS 移植评估

### 2.1 「GRAPHOPS」指什么

原仓库无字面 GRAPHOPS；指 **`nexogenesis/graph/` 图操作套件 + 认知运动协议**（`docs/plans/2026-08-13-agent-graph-motion-language.md` 已实施）：

| 模块 | 职责 |
|---|---|
| `build.py` | 从 Store 抽边（relations/wikilink/domain/involves）→ 快照（`store.py` 持久化） |
| `traverse.py` | `expand_subgraph`：种子 → BFS **hop≤2**（第二跳过滤关系类型）、max_nodes 24，返回 `{hop, via}` 标注 |
| `analyze.py` | 连通分量 / **桥接点**（删除后分量增加）/ 孤立 / conflict 缺口 → `structure_ops.json`（非自动提案） |
| `retrieve.py` | 种子 → 扩展 → 排序 → 结构区 Context（G1 策略：遇 conflict 拉 involves 各方） |
| `export.py` | GraphML（R7） |

最近相关提交：`7a24022 refactor(agent): unify graph retrieval and cognitive motion`（agent_tools.py +192 行）、`d62bfe8 feat: align graph motion with agent behavior`。

### 2.2 移植现状（逐项核对）

| 上游能力 | 融合仓现状 | 状态 |
|---|---|---|
| 边构建（build + 快照） | `graph.js buildGraphEdges`（frontmatter relations 直读） | ✅ 等效（无快照缓存，前端直读可暂免） |
| 检索（retrieve：种子→扩展） | `cards.js searchCards`（BM25 + **1 跳**扩散） | ⚠️ 部分：无第二跳、无 conflict 拉取策略、无 `via/hop` 标注、无预算 |
| 认知运动事件（retrieve.query / graph.hit / card.read / session.idle / write.applied） | `chat.js` 桥 + 前端激活引擎 | ✅ 已移植（2026-08-17 全链路验证） |
| **多跳遍历（traverse）** | — | ❌ **未移植** |
| **结构诊断（analyze：桥接/孤立/conflict 缺口/提案）** | — | ❌ **未移植** |
| GraphML 导出 | — | ❌ 未移植（低优先级） |
| STM / 注意力双账户 / 强信号 | — | ❌ 未移植 |

**结论：GRAPHOPS 未完成移植。** 已完成的是「检索 + 动效可视化」两条腿；**图操作工具（traverse/analyze）与思维体装配层（STM/双账户/强信号）完全缺失**——这正是 1.4 所述「想得浅」的直接原因。

---

## 3. 能否用 agent-loop 实现更优质的思维体思考？——能，且路径清晰

DSH agent-loop 是**每轮多步引擎**，为「把思维体注意力编程化」提供了现成扩展点：

| agent-loop 扩展点 | 对思维体的用途 |
|---|---|
| 系统提示 sections / turn 前注入 | 注意力组装（Working Set 预注入）；把「先检索」从提示词软约束变成机制保证 |
| 工具集 | 图操作工具（graph_expand / graph_analyze）、STM 读写工具——能力面即思维面 |
| 事件流（agent/*、tool/*、turn/*） | 认知运动可视化（已通）、审计 |
| `agent/request` 中间件 | 请求前预处理（注入上下文、记录 cited） |
| settings 段（maxParallelToolCalls） | 并行检索/写作调度 |
| compaction / plan-mode / subagent / goal | 长会话不退化、复杂任务先计划、并行子代理、长任务跨会话（M5 已挂载） |

### 3.1 推荐优化路径（按性价比）

| 优先级 | 项 | 内容 | 收益 |
|---|---|---|---|
| **P1** | **GRAPHOPS 落地（图操作工具）** | ✅ **已完成（2026-08-19）**：移植上游 v2.2 GraphOps 闭集——`graph_search`（lexical+hub 降权）/ `graph_walk`（1 跳论证边+入边，mode=conflicts）/ `graph_members`（隶属，非 BFS）/ `graph_analogize`（跨域结构类比）/ `graph_note`（结构债 debts.jsonl）/ `read_card` 升级（slots 语义槽）；每次返回观察学分（channel/n/hub_ratio/on_topic_new/truncated，按会话累计 seen_ids）；SSE 桥映射新工具为图谱动效；persona+talk/assess/emerge 更新为思考循环 | 思维体从「单点检索」升级为「**结构导航 + 结构诊断**」，已可测 |
| **P2** | **turn-0 上下文预注入** | 首步前自动组装 Working Set（core + conflict 席位）注入上下文段；cite 去重 | 「先检索」纪律机制化，冲突视角保底在场 |
| **P3** | **STM 跨轮记忆** | `.nexogenesis/stm/session-<id>.json`（focus/tensions/cited_cards/user_directives）+ `stm_read/stm_update` 工具；retrieve 用 cited_cards 做新奇度加权 | 跨轮连贯，避免重复引用与重复建卡 |
| **P4** | **循环旋钮校准** | compaction 阈值、plan-mode 用于复杂分析、subagent 并行检索/写作、goal 长任务 | 长会话与并行质量（已挂载，实测校准） |
| **P5** | **强信号** | 结合 ask-user 的可解释轻问（捕获/冲突/摄入建议 + 冷却） | 主动沉淀入口（低优先） |

### 3.2 为什么 agent-loop 比原 Python 循环更适合做「思维体」

| | 原 Python 循环 | DSH agent-loop |
|---|---|---|
| 工具协议 | DSML 文本标记（易解析错） | 原生 JSON Schema 工具调用 |
| 路由 | 关键词匹配 route_skill | 技能系统按需加载 |
| 上下文 | 固定 MAX_ROUNDS=10 / HISTORY_LIMIT=10 | 持久化 + compaction + 每步累积 |
| 可观测 | CLI stdout 解析 | 步级事件流（已接前端动效） |
| 扩展 | 改 agent.py 单文件 | 组合行（preset）/ 工具 / sections / 中间件 |

**关键洞察**：思维体的「注意力」在 agent-loop 下应实现为**上下文组装（sections）+ 工具面（graph ops/STM）+ 事件协议（动效）**三件套，而不是再塞进提示词。P1–P3 恰好覆盖这三件套。

---

## 4. 建议

1. **先做 P1**（GRAPHOPS 移植：graph_expand + graph_analyze + retrieve 冲突保底）——它是「想得深」的直接基础设施，纯代码、可立即用单元测试 + 冒烟验证。
2. **再做 P2（turn-0 注入）+ P3（STM）**——让思考有跨轮连贯与机制化纪律。
3. P4 在校准阶段随真实对话调参；P5 视产品优先级。

> 注：P1 的 graph_analyze 输出为「结构提案」（non-automatic），与现有 construct 会话的 propose_write 审批闭环天然衔接——诊断结果可转写入提案交用户确认，符合宪法「复杂度必须有证据、写入须授权」。
