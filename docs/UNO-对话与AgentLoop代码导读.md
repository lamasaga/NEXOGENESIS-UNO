# UNO 对话与 Agent Loop 代码导读

## 一、先建立正确的代码地图

核对日期：2026-09-22。本文整理本地 UNO 工作区中与对话、研究循环、早期 talk、工具读取及交付有关的文件，并补充本机安装的原生运行时入口。不移动源文件，不复制依赖，不把文件存在视为当前服务已经加载。

“早期 talk”指沿用下来的原生对话与研究体系；下列文件是当前工作区中的版本，不是对早期某个 Git 提交的原样还原。历史文档另列，不能覆盖现行代码。

先区分五层：

| 层次 | 负责什么 | 不负责什么 |
|---|---|---|
| Web 对话入口 | 新建会话、提交问题、显示消息、停止和继续 | 不直接决定每一步模型推理 |
| 轻量对话执行器 | 意图判断、有限资料收集、生成回答 | 没有模型自主多轮工具循环 |
| 原生 Agent Loop | 模型请求、工具执行、结果回灌、下一步及停止 | 不自行定义知识正确性或写入权限 |
| UNO 认知运行层 | 任务状态、预算、证据、工作记忆、交付检查 | 不是另一套底层模型循环 |
| talk / Skill / TM | 告诉模型何时检索、怎样分析、怎样组织结果 | 文本规则和方法配置不是自动执行的独立 Agent |

### 当前两条对话路径

```text
当前默认新对话
App.tsx → client.ts → projects.js（登记 quick）
发送问题 → chat.js → quick-thinking.js
  ├─ 模型判断无需资料 → 同一次流式请求直接回答
  └─ 模型要求资料 → thinking-routes.js / project-knowledge.js
                    → 宿主收集材料 → 再请求一次回答
两种模型请求都不携带工具目录。

保留的原生研究路径（非 quick 会话，受入口与状态检查约束）
chat.js → thinking.js（有研究参数时）→ rpc.js → session.prompt
  → DSH 原生 Agent Loop
  → 组装 persona、上下文、工具目录和会话历史
  → 模型输出工具调用
  → UNO index.js / cognition/tools.js 等工具执行
  → 工具结果写入会话 → 下一次模型请求
  → 最终回答 / 用户停止 / 预算或异常结束
```

目前 `App.tsx` 默认创建 quick 会话；`chat.js` 拒绝在既有 quick 会话中混入研究请求。因此“保留研究接口”不等于“当前用户能在默认对话中顺畅升级研究”。

### 最值得先读的八个文件

1. [App.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/App.tsx)：当前用户从哪里进入。
2. [chat.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/chat.js)：消息最终被分到哪条执行路径。
3. [quick-thinking.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/quick-thinking.js)：轻量路径究竟做了什么、不能做什么。
4. [nexogenesis/agent.cordis.yml](D:/UESR/Desktop/NEXOGENESIS-UNO/presets/nexogenesis/agent.cordis.yml)：原生对话挂载哪些指令、工具、Skill 和能力。
5. [nexo-talk/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-talk/SKILL.md)：原本期待的日常对话与研究体验。
6. [cognition/tools.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/tools.js)：模型如何启动、检查、更新和结束分析。
7. [cognition/run-store.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/run-store.js)：分析状态和权限如何真实落地。
8. [原生 dsh-agent-loop/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js)：真正的“模型—工具—模型”循环。

## 二、Web 入口与当前轻量对话

以下均为 UNO 仓库文件。组件只说明职责，不代表本次做过界面运行验收。

| 文件 | 用途与关键定位 | 所属路径 |
|---|---|---|
| [web/src/App.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/App.tsx) | 应用总控；新建对话、切换会话、发送及工作状态协调。重点看 `createConversation(defaultProjectId, "quick")` 和发送分支。 | 当前入口 |
| [web/src/api/client.ts](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/api/client.ts) | 前后端接口与类型；创建会话、发送流式消息、传递 `thinking_request`、接收认知状态与控制任务。后端协议在这里有前端对应。 | 共用 |
| [ChatComposer.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/components/ChatComposer.tsx) | 输入框、发送、停止或插入要求；根据 quick、任务会话和执行状态调整输入体验。 | 当前 UI |
| [ChatPanel.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/components/ChatPanel.tsx) | 消息区域、会话切换及滚动行为；不执行模型或工具。 | 当前 UI |
| [ConversationControls.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/components/ConversationControls.tsx) | 展示暂停、讨论、继续、结束及详情等工作控制入口。 | 共用 UI |
| [ConversationStateCard.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/components/ConversationStateCard.tsx) | 将运行状态、待答问题、提案、候选及保存结果呈现给用户；状态卡不是研究执行器。 | 状态展示 |
| [conversations/state.ts](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/conversations/state.ts) | 防止服务器历史快照覆盖当前流式消息；同步会话列表信息和删除结果。 | 共用 UI 状态 |
| [web-host/lib/index.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/index.js) | Web 插件装配入口；注册 chat、conversation、cognition 等路由，接入请求检查器和自定义会话事件。 | 后端总入口 |
| [projects.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/projects.js) | 创建项目和会话，指定 `agentPreset: nexogenesis`，保存 quick 标记；折叠原生/轻量消息，分页读取历史及执行会话归属检查。 | 共用 |
| [meta.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/meta.js) | 项目和会话的扩展元数据；保存项目归属、对话模式等宿主字段，不替代原生消息日志。 | 共用 |
| [chat.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/chat.js) | 最重要的消息路由器。`streamChatBody` 检查 quick、任务讨论、研究及恢复条件；原生路径通过 `session.prompt` 提交；还把事件转成浏览器流。 | 分流与桥接 |
| [thinking.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/thinking.js) | `prepareThinking` 校验 quick/research 参数；将理解、比较、研判、报告映射到模式、Skill、深度及研究提示词。它准备任务，不执行循环。 | 研究参数仍保留 |
| [quick-thinking.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/quick-thinking.js) | `streamQuickThinking` 直接调用模型服务；管理意图/回答请求、有限历史、取消、用量和轻量消息记录。`buildIntentRequest`、`buildQuickRequest` 都使用空工具目录。 | 当前轻量主执行器 |
| [thinking-intent.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/thinking-intent.js) | 意图判断提示词及流式控制行解析；区分直接回答与资料检索，提取查询与路线，避免控制 JSON 混入正文。 | 当前轻量 |
| [thinking-routes.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/thinking-routes.js) | 定义解释、比较等检索路线，收集卡片正文、关系线索及 Buffer 摘录，并限制上下文规模；是宿主检索，不是自主研究循环。 | 当前轻量 |
| [project-knowledge.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/project-knowledge.js) | 管理项目关联的知识库、会话检索范围和跨库引用；`collectProjectKnowledge` 按项目范围组合检索材料。不能据此假定所有原生工具也自动跨库。 | 项目资料范围 |
| [session-events.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/session-events.js) | 注册 `nexo/quick-message` 自定义原生事件，支持轻量消息保存及冷加载；不是完整会话持久化引擎。 | 当前轻量与历史兼容 |
| [settings.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/settings.js) | 模型与对话设置；提供活动模型选择、人设指令等入口。查“实际用了哪个模型、哪种思考档”时需要它。 | 共用模型配置 |
| [model-adapter.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/model-adapter.js) | UNO 的模型协议适配：把请求转成供应商消息并解析流式结果。它影响工具消息及输出兼容，但不是所有供应商唯一的适配器。 | 模型传输层 |
| [latency-telemetry.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/latency-telemetry.js) | 记录对话请求阶段及延迟数据；用于比较轻量与研究开销，不证明答案质量。 | 可观测性 |

## 三、原生研究的接入、状态与实际交付

| 文件 | 用途与关键定位 | 注意事项 |
|---|---|---|
| [rpc.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/rpc.js) | `rpcCall` 把 UNO 请求交给原生 API，支持进程内载体及兼容 HTTP；同时提供请求信任边界、JSON、SSE 辅助。 | `session.prompt` 从这里进入原生系统；桥接不是循环本体。 |
| [cognition.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/cognition.js) | 查询研究运行，恢复、插入要求、处理用户选择并提交后续原生消息；对失去活动执行的状态进行对账。 | 是研究运行的 Web 控制面。 |
| [conversation-control.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/conversation-control.js) | 对话操作准入串行化、当前运行校验、讨论与恢复切换。 | 用于阻止同一会话互相冲突的操作。 |
| [turn-state.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/turn-state.js) | 解释原生回合结束原因，在完成、失败、取消等边界结算一般研究或旧流水线状态。 | 模型一轮结束不必然等于研究完成。 |
| [analysis-delivery.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/analysis-delivery.js) | `deliveryFromHistory`、`reconcileAnalysisDelivery` 核对真实持久化最终消息及对应 `turn/end`，区分准备交付、已交付和中断。 | 工具说“完成”或流式出现文字都不能单独证明正式交付。 |
| [cognitive-events.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/cognitive-events.js) | 将工具动作和观察投影为可显示的进度、卡片/边目标及事件语气。 | 图上亮了节点，只能说明事件投影，不能证明理解。 |
| [events-bus.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/events-bus.js) | 广播图谱与工作事件，向前端分发状态变化。 | 展示通道，不决定下一步研究。 |
| [prompt-inspector.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/prompt-inspector.js) | 捕获模型可见请求、适配后的输入、输出和用途元数据；提供检查接口。 | 查工具目录是否发送、正文是否进入请求的关键入口；不是隐藏思维链记录器。 |
| [PromptInspector.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/components/PromptInspector.tsx) | 请求检查器的前端界面，展示请求详情。 | 排查入口，不参与模型决策。 |

## 四、早期 talk：人设、Skill 与分析契约

这些不是普通 JS 执行代码，但会决定模型的行动方式。Skill 文件存在、目录里显示 Skill 名称、全文实际加载，是三件不同的事。

| 文件 | 具体用途 | 当前定位 |
|---|---|---|
| [presets/nexogenesis/agent.cordis.yml](D:/UESR/Desktop/NEXOGENESIS-UNO/presets/nexogenesis/agent.cordis.yml) | 原生对话的装配表和长人设；定义检索门控、direct/grounded_quick/analytical、写入纪律及分析要求；挂载知识工具、Skill、计划、压缩、子代理等插件。 | 原生 talk 的主要总开关；不是 quick 请求完整照搬的系统提示。 |
| [presets/nexogenesis/preset.yml](D:/UESR/Desktop/NEXOGENESIS-UNO/presets/nexogenesis/preset.yml) | 原生对话预设的标识与展示元数据。 | 让宿主识别这一预设，不写研究逻辑。 |
| [nexo-talk/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-talk/SKILL.md) | 日常交流总契约：何时直接回答、何时有限取证、何时进入分析；规定如何引用、保留缺口，以及向知识沉淀交接。 | 恢复研究体验时最重要的产品意图文件。 |
| [nexo-assess/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-assess/SKILL.md) | 具体选择、风险与判断的条件式研判；比较不同依据和取舍，不替用户做最终决定。 | 研究的一种任务形式，不是独立模型。 |
| [nexo-report/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-report/SKILL.md) | 面向明确问题和受众组织可独立阅读的报告；复用分析与证据规则。 | 输出形式；“报告”不自动等于更深研究。 |
| [nexo-deep-think/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-deep-think/SKILL.md) | 显式 TM/OPS 固定执行压力测试，要求完成指定观察和验证过程。 | 测试路径，不应作为每次深入交流的默认流程。 |
| [nexo-judge/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-judge/SKILL.md) | 受控判断与序贯评测契约：遵守 as_of、允许方法、上一时点输出及指定 Schema，禁止引入未来材料；其运行被 `isStrictAnalysis` 归入严格分析。 | 受控评测路径，不能与日常 nexo-assess 简单视为同义词。 |
| [nexo-emerge/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-emerge/SKILL.md) | 将用户要求“记一下”的观点整理成少量知识候选，经确认后保存；区分用户原意、系统补充和已有知识。 | 对话向知识写入的交接规则；不是默认自动写卡。 |
| [nexo-refine/SKILL.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/skills/nexo-refine/SKILL.md) | 围绕既有卡片讨论、提出修订并在确认后更新。 | 对话式修订契约；实际写入仍要过 Gateway。 |
| [thinking-body.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/reference/thinking-body.md) | talk、研判、报告共用的分析规则：预算、方法选择、实际阅读、关系推理、缺口、收尾和工作记忆。 | 同时包含 conversation-v2 与旧版/固定测试要求，必须按运行策略阅读。 |
| [thinking-output-contract.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/reference/thinking-output-contract.md) | 证据等级、面向用户的表达、知识沉淀及可审计结果边界。 | 输出契约；并不自动验证自然语言是否忠实。 |
| [retrieval-design.md](D:/UESR/Desktop/NEXOGENESIS-UNO/.agent/reference/retrieval-design.md) | 检索入口、候选与正文的区别、图遍历跳数、调用顺序和归因限制。 | 理解“搜到”和“读过”为什么不同。 |

加载关系：`agent.cordis.yml` 配置 Skill 目录 → 原生 filesystem provider 发现文件 → `skill` 工具按名称返回全文 → 模型遵循指令。Skill 中引用的其他 Markdown 不应被假定已经自动展开；是否继续读取需检查实际工具记录与请求内容。

## 五、UNO 研究循环的状态、证据与工具代码

### 5.1 认知运行层

下列文件均位于 `packages/nexogenesis-tools/lib/cognition/`。它们管理研究，不替代 DSH 的模型循环。

| 文件 | 做什么用 | 重点关注 |
|---|---|---|
| [tools.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/tools.js) | 注册模型可调用的认知工具：启动任务、选择方法、查看和更新工作区、检查证据、请求用户选择、完成分析等。 | 工具名称、参数 Schema、执行函数与返回形式都在这里汇合。 |
| [run-store.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/run-store.js) | `CognitiveRuntime` 管理 run、workspace、episode、会话绑定、权限、预算、观察记录、暂停恢复和交付状态。 | `ensure`、`canOperate`、`record`、`updateWorkspace` 等；“工具被拒绝”经常要查此层。 |
| [conversation-analysis.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/conversation-analysis.js) | 定义 `conversation-v2`，检查交付证据和关系发现，产生缺口、覆盖度及指纹；允许带明确限制交付。 | 区分研究未充分、可以回答、已经交付三种事实。 |
| [general-analysis.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/general-analysis.js) | 分配分析预算，计算阅读、图探索、证据与深度观察的完成条件。 | 旧版/严格完成门与共享预算逻辑，不能一律套到新版普通分析。 |
| [thinking-models.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/thinking-models.js) | 加载和登记 TM，检查所需工具能力、观察义务及输出义务。 | TM 是分析方法配置，不是一个额外 LLM。 |
| [operator-registry.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/operator-registry.js) | 登记操作的能力、版本、风险、成本和读写类型，并按能力查询操作。 | 这是能力登记表；不等于原生工具执行注册表。登记能力不证明模型看到了工具。 |
| [observations.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/observations.js) | 创建统一观察和 Harness 回执结构，包括状态、摘要、证据、范围和下一步。 | 让不同工具结果进入同一账本。 |
| [reading-coverage.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/reading-coverage.js) | 描述正文实际交付范围和完整性，从步骤中提取阅读记录。 | 截断或局部阅读不能自动算全文阅读；交付完整也不等于理解正确。 |
| [evidence-inspection.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/evidence-inspection.js) | 核验引用锚点、卡片版本、实际阅读、证据角色、判断覆盖和来源依赖。 | 防止引用未读或过期卡片；不替代语义判断。 |
| [working-memory.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/working-memory.js) | 从当前步骤和已核验证据生成有界工作记忆，保留判断、摘录、解释、未知及探索结果。 | 给长研究和最终回答使用，不保存隐藏思维链。 |
| [model-output.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/model-output.js) | 对发给模型的状态和观察做有界投影，提供简版、工作记忆或完整视图的输出渲染。 | 查“账本里有、模型上下文里没有”时需要它。 |
| [exploration-budget.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/exploration-budget.js) | 识别探索操作并计算可用探索预算。 | 约束继续查找的开销，不判断发现是否有价值。 |
| [construct-tools.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/construct-tools.js) | 保留的认知建构工具注册，连接改善计划、复核等能力。 | 与 talk 共享认知底座，但不是当前新建构服务的全部实现。 |
| [construct-improvement.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/construct-improvement.js) | 定位知识缺口、准备局部改善计划、检查操作是否符合计划并复核结果。 | `inspectKnowledgeGap` 等只读能力也可帮助查证，不能因文件名 construct 就忽略。 |
| [construct-governance.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/construct-governance.js) | 检查建构写入前置条件、运行审计及结束条件。 | 保留路径中的写入治理，不是普通研究获得写权限的入口。 |
| [construct-backlog.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/construct-backlog.js) | 从既有运行中读取和分页整理建构待办。 | 是后续工作线索，不是已经成立的新知识。 |
| [structure-reviews.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/structure-reviews.js) | 保存结构问题处置记录，绑定卡片指纹并筛选仍有效的复核结论。 | 用于避免把过期结构判断当作当前事实。 |

### 5.2 真正读取知识的工具与底层

| 文件 | 做什么用 | 与“不读/报错”的关系 |
|---|---|---|
| [tools/lib/index.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/index.js) | 注册 `retrieve`、`read_card`、`read_cards`、`trace_source`、Buffer/Inbox、图操作和知识提案工具，再挂载认知工具。包含描述、参数、输出和执行逻辑。 | 第一检查点：工具名是否正确、参数是否满足契约、运行规则是否拒绝。 |
| [graph-ops.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/graph-ops.js) | `GraphOps` 实现联合召回、关系遍历、路径、论证检查、比较、类比及结构问题等算法。 | 结果可能只是候选、路径或线索；不能当作已经阅读全文。 |
| [cards.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cards.js) | 解析 Markdown 卡片、缓存知识快照、搜索和读取卡片、读取 Inbox/Buffer、追溯来源；也含底层写入辅助。 | 读取层排查文件不存在、元数据异常、正文截断和缓存；不能绕过 Gateway 调底层写入。 |
| [card-units.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/card-units.js) | 解析、列出、搜索及读取卡内显式语义单元，提供稳定地址。 | 没有显式单元的旧卡可能返回空清单，不代表整张卡没内容。 |
| [compile/source-ledger.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/compile/source-ledger.js) | 来源映射检查与来源片段读取，供追溯工具取得来源区间。 | 卡片正文与原始来源阅读是不同动作。 |
| [json-value.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/json-value.js) | 将工具数据规范化为可安全交付的 JSON 值，处理可选字段和非法类型。 | 查返回值无法序列化或不符合交付要求。 |
| [runtime/tool-result.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/runtime/tool-result.js) | 提供 `toolResult` 与 `toolFailure`，组织错误码、恢复建议和可用收据。 | 不能假设所有早期 talk 工具均已统一使用这一错误封装。 |
| [pending.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/pending.js) | 保存、读取及管理待确认知识提案。 | 对话“提出修改”与“已经保存”之间的状态层。 |
| [harness/gateway.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/harness/gateway.js) | 实质知识写入入口，执行授权、范围、版本、幂等和事务等保护。 | 研究默认只读；要沉淀结果也必须单独满足写入授权。 |
| [instances/registry.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/instances/registry.js) | 知识实例注册、当前实例上下文及切换通知。 | 查“读错库、查不到刚切换的库”时需要核对实际根目录。 |

`retrieve` 的能力元数据、模型可见 Schema、运行权限和实际读取结果分属不同机制。任何一层存在，并不能证明其他层已贯通。

## 六、TM 方法配置：不是另一组工具 Agent

以下文件位于 `schemes/default/thinking-models/`，由方法注册器读取，描述适用条件、所需能力、观察义务、偏差提醒及停止边界。它们不是自动运行脚本，也不会仅因名字含“分析”而发起模型请求。部分配置服务于历史建构或测试，不代表当前 quick 会调用。

| 文件 | 具体用途 |
|---|---|
| [mechanism-contrast.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/mechanism-contrast.yaml) | 比较多个解释的因果环节、适用条件和失效边界。 |
| [evidence-triangulation.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/evidence-triangulation.yaml) | 检查关键判断的多来源支撑、反证和未知。 |
| [conflict-differentiation.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/conflict-differentiation.yaml) | 区分概念不同、条件不同、证据冲突和真正命题矛盾。 |
| [bridge-analysis.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/bridge-analysis.yaml) | 寻找有依据的跨领域桥接机制，不以词语相近代替联系。 |
| [scenario-conditions.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/scenario-conditions.yaml) | 组织基准、上行和下行情景的条件、传导与观察信号。 |
| [cross-sectional-vulnerability.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/cross-sectional-vulnerability.yaml) | 比较共同冲击下不同对象的暴露、脆弱性和缓冲。 |
| [multi-timescale-shock-decomposition.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/multi-timescale-shock-decomposition.yaml) | 拆开长期结构、中期循环、短期事件及作用时滞。 |
| [sequential-belief-update.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/sequential-belief-update.yaml) | 在冻结上一时点判断的前提下，根据新增证据更新判断并保留时点边界。 |
| [deep-inquiry.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/deep-inquiry.yaml) | 固定 TM/OPS 压力测试，检查搜集、机制、偏移、类比、反例和证据验收是否实际发生。 |
| [knowledge-organization.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/knowledge-organization.yaml) | 围绕知识使用问题比较关系整理、合并、拆分、精修、领域调整与保持现状。 |
| [isolated-card-integration.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/isolated-card-integration.yaml) | 检查未接入卡片的候选联系、重复、错型与合理独立，形成绑定版本的处置结论。 |
| [domain-overload-diagnosis.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/domain-overload-diagnosis.yaml) | 判断领域边界是否混杂，是否需要拆分、重命名或保持。 |
| [relation-integrity-audit.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/relation-integrity-audit.yaml) | 对局部关系问题做端点阅读、反证及结构影响审查。 |
| [candidate-assimilation.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/candidate-assimilation.yaml) | 为来源中的知识对象选择新建、修订、跳过或延期的承载方式；不能替代当前单元编译契约。 |
| [source-coverage.yaml](D:/UESR/Desktop/NEXOGENESIS-UNO/schemes/default/thinking-models/source-coverage.yaml) | 检查来源中的重要论证、证据、表图及张力是否得到覆盖；配置存在不证明已完成覆盖检查。 |

## 七、不要与普通 talk 混淆的 UNO 专用任务文件

这些文件可以解释为何“项目仍有 Agent 代码”，但默认新对话没有自主循环。尤其 `uno/agent.js` 不是普通 talk 的循环核心。

| 文件 | 用途与边界 |
|---|---|
| [presets/uno-compile/agent.cordis.yml](D:/UESR/Desktop/NEXOGENESIS-UNO/presets/uno-compile/agent.cordis.yml) | 为专用知识任务加载 `nexogenesis-tools/compile-agent`；与普通 `nexogenesis` 预设分开。 |
| [uno/agent.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/uno/agent.js) | 注册专用工具、加入任务指令与进度、限制工具目录，并在已持久化交接后请求结束原生回合。单元编译不运行此工具循环；工具清空逻辑属于加载了该插件的作用域，不能解释成清空所有普通 talk 工具。 |
| [uno/tool-schemas.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/uno/tool-schemas.js) | 收紧专用工具的参数 Schema，减少模糊参数与非法嵌套结构。 |
| [uno/native-request-context.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/uno/native-request-context.js) | 在受治理的专用 Agent 上接入原生请求构建和消息投影，校验适配契约及预算；不是给所有聊天全局改写历史。 |
| [uno/request-context.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/uno/request-context.js) | 对专用任务历史做确定性请求投影，保留必要进度、工具结果并检查输入预算；不改写原始会话日志。 |
| [uno/state.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/uno/state.js) | 保存专用任务状态、版本以及会话与任务绑定。与 `cognition/run-store.js` 的一般研究运行不是同一种状态文件。 |
| [uno-jobs.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/uno-jobs.js) | 专用任务创建、控制和执行分流：编译交给 `book-compile`，策略建构交给 `construction-service`，其他受支持建构交给旧建构宿主。 |
| [book-compile.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/book-compile.js) | 当前宿主制卡流程：单元生成、审核、修复、保存及恢复协调；多次模型请求不等于原生自主工具循环。 |
| [unit-card-request.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/unit-card-request.js) | 为生成、审核、精修等单元操作组装有界请求；使用无工具请求。 |
| [construction-service.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/construction-service.js) | 当前策略建构服务，协调策略、工作包、专用生成、审核和提交。不是 talk 研究入口。 |
| [construction-request.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/construction-request.js) | 构造策略建构的专用模型请求，基础请求不携带工具目录。 |
| [construction-host.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/construction-host.js) | 保留建构执行路径的宿主，管理作者/审核者上下文和原生回合。可用于理解专用 Agent 的运行，但不作为新 talk 的直接模板。 |
| [uno/construction-workflow.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/uno/construction-workflow.js) | 保留建构协议的批次、阅读覆盖、工具执行及角色指令。持久化名称 `uno-compile-v3` 在这里用于 construct，不能误认成当前单元编译。 |

## 八、真正的原生 Loop 在哪里

### 8.1 UNO 如何装配原生运行时

| 文件 | 用途 |
|---|---|
| [prepare-nexogenesis.ps1](D:/UESR/Desktop/NEXOGENESIS-UNO/prepare-nexogenesis.ps1) | 准备本项目隔离运行目录，链接本地包，把源码中的预设及补丁部署到运行目录。仅修改源预设不证明运行进程已经重载。 |
| [start-nexogenesis.ps1](D:/UESR/Desktop/NEXOGENESIS-UNO/start-nexogenesis.ps1) | 校验端口和工作区，使用 `dsh.cmd` 启动指定 profile；不应为阅读代码而运行它。 |
| [deploy/runtime.ps1](D:/UESR/Desktop/NEXOGENESIS-UNO/deploy/runtime.ps1) | 计算工作区运行目录、profile、端口和工作区标识，隔离旧项目运行环境。 |
| [deploy/runtime-profile.json](D:/UESR/Desktop/NEXOGENESIS-UNO/deploy/runtime-profile.json) | 声明原生 base、web-app bundles 的组合。 |
| [patch/cordis.patch.yml](D:/UESR/Desktop/NEXOGENESIS-UNO/patch/cordis.patch.yml) | 配置 UNO Web 插件及相关原生服务适配。 |

### 8.2 本机原生依赖文件

以下是通过当前 `dsh.cmd` 安装位置定位的**仓库外依赖**。这是本机可读源码的位置，不证明现有服务进程使用了同一安装版本，也不是建议直接修改这些全局依赖。换机器后路径会变化。

| 文件 | 做什么用 |
|---|---|
| [dsh-agent-loop/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js) | 真正的循环。`preStep` 组装提示与工具；`turn` 驱动步骤；`step` 构造模型请求、接收流、提取工具调用；`executeToolCalls` 执行工具并记录结果；随后决定继续或结束。优先阅读 `turn`、`step`、`buildRequest`。 |
| [dsh-agent/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js) | Agent 注册、实例生命周期、所有权与作用域；负责“是哪一个 Agent 在执行”，不定义 UNO 的知识分析方法。 |
| [dsh-session/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js) | 原生会话、事件、请求头及消息投影。模型可见历史由事件派生，工具结果也通过会话参与后续上下文。 |
| [dsh-system-prompt/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js) | 按作用域和顺序组装系统段落、动态上下文、变量及工具 Schema；重点看 `assemble`。 |
| [dsh-tools/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js) | `defineTool` 与工具注册/执行基础设施，处理工具查找、参数、返回值契约和错误。UNO 工具插件接在这一层之上。 |
| [dsh-tool-skill/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js) | 发布模型可见 Skill 目录，注册 `skill` 工具并加载某个 Skill 的完整指令。Skill 目录说明不等于全文加载。 |
| [dsh-skill-filesystem/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js) | 从项目、自定义目录等位置发现 Skill，解析元数据并读取内容；UNO 的 `.agent/skills` 通过预设配置进入这里。 |
| [dsh-host-apiproxy/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js) | 原生会话 API 与调用载体；将 `session.prompt` 等协议请求交给宿主服务，是 UNO `rpc.js` 对接的上游。 |
| [dsh-llm/lib/index.js](D:/KimiData/daimon-share/daimon/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js) | 统一模型消息、流式块、适配器与模型调用契约；Loop 和轻量请求都会使用模型服务体系，但不因此共享同一执行流程。 |

原生循环中的两个重要区别：没有工具调用时通常可以结束回合；有工具调用时，结果进入会话并形成后续步骤。模型请求失败后的重试是错误恢复，不是新的研究发现，也不能当作有效分析步数。

## 九、测试与历史阅读材料

### 9.1 相关测试文件

这些是阅读行为边界的入口；本次未执行这些测试，也不能把测试文件存在写成“真实模型已经验证”。

| 文件 | 主要检查什么 |
|---|---|
| [tests/uno-thinking.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/uno-thinking.test.mjs) | 当前轻量意图、检索、模型调用数、无工具请求、历史、取消、截断及 quick/研究混用限制。 |
| [tests/talk-retrieval-gating.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/talk-retrieval-gating.test.mjs) | 静态检查 talk 提示词及相关源码中的检索门控规则，避免问候、能力介绍等强制检索；它不证明真实模型会遵守这些文字。 |
| [tests/cognitive-runtime.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/cognitive-runtime.test.mjs) | 认知运行状态、工作区、操作及运行规则等底层行为。 |
| [tests/general-analysis-budget.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/general-analysis-budget.test.mjs) | 分析深度对应的资源额度与限制。 |
| [tests/general-analysis-closure.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/general-analysis-closure.test.mjs) | 一般分析的结束、证据充分性和未完成边界。 |
| [tests/thinking-model-contract.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/thinking-model-contract.test.mjs) | TM 配置与工具能力、观察义务的契约。 |
| [tests/deep-thinking-closure.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/deep-thinking-closure.test.mjs) | 深度分析/固定测试的观察与证据闭环条件。 |
| [tests/analysis-coordination.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/analysis-coordination.test.mjs) | talk、研判、报告共享预算和证据；方法切换、工作记忆、结束及捕获交接。 |
| [tests/conversation-analysis-v2.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/conversation-analysis-v2.test.mjs) | 新版分析带缺口交付、不洗预算、引用变更失效、真实关系路径与最终消息持久化。 |
| [tests/tool-output-contract.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/tool-output-contract.test.mjs) | 工具 JSON 交付、状态读取及结束操作的返回契约。 |
| [tests/conversation-control.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/conversation-control.test.mjs) | 对话控制、讨论和恢复等状态边界。 |
| [tests/uno-rpc-carrier.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/uno-rpc-carrier.test.mjs) | UNO 与原生 API 的调用载体及失败处理，防止失败后重复派发。 |
| [tests/uno-conversation-lifecycle.test.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tests/uno-conversation-lifecycle.test.mjs) | UNO 会话与专用任务的生命周期及归属关系。 |
| [tools/eval/uno-agent-metrics.mjs](D:/UESR/Desktop/NEXOGENESIS-UNO/tools/eval/uno-agent-metrics.mjs) | 专用 UNO Agent 指标分析脚本；不能替代普通 talk 的真实效果评测。 |

### 9.2 理解设计来源的文档

| 文件 | 阅读用途 |
|---|---|
| [UNO-思考模型与检索路线.md](D:/UESR/Desktop/NEXOGENESIS-UNO/docs/UNO-思考模型与检索路线.md) | 理解当前普通对话资料需求判断和检索路线。 |
| [UNO-对话积累与思考技能设计.md](D:/UESR/Desktop/NEXOGENESIS-UNO/docs/UNO-对话积累与思考技能设计.md) | 对话、研究、知识沉淀与复盘的设计意图；包含规划，不等于全部实施。 |
| [UNO-对话与分析报告功能实施计划.md](D:/UESR/Desktop/NEXOGENESIS-UNO/docs/UNO-对话与分析报告功能实施计划.md) | 分析报告及对话知识成果的实施规划。 |
| [2026-09-08-思维体思考分析与讨论体验设计说明.md](D:/UESR/Desktop/NEXOGENESIS-UNO/docs/history/pre-uno/2026-09-08-思维体思考分析与讨论体验设计说明.md) | 早期思考与讨论体验的设计背景。 |
| [2026-08-19-思维体思考机制分析与agent-loop优化路径.md](D:/UESR/Desktop/NEXOGENESIS-UNO/docs/history/specs/2026-08-19-思维体思考机制分析与agent-loop优化路径.md) | 早期循环、思考机制及优化方向的历史分析。 |
| [2026-08-14-思维体Skill流程与Agentic知识图谱调用设计.md](D:/UESR/Desktop/NEXOGENESIS-UNO/docs/history/specs/2026-08-14-思维体Skill流程与Agentic知识图谱调用设计.md) | 早期 Skill 与知识图谱调用方式的设计来源。 |

## 十、按问题定位文件

| 想回答的问题 | 优先阅读顺序 |
|---|---|
| 为什么新对话没有继续查资料？ | `App.tsx` → `projects.js` → `chat.js` → `quick-thinking.js` |
| 为什么输入“深入研究”也不能升级？ | `client.ts` 的请求参数 → `thinking.js` → `chat.js` 的 quick 状态限制 |
| talk 的原始行为意图是什么？ | `nexo-talk/SKILL.md` → `thinking-body.md` → 普通 `agent.cordis.yml` → 历史设计文档 |
| Skill 到底有没有读？ | 普通预设 Skill 目录 → 原生 filesystem provider → `skill` 工具调用/返回 → 后续请求检查记录 |
| 工具根本没有被调用？ | 当前是否 quick → 普通预设 → 原生 `systemPrompt.assemble` 的工具目录 → 实际模型请求 → 模型返回 |
| 调用了但报错？ | 原生 `dsh-tools` 参数/输出错误 → UNO 工具执行函数 → `run-store.canOperate` → 真实错误回执 |
| 工具说读过，为何回答像没读？ | `read_card/read_cards` 返回正文 → `reading-coverage.js` → 原生会话消息投影 → `model-output.js` / 请求检查器 → 回答的引用与语义 |
| 为什么一直循环、不能收尾？ | 原生 Loop 的结束条件 → `cognition/tools.js` 的 finish → 运行策略版本 → `general-analysis.js` 或 `conversation-analysis.js` |
| 为什么结束了但没有最终答案？ | `turn-state.js` → `analysis-delivery.js` → 原生持久化 `assistant/message` 与 `turn/end` |
| 如何确认编译/建构不是同一个 Loop？ | `uno-jobs.js` 分流 → `book-compile.js` / `construction-service.js` / `construction-host.js` |

排查时至少分清四件事：工具可见、工具执行、材料交付、结论使用。前一项成立不能替后一项作证。恢复研究能力也不能通过放宽写权限、跳过版本检查或把未读材料标为完成来实现。
