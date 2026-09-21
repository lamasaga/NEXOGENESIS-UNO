# 2026-08-30 TM、Skill、OPS 与知识流程统一实施 SPEC

> 状态：实施依据。
>
> 范围：关系契约、共享 GraphOps、消化、建构、思维体、认知事件与存量关系迁移。
>
> 非目标：重写 DSH Agent Loop、引入图数据库、批量自动补边、增加新的 Card 类型。

## 1. 当前判断

  DSH 已经具备统一 Operator Registry、结构化 Observation、可恢复 CognitiveRun、Thinking Model 能力闭合检查和 HarnessGateway。当前不需要另建一套工作流框架。缺口位于关系质量层：运行时只能判断边是否存在和类型是否合法，不能判断它能否被可靠用于论证；不同流程虽然调用同一工具底座，但尚未共享“关系就绪、情境边、历史待核验边”的使用纪律。

  本次采用增量改造：在既有 GraphOps 和 Harness 之间增加一套关系质量判定，并让消化、建构、对话和前端事件共同消费它。旧边不批量改写；它们进入确定性迁移队列，由建构按局部簇修复。

## 2. 固定职责

| 层级 | 责任 | 明确禁止 |
|---|---|---|
| Thinking Model | 根据目标和 Observation 选择下一项能力、形成假设并判断停止 | 直接写 Card 或把候选当事实 |
| Skill | 规定目标、允许能力、预算、停止条件和面向用户的表达 | 复制工具实现或固定每一步调用顺序 |
| OPS | 执行检索、精读、走边、比较、冲突、路径与溯源 | 自行决定知识是否正确 |
| Workflow / CognitiveRun | 保存任务状态、授权、暂停、恢复、预算和写后复核 | 重新定义关系语义 |
| HarnessGateway | 检查关系、来源、层面、修订与权限并原子写入 | 代替模型作开放式语义判断 |

## 3. 关系运行契约

  正式关系仍保持十种闭集。`domains[]` 是领域归属；`supports`、`based-on`、`extends`、`example-of`、`part-of`、`applies-to`、`conflicts-with`、`involves` 属于论证平面；`influences`、`precedes` 属于情境平面。

  每条关系运行时计算一个就绪等级：

| 等级 | 条件 | 权限 |
|---|---|---|
| `argument_ready` | 论证边合法，具有可解释 `note`，源卡具备允许的来源状态 | 可进入默认论证与多跳路径 |
| `context_ready` | 情境边合法，具有机制或时序说明，源卡具备允许的来源状态 | 仅在显式情景/历史遍历中使用 |
| `legacy_candidate` | 旧边缺说明、说明过于空泛或来源不足 | 只作为一跳待核验候选，不能继续扩展或支撑结论 |
| `invalid` | 目标缺失、指向 domain、类型或方向非法 | 不返回为可走边，进入结构问题队列 |

  新增或修改关系必须达到 ready。未修改的旧边仍可随 Card 往返保存，不因新规则阻塞无关的正文、来源或领域操作。

## 4. GraphOps 改动

### 4.1 `graph_walk`

- 新增 `plane=argument|context`，默认 `argument`。
- 论证平面默认不走 `influences`、`precedes`；`applies-to` 只在明确请求该类型时使用。
- 一跳可以返回 `legacy_candidate`，但边和节点必须带就绪状态与警告。
- 二跳、三跳只沿 ready 边扩展；legacy 边不能成为中介。
- 返回每层、完整路径、真实边、声明类型、有效类型、`note`、plane 和 readiness。

### 4.2 新增或规范化 OPS

| OPS | 实施方式 |
|---|---|
| `compare_cards` | 复用现有 compare 实现；`compare_nodes` 暂作兼容别名 |
| `graph_path` | 在两个已知 Card 间寻找最多三跳的真实 ready 路径；限制路径数和单节点扩展量 |
| `inspect_argument` | 组合目标卡、supports 入边、based-on 出边、冲突、适用范围与来源摘要 |
| `inspect_structure_issues` | 增加缺边注、空泛边注、情境边未就绪和 conflict 非 involves 出边 |
| `inspect_unconnected_cards` | 增加 `without_ready_relations`、游标、优先级、入出边摘要、精确焦点复验和基于 Card 指纹的已审排除 |
| `inspect_integration_candidates` | 用共享来源、共同领域、正文互指、有限语义单元、类型兼容和既有 ready 路径召回少量端点；不自动决定关系 |
| `inspect_relation_case` | 为一对端点组装语义槽、来源、方向、路径、邻域、镜像、关系选项和移除影响；不做最终裁决 |
| `simulate_relation_patch` | 对 keep/change/remove/defer 结构化裁决做写前影响模拟；高风险需第二次反对性复核 |
| `record_structure_review` | 把已连接、近重复、待重分类、待调整领域、暂时独立或证据缺口绑定到 Card 指纹；只写可重建运行记录 |

## 5. Harness 改动

  `relation` 层与 `creation` 层的新边必须有具体说明。Gateway 比较完整关系签名，`note` 的改变也算关系变更。删除旧边不会被缺说明规则阻塞；只改正文时不会重新审判未触及的历史关系。

  只有 frontmatter `relations[]` 改变正式图谱。正文中的卡片名、列表、普通链接和案例枚举不生成隐含边，也不触发旧关系签名检查。

## 6. 三类流程接线

### 6.1 消化

  消化的主职仍是 Buffer → Card。正文和新建对象通过 Semantic Patch 结算；只有已经精读源卡、目标卡并能说明质料贡献时，才额外提出少量关系层修改。关系修改与正文结算分开提交，Buffer 的贡献结算不依赖关系提案成功。

### 6.2 建构

  建构是存量图谱关系修复的主要执行面。无范围任务可从确定性问题队列开始，选择一种关系问题和一个局部簇；孤立卡先生成候选端点，再精读、比较知识功能、检查论证方向与重复程度。写入后必须以原范围和焦点卡重复同一检测器；无写入也要形成带指纹处置。`legacy_candidate` 不等于应保留，也不等于应删除。

  `isolated-card-integration` 的完成义务包括：枚举未接入队列、生成候选端点、精读焦点与候选、比较双方、检查论证方向、记录最终处置和同题复验。发现近重复、真实冲突、错型或跨域机制时可以切换对应 Thinking Model；切换是基于 Observation 的重新聚焦，不是固定流水线。

### 6.3 思维体

  talk、assess、report 默认只使用 ready 论证边。历史和情景问题可以显式打开 context 平面；最终回答必须区分论证支持、情境关联和待核验联系。emerge/refine 可以产生关系候选，但仍走 HarnessGateway。

## 7. 事件与动画

  认知事件必须直接来自 Observation。走边事件增加 plane、readiness 和逐层路径：ready 论证边按关系原色传播；context 边使用其真实关系色和独立状态文案；legacy 边只以更细、更暗且没有前锋粒子的方式短暂呈现，不产生向下一跳扩散。写入后复核使用相同 OPS 事件，不能用通用“完成”动画替代。

### 7.1 实施状态（2026-08-30）

  本 SPEC 的运行时判定、统一 OPS、关系补丁、未接入队列、候选分析、指纹审阅、同题完成门、Skill / Thinking Model 接线、事件投影和前端动效已经落地。分页与失效机制已有合成回归，存量 Card 的语义迁移没有批量执行，继续按本文第八节的优先级和局部证据循环推进；整理前的具体审计队列已移入历史目录，仅用于追溯当时快照。

## 8. 存量迁移

  首批迁移不自动修改 986 张 Card。系统生成分页队列，优先级依次为：高连接模型与核心 claim 的无说明论证边、conflict 的非 involves 出边、含义模糊的 `influences`、无 ready 关系卡、来源缺口。每次建构只处理一个局部簇和最多三个原子操作。

## 9. 验收

- 新增关系 100% 具有可解释 `note`，旧边能无损往返。
- 二跳和三跳路径不含 `legacy_candidate`。
- argument 与 context 不能混走；领域成员不能成为推理捷径。
- 对话、消化和建构使用相同关系判定和 Observation。
- 未接入队列可沿游标访问后页；当前指纹下已审卡默认不重复出现，Card 改变后自动重新入队。
- 写后无关读取不能满足建构完成门；无写入孤立卡必须留下明确处置。
- 动画能区分 ready、context、legacy 和失败结果。
- 所有 Node 测试、Web 测试和生产构建通过。
- 存量知识体保持零幽灵目标、零关系指向 domain、零非法签名。

## 10. 撤回方式

  关系就绪只在运行时计算，不改 Markdown schema。若策略过严，可以调整判定和遍历门槛，不需要回滚知识体。存量关系迁移全部通过原子提案并记录修订；每次只改关系层，可按提交或关系补丁单独撤回。

## 11. 新卡结构接入闭环

  实践库审计显示，历史上存在一批只有 `domains[]`、没有任何入边或出边的新卡。问题不只是模型漏写关系：旧流程把内容结算视为 Digest 的终点，而“是否能够进入推理图”只是告警；同时又缺少一种诚实表达“卡片成立，但关系证据不足”的结构化结果。直接改成“每张新卡至少一条边”会诱导模型制造空泛关系，因此本次采用三态接入决定，而不是边数配额。

| 状态 | 含义 | 完成条件 |
|---|---|---|
| `link_now` | 当前材料和候选卡已足以证明关系 | 内容写入后必须形成至少一条磁盘中的 ready 入边或出边 |
| `deferred_with_evidence_gap` | 卡片成立，但关系方向、目标或适用条件仍缺证据 | 记录已核对候选、具体缺口，并进入建构债务队列 |
| `intentionally_standalone` | 比较候选后确认当前不应连接 | 记录误连风险和独立存在理由 |

  `propose_semantic_patch` 对每个 `new_card_draft` 强制接收 `integration`。写入回执和后续 `propose_relation_patch` 都会重新读取 Markdown 图谱；一旦出现 ready 入边或出边，运行状态自动提升为 `integrated`。`finish_cognitive_run(completed)` 只阻断仍为 `pending_relation` 的新卡，不阻断有证据的延后，也不把领域归属误算成结构接入。

  延后项写入 `.nexogenesis/graph/debts.jsonl`，由 Construct 作为确定性入口复核。它是可重建运行数据，不改变 Markdown 事实源，也不允许绕过 Harness 修改 Card。前端事件直接投影接入判断和候选 Card，使用户可以看到 Agent 是在连边、保留证据缺口，还是有理由地保持节点独立。

### 11.1 验收补充

- 新建 Card 没有 `integration` 时，语义补丁在写入前被拒绝。
- `link_now` 没有候选、写后没有 ready 关系时，Digest 不能标记完成。
- ready 入边与出边都能自动关闭接入任务。
- 延后必须有具体 `missing_evidence`，并产生可去重的建构债务。
- 暂时独立进入“未改变”报告，不被误报为待办；证据缺口进入“待办”。
