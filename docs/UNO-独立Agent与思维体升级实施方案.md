# UNO 独立 Agent 与思维体升级实施方案

日期：2026-09-23。性质：基于现有源码的实施设计，尚未实施，不代表当前服务已经具备下述能力。

## 1. 要完成的成品

UNO 应成为一个能够独立安装、独立运行、独立维护执行内核的知识工作 Agent。用户面对的是同一个持续交流的助手：简单问题直接回答，需要依据时查阅知识，需要研究时自主开展多轮取证和分析；可以纠正方向、暂停、继续，把讨论转成报告或经确认保存的知识。

**采用的架构决定：UNO 自有运行内核 + 一个可按回合调整投入的对话 Agent + 保留现行契约的编译、建构工作流。** 不再由外部 DSH 宿主启动，不把 quick 与研究做成互不兼容的两类会话，不把所有知识操作都交给开放式工具循环。

本方案定义一个完整交付目标，不划分项目阶段。章节是同一成品的组成部分，文末所有验收门共同成立才算完成。

### 1.1 “独立”的硬条件

1. UNO 仓库包含循环、工具调度、上下文组装、执行控制、会话持久化、服务入口和分发脚本的源代码。
2. 生产调用链不引用 `@deepseek-ai/dsh-*`，不依赖全局 `dsh.cmd`、DSH profile、另一项目目录、用户目录中的原生组件或指向这些位置的 junction。
3. 可以使用普通第三方库，但每项直接依赖、锁定版本、用途、许可和发行文件都可查。独立不等于自己实现 HTTP、数据库和所有底层库。
4. DSH 源码可以作为机制和测试参考；实际移植的代码纳入 UNO 维护，并保留来源与许可。不能只把包名改成 UNO，再继续依赖外部 DSH 的服务图。
5. GitHub 源码克隆后可根据锁文件构建；普通用户取得 Windows 发行包后，不安装 DSH、不安装开发工具也能启动。模型联网与密钥仍是模型服务的使用条件，不等于 UNO 宿主依赖。
6. 编译、建构、设置、凭据、附件、会话恢复也脱离 DSH；不能只把聊天循环搬进来，却把其他启动必需服务留在外部。

### 1.2 “思维体”的可验收含义

这里不宣称系统拥有意识或可证明的“真正理解”。产品要求是：

- 能把握当前问题与用户真正需要的交付，区分解释、比较、判断、研究、整理和写入。
- 能根据新证据改变下一步，而非按固定检索路线机械执行。
- 能保留竞争解释、适用条件、反例和未决项，不因第一次生成了答案就只寻找支持。
- 能延续讨论并接受纠正，不把用户未说的事情当作不存在，不把历史模型回答当成事实。
- 能解释结论依赖什么、哪里尚未验证；不展示或保存隐藏思维链来冒充透明度。
- 能把有用讨论转成可复用成果，但不能自行修改知识库、长期偏好或自己的权限。
- 能在失败、预算不足、服务中断时交付真实的部分成果和明确恢复选项。

适用边界为当前单用户知识工作应用，保留项目关联多库能力。此次目标不包含公网多租户、任意代码执行、全电脑控制、无人值守自动学习或通用插件市场。这些不是独立知识 Agent 成立的必要条件；不能据此把当前本地权限机制宣传成多用户隔离。

## 2. 代码研究得到的具体判断

### 2.1 UNO 不是没有知识工作能力，而是入口、执行权与能力交付脱节

| 代码事实 | 用户体验或工程后果 | 本方案决定 |
|---|---|---|
| [App.tsx](D:/UESR/Desktop/NEXOGENESIS-UNO/web/src/App.tsx:635) 默认创建 `quick` 会话；[chat.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/chat.js:158) 拒绝在该会话中混入研究请求 | 有研究后端，不等于默认对话能使用研究；用户需要换会话，讨论上下文被割裂 | 会话不固化 quick/research；每回合指定投入策略 |
| [quick-thinking.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/quick-thinking.js:66) 的意图和回答请求均为 `tools: []` | 当前资料收集由宿主既定路线完成，模型不能收到结果后自主补读、换检索方向 | 普通交流与研究共用自有 LoopRunner；直接回答是零工具的合法结束 |
| [Web 宿主入口](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/index.js:62) 注入 webServer、settings、credentials、sessions；[模型适配](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/model-adapter.js:3) 继承原生适配类型 | 仅修改循环不足以独立启动；轻量对话仍使用外部基础服务 | 明确接管 HTTP、配置、凭据、模型协议、会话和附件服务 |
| [native-request-context.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/uno/native-request-context.js:34) 检查原生私有方法和六参数 `buildRequest` | 运行行为依赖原生内部实现形状，不是稳定公共契约 | 用自有 ModelGateway 的显式请求边界替换方法包装 |
| [native-kimi-budget.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/native-kimi-budget.js:1) 为原生 Kimi 传输包装全局 fetch | 模型独立化不能漏掉 Code Plan、逐请求计数和取消传播 | 自有 Anthropic 协议适配器，传输依赖显式注入，不包装全局 fetch |
| [read_card](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/index.js:257) 部分拒绝和不存在分支把错误写进 `body`，没有设置失败状态 | 模型可能把失败当作读到的内容，难以稳定采取正确恢复动作 | 全部工具使用统一判别式结果；错误不得充当证据正文 |
| 同一工具正文超过 8,000 个 JS 字符单元时截断，参数只有 id、slots，没有通用续读游标 | 对没有合适语义槽/显式单元的长卡，存在反复读取同一前缀而无法完整取证的风险 | 引入绑定版本的分页阅读与交付区间账本；此风险是代码推断，未称已复现全部长卡失败 |
| [operator-registry.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/operator-registry.js)、工具 Schema、认知权限分别登记 | “有这个操作”“模型看见它”“允许执行”“结果进入下一次请求”是四件事 | 建立一个工具定义源与完整调用审计，不再只验证注册数量 |
| [conversation-analysis.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/conversation-analysis.js)、[evidence-inspection.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/cognition/evidence-inspection.js) 已有证据与交付规则 | 不应全部推倒；但旧严格 TM/OPS 数量门槛不应成为每次交流的负担 | 复用证据、版本、来源和交付检查；常规研究不按步骤数量证明质量 |
| [analysis-delivery.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-web-host/lib/analysis-delivery.js) 已区分真实持久化交付与运行结束 | 模型说完成、界面流式出字、最终消息持久化不是同一事实 | 在自有事件事务中保留这一区分 |
| [runtime-profile.json](D:/UESR/Desktop/NEXOGENESIS-UNO/deploy/runtime-profile.json) 仍装配 DSH bundles | 目前程序目录不等于完整运行时闭包 | 发行验证必须在没有 DSH 和开发机目录的干净环境完成 |

以上是源码核验，不是本轮对实际服务的运行诊断。没有据此宣称某个在线请求读错、某个具体工具已经失败，也没有把已有测试数量当成当前运行质量证据。

### 2.2 所提供的 DSH 源码值得借鉴什么

参考树为 `D:/UESR/Desktop/deepseek-harness-master/`，根包标注 `0.1.7-alpha.2`。UNO 根开发依赖标注 `0.1.0-rc.6`，两者不是同一版本。参考树中 `ReactLoopAgent` 的 React 指 ReAct 类循环，不是 React 前端组件。

| DSH 源码 | 实际机制 | UNO 的采用方式 |
|---|---|---|
| [agent-loop/src/agent.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/src/agent.ts) | turn/step 循环，模型输出持久化，工具回灌，截断、重试与取消 | 参考循环不变量，重建 LoopRunner；不继承 Cordis Agent 类 |
| [tool-calls.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/src/tool-calls.ts) | 有界只读并行、exclusive 屏障、结果按模型顺序回灌、取消后排空 | 移植调度原则；UNO 工具必须先证明并行安全 |
| [assistant-stream.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/src/assistant-stream.ts) | 一次模型尝试的流片段、终结与持久化分离 | 自有 StreamAccumulator，半截工具参数不能执行 |
| [inbox.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/src/inbox.ts) | 下一轮与下一步消息队列、领取和恢复 | 自有消息队列，明确“排队提问”和“纠正本次研究” |
| [runtime-context.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/src/runtime-context.ts) | 稳定提示投影与变化上下文分离 | 保留完整事件，构造有界请求；不复制全部过程历史 |
| [tools/src/index.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/tools/src/index.ts) | 调用前准入、执行、结果校验、取消边界及冻结结果 | 缩减为 UNO 所需的工具管线，不引入 PTC/任意程序执行 |
| [tool-skill/src/index.ts](D:/UESR/Desktop/deepseek-harness-master/packages/skill/tool-skill/src/index.ts) | Skill 目录发布与全文加载是不同动作 | 必需技能由 UNO 宿主明确装配，记录正文和引用是否交付 |
| [session-persistence-jsonl/src/lease.ts](D:/UESR/Desktop/deepseek-harness-master/packages/session/session-persistence-jsonl/src/lease.ts)、[format.ts](D:/UESR/Desktop/deepseek-harness-master/packages/session/session-persistence-jsonl/src/format.ts) | 跨进程写所有权、格式版本、已提交日志边界 | 采用单写者、版本化、拒绝损坏数据的原则，不整套搬运原生文件系统组件 |
| [cancel.spec.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/tests/cancel.spec.ts)、[resume.spec.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/tests/resume.spec.ts)、[request-freeze.spec.ts](D:/UESR/Desktop/deepseek-harness-master/packages/core/agent-loop/tests/request-freeze.spec.ts) | 取消竞态、恢复写所有权、流尾、请求不可变等边界用例 | 转成 UNO 接口上的故障测试；不是直接运行后就算 UNO 通过 |

参考版本的 `buildRequest(config, preparedCall, tools, startsRequestSeries, signal)` 为五参数，已经不同于 UNO 现有适配检查。**不采用“将新 DSH 直接替换旧包”的方案。** 新版本还有自己的服务、投影和持久化依赖，复制一个 `agent.ts` 同样不能独立运行。

参考文件指纹：`agent.ts` SHA-256 为 `D77F9602338483BFAED22E3C897FAB8933C7EAC829D2BA944AE60B78DEBA7A12`；`tool-calls.ts` 为 `82D2FF692320A9A26E0F5CD1C2CE1252BFE589138B44706EE18AF033E2B51DF4`。文件夹名称不作为 Git commit 证明。实施时将实际移植清单、原文件哈希和许可放入 `third_party/dsh/`，不要求用户保留该参考目录。

### 2.3 不采用的架构

- **继续包装全局 DSH：** 不满足独立安装与内核控制要求。
- **把整个新 DSH monorepo 改名并搬入 UNO：** 可以得到可控 fork，但会同时接管大量与知识工作无关的宿主、插件和平台代码，不是本项目选择的维护边界。
- **只有一个 while 循环和一段超级提示词：** 缺乏工具协议、取消、恢复、取证、预算和交付，不满足可用成品要求。
- **默认多 Agent 辩论：** 不作为“思维体”的必要条件；增加调用、上下文汇总和生命周期复杂度，当前没有同题对照证据证明必要。
- **把编译与建构全部开放给聊天模型自行调度：** 破坏已有明确的知识提交、修复和恢复契约。

选择工作流与自主循环并存，是依据任务性质作出的工程决定。Anthropic 对两者的区分也强调：工作流按预定路径执行，Agent 根据反馈决定过程；这不能作为 UNO 质量已提高的证据。[机制参考](https://www.anthropic.com/engineering/building-effective-agents)

## 3. 系统组成与所有权

### 3.1 最终调用关系

```text
UNO Web
  → UNO Server：鉴权、会话、SSE、附件、任务控制、设置
      → TurnService → LoopRunner → ModelGateway → 模型供应商
      │                 ↑   ↓
      │            ToolRegistry / ToolScheduler
      │                 ↓
      │       知识检索、分页阅读、图关系、研究状态、成果准备
      │
      → WorkflowRunner → 现有单元编译 / 策略建构宿主
      │                       ↓
      │                  ModelGateway
      │
      → 确认服务 → HarnessGateway → Markdown / 历史 / 收据

共用：RunController、RuntimeStore、BudgetLedger、CredentialStore
知识事实：各库 Markdown；运行事实：UNO runtime.sqlite
```

只有一个通用模型请求出口和一个运行控制器。LoopRunner 负责模型决定下一步；WorkflowRunner 是现有受控执行器的接入层，不再建一套万能工作流 DSL。

### 3.2 代码组织

以下为拟新增或拟重构路径，均相对于 `D:/UESR/Desktop/NEXOGENESIS-UNO/`；不是声称文件已经存在。新增核心继续采用 ESM JavaScript + JSDoc 类型，前后端 DTO 从共享 Schema 生成，不额外引入一套与现有项目脱节的语言构建体系。

| 路径 | 具体职责 |
|---|---|
| `packages/uno-runtime/lib/loop-runner.js` | 回合与步骤循环、工具回灌、终止原因、最终交付 |
| `packages/uno-runtime/lib/run-controller.js` | 执行所有权、取消、暂停、恢复、结束、队列边界 |
| `packages/uno-runtime/lib/turn-service.js` | 同一会话每轮的策略、意图权限、消息接纳与历史映射 |
| `packages/uno-runtime/lib/workflow-runner.js` | 接入已有编译/建构宿主，提供执行句柄，不改变领域协议 |
| `packages/uno-runtime/lib/model-gateway.js` | 冻结请求、预留预算、调用适配器、计费与错误分类 |
| `packages/uno-runtime/lib/providers/openai-compatible.js` | 从现有 model-adapter 提取兼容协议消息与 SSE 逻辑 |
| `packages/uno-runtime/lib/providers/anthropic-compatible.js` | 承接当前 Code Plan 原生协议所需功能，不经过 DSH |
| `packages/uno-runtime/lib/stream-accumulator.js` | 文本、工具参数、终止帧和中断前缀；输出可恢复尝试记录 |
| `packages/uno-runtime/lib/tool-registry.js` | 唯一工具定义源，Schema、能力、效果类型、超时和处理器 |
| `packages/uno-runtime/lib/tool-scheduler.js` | 参数校验、实时权限、并行/串行、结果校验与审计 |
| `packages/uno-runtime/lib/context-builder.js` | 系统规则、当前任务、必要历史、证据与工具结果的有界组装 |
| `packages/uno-runtime/lib/runtime-store.js`、`storage-worker.js` | 会话/回合/研究运行/事件/尝试的事务存储及分页 |
| `packages/uno-runtime/lib/contracts/` | 版本化 JSON Schema、错误码、事件和模型协议类型 |
| `packages/uno-agent/lib/agent-policy.js` | 对话与研究策略、投入额度、资料边界，不硬编码结论 |
| `packages/uno-agent/lib/research-state.js` | 问题、候选判断、证据引用、反例、缺口和下一步 |
| `packages/uno-agent/lib/skill-loader.js` | 受控技能和必需引用装配、版本与请求交付记录 |
| `packages/uno-agent/lib/knowledge-tools.js` | 将现有检索、阅读、图算法接入统一工具契约 |
| `packages/uno-agent/lib/evidence-service.js` | 阅读范围、版本、引用验证与支持/反驳/限定关系 |
| `packages/uno-agent/lib/outcome-service.js` | 知识候选、定向修改、报告、复盘、偏好的单一操作记录 |
| `packages/uno-agent/lib/report-service.js` | 冻结报告内容、审计、Markdown/PDF 渲染与下载恢复 |
| `packages/uno-server/lib/server.js` | Node HTTP 服务、路由装配、静态资源与关机排空 |
| `packages/uno-server/lib/services.js` | 显式依赖注入：构造服务对象，不模拟 Cordis 全部 API |
| `packages/uno-server/lib/security.js` | 请求信任、来源校验、令牌、作用域、路径和附件下载检查 |
| `packages/uno-server/lib/settings-store.js`、`credential-store.js` | 独立设置与凭据访问；密钥不进入模型上下文或普通数据库字段 |
| `packages/uno-server/lib/event-stream.js` | SSE 事件序号、断线重放、背压与终态同步 |
| `packages/uno-server/lib/legacy-import.js` | 只读解析支持的旧会话，离线导入新运行目录，保留原件 |
| `bin/uno.mjs` | `start / doctor / import-legacy / export-diagnostics` 命令入口 |

不把这些包做成可动态加载任意第三方代码的平台。知识算法和 Gateway 继续在现有 `nexogenesis-tools` 包维护，通过明确服务接口调用；包目录名不需要为了显得独立而全部重命名。

### 3.3 替换 DSH 基础服务的完整清单

| 原依赖职责 | UNO 接管方案 |
|---|---|
| Agent 创建与 session.prompt | TurnService、LoopRunner；普通会话不再绑定 DSH preset |
| session 事件、历史、序号、最终消息 | RuntimeStore 的事务事件与消息投影 |
| 模型路由、默认参数、工具协议、流 | ModelGateway + 两类独立协议适配器 + 现有模型能力表 |
| settings、credentials | 自有配置存储、Windows 用户范围加密凭据；设置只保存 credential ID |
| HTTP 与前端静态托管 | 自有 Node HTTP 入口；复用现有 req/res 风格处理器，替换服务依赖 |
| API proxy/RPC | 前端 HTTP DTO 保持兼容；后端直接调用服务，不回环请求 DSH RPC |
| 系统提示、Skill、上下文投影 | ContextBuilder、SkillLoader 和版本化提示资产 |
| 附件、图片读取 | 自有 AttachmentStore，使用稳定 ID、内容哈希、大小和 MIME 校验 |
| 工具审批与提案 | UNO OutcomeService + Gateway，确认操作不由模型伪造 |
| 模型用量、逐次请求计数 | BudgetLedger 与传输出口一一对应，包含重试和恢复请求 |
| 中断与程序退出 | RunController 统一停止传播和实际排空 |
| 打包启动、环境定位 | 项目入口、锁文件、应用/数据路径配置、便携运行包 |

## 4. 一个对话，而不是两套人格或两种会话

### 4.1 用户操作

输入区只需要“自动 / 深入研究”投入选项，默认自动；旁边可以选择资料范围。无需让用户理解 Loop、TM、OPS 或先新建研究会话。

- **自动：** 模型可直接回答，也可使用少量只读工具取得必要资料。已有对话中的“比较一下”“这个说法哪里不成立”不自动变成大型研究。
- **深入研究：** 用户明确选择后，本轮开放研究工具与研究预算；继续使用原 conversation ID、历史与资料范围。
- **自动模式发现超出预算：** 先交付能确定的内容和重要缺口，提供“继续研究”操作；不静默扩增费用。新研究 run 链接原回合，接续证据，不重新开始聊天。
- **报告：** 是成果形式，不是独立会话或深度档。既可把现有讨论整理成报告，也可先研究再报告。

普通回复无需先调用独立的“路由模型”。第一请求本身就能回答或提出工具调用；这样直接问题只需一次模型请求。当前 quick 意图协议保留为评测基线，不在最终生产路径上与新循环并存。

### 4.2 一次连续使用的目标体验

1. 用户问“这个概念怎么理解？”——直接解释；涉及本库特定定义时，按需取得少量正文并引用。
2. 用户追问“它和另一种解释是不是冲突？”——延续当前问题，分清概念、条件、证据是否不同；不足时主动读双方相关段落。
3. 用户说“深入研究一下，找反例。”——原对话中建立研究运行，显示正在核对的问题、资料范围、预算和停止按钮。
4. 模型读到反例后可以撤回原判断，补查决定性条件；不是必须按预先写死的五步表走完。
5. 用户插话“我关心的是短期效应，不是长期均衡。”——这条要求有接纳序号，下一安全步骤生效；界面显示已纳入，不重复启动并行研究。
6. 用户说“先给我目前的结论。”——停止新增取证，交付带缺口的当前结果；不虚构研究已完整。
7. 用户说“整理成报告。”——复用已有证据和论点，只为确实缺失的部分增加请求；渲染失败不重新研究。
8. 用户说“把其中第二个判断存起来。”——准备具体候选与来源，用户确认后 Gateway 保存，并返回真正的卡片/版本/收据。
9. 用户下次回来追问——能够找回相关讨论和研究结果，同时核对知识版本；不把旧模型判断当成新的外部证据。

### 4.3 等待、插话与控制

界面“发送”默认是下一轮消息；研究运行中另提供“补充本次要求”。不猜测用户新消息到底是排队还是打断。

补充消息进入持久队列，下一次模型请求前领取；已发送给供应商的请求不能被事后改写。暂停时保留未领取补充，结束时明确作废或保留为普通消息，不能在用户点结束后自动唤醒任务。

“暂停”“结束”“先交付当前结果”是不同命令：暂停允许原 run 继续；结束不再继续原 run；当前结果会尝试在剩余预算中收尾，不等于立即停止。紧急停止按钮始终直接触发取消，不为了生成总结继续调用模型。

待确认知识草稿不阻塞继续聊天，也不能被“好的”“继续研究”这类不指向具体提案的文本偷偷确认。

现有编译/建构任务的讨论保持只读，与任务执行状态分开。讨论不隐式恢复暂停任务，不让聊天 run 接管其写权限；用户明确点击任务继续才交给 WorkflowRunner。每个会话最多一个前台模型回合，排队消息与运行中的后台知识任务分别展示，不再用一个 `busy` 布尔值封死全部操作。

### 4.4 用户看见的信息

研究卡片默认只显示当前目的、已用请求数、已取得资料数、当前状态和控制按钮。展开后可看资料清单与状态：候选、部分阅读、已交付给模型、已用于结论、读取失败。点击引用直接定位对应版本的片段；版本已变时同时提示当前版本，不悄悄跳到不同正文。

结果优先展示答案，再展示必要条件、主要依据和未决项；不要求每次都输出长篇方法报告。只有研究确实产生了有价值的后续操作，才显示“继续核对缺口 / 整理报告 / 保存这一点”，不每条回复都推销知识写入。

按钮与状态由服务端允许操作生成：`running` 可暂停/停止/补充，`awaiting_user` 可回答/结束，`paused` 可继续/结束，`partial` 可查看成果/继续未完成部分，`completed` 不出现恢复原执行按钮。错误旁的重试只针对失败步骤，不能默认重跑整项研究。

## 5. 思维体的执行契约

### 5.1 指令组成

将当前 preset 中的产品行为收敛为短公共规则，保留 `.agent/skills/nexo-talk/`、`nexo-assess/`、`nexo-report/` 等目的明确的技能；重写其执行接口，不再要求原生 DSH 工具、固定 TM 计数或多个宿主之间接力。

每次请求由五部分组成：公共行为与权限边界、本轮任务、所需技能/方法、有限工作记忆、实际证据及未消费工具结果。编译规范不灌进普通对话，全部方法目录不灌进每次请求。

公共行为至少规定：先回应问题；区分用户信息、来源内容和推断；允许质疑前提；必要时主动查证；不强行使用图谱；没有依据时说明不知道；只有明确请求才准备写入；失败时给实际可行的恢复选项。

### 5.2 技能不是依靠模型“想起来读”的目录

SkillLoader 为每种任务定义 `required_resources`。talk 公共规则每轮必需；研究开始时加载研究契约和必要证据规则；报告才加载报告格式；方法按实际需要加载零到两个。

宿主读取所选技能全文和声明的必需引用，校验路径、哈希和大小，再加入请求。记录 `discovered / loaded / included_in_request / failed`；只有第三种能证明模型收到了指令，仍不能证明遵守或理解。

必需引用缺失时阻止对应能力开始，提供“修复安装 / 改为普通只读交流”。不能以技能目录可见替代全文加载。任意知识卡、附件或网页都不能冒充 Skill；模型也不能通过读取路径加载未批准的系统指令。

可选方法使用有限 `select_method` 工具，返回已安装方法的正文；工具结果进入下一请求后才标记交付。`nexo-deep-think` 固定压力测试与严格评测规则留在测试配置，不作为普通研究完成条件。

### 5.3 有界研究状态

ResearchState 存储的是可审计工作结果，不是隐藏推理全文：

```json
{
  "question": "当前要回答的问题",
  "deliverable": "条件式判断",
  "scope": {"knowledge_base_ids": ["kb-id"], "as_of": null},
  "claims": [{"id": "C1", "text": "候选判断", "status": "hypothesis",
              "supports": [], "challenges": [], "qualifications": []}],
  "open_questions": [{"id": "Q1", "text": "哪个条件会改变判断？", "importance": "decisive"}],
  "discarded_explanations": [],
  "next_action": {"kind": "read", "purpose": "核对决定性反例"},
  "evidence_ids": [],
  "user_constraints": []
}
```

模型可通过 `update_research` 提交局部状态变化；宿主验证 ID、范围和证据引用。普通直接回答不要求创建这些表项，也不为每个动作额外调用一个模型写计划。

研究开始可用一到三句说明目标与待核对问题。中途只有方向、证据、缺口或状态发生实质变化才更新进度。前端展示“正在核对两个解释的成立条件”，不展示逐 token 的内部推理。

### 5.4 自主性的具体约束

- 每次取证应针对能影响回答的问题，而不是“再找几张卡”。选择下一步可以由模型决定；程序记录用途但不能凭用途文本证明行动有效。
- 比较和研判必须考虑相关的竞争解释或反例。没有找到时标注搜索范围和空结果，不伪造反例来满足模板。
- 图的关系与路径是找资料的线索。关系陈述需要读取相关端点；因果结论不能只引用连边或同领域。
- 记录重复查询指纹与证据增量。同一参数、同一版本连续重复两次，宿主返回已有结果和重复提示；第三次不再执行该重复操作。可以换合理查询，但不能换工具绕权限。
- 连续三个研究步骤没有新增资料、问题澄清或判断修订时进入收尾/询问分支。计数只是循环保护，不是质量评分。
- 澄清只用于会实质改变范围、判断或成本的信息；能安全明确假设继续的，不用每次追问用户。
- 结论中明确事实、综合解释和待验证主张；缺失不等于否定，模型先前输出不等于独立来源。

### 5.5 收尾与检查

普通交流：完成最终文本和引用的确定性检查后交付，不默认多一次模型审核。

深入研究：先形成结构化结论包（结论、条件、支持、反证、缺口），宿主检查引用是否交付、来源是否有效、范围是否越界。再用一个无工具、无完整过程历史的独立请求检查关键论点与证据是否匹配；最多一次局部修正。审核、修正均占同一预算，不保证审核模型一定正确。

最后输出仍由主 Agent 形成，不能让审核提示替代用户目标。审核超时或预算不足时可交付“部分完成、未完成独立核对”的结果；已发现的实质矛盾不能悄悄保留为确定结论。对非证据型创意讨论不强行套用事实审计。

## 6. LoopRunner：真正接管模型—工具—模型

### 6.1 执行边界

```text
接纳消息并持久化 → 获取会话执行所有权 → 建立 run/turn
  → 领取补充要求、检查停止/权限/预算
  → 组装并冻结请求 → 持久化请求预留 → 模型流
  → 完整响应或中断尝试落盘
  → 有完整工具调用：校验、调度、保存结果 → 下一请求
  → 无工具调用：交付检查 → 原子保存最终消息与交付事件
  → completed / partial / awaiting_user / paused / cancelled / failed
```

每次模型请求必须有独立 `request_id` 和 `attempt_id`。网络重试是新的 attempt，不能重复记作同一个成功调用，也不能免计预算。

工具调用只在完整响应确认且参数通过校验后执行。流中途出现 tool-call 名称不表示工具已经开始；只收到半段 JSON、`max_tokens` 截断或协议终止不完整时，不执行半成品调用。

模型同时输出自然语言与工具调用时，文字作为本步说明；工具完成后必须回灌，再允许最终回答。不能在第一次出现自然语言时就把研究标为 completed。

### 6.2 核心类型

```text
ExecutionContext:
  principal_id, conversation_id, run_id, turn_id, attempt_id,
  project_id, allowed_kb_ids, write_kb_id?, workflow_contract?,
  model_snapshot, instruction_snapshot, tool_manifest_hash,
  budget_id, authority_epoch, signal

ModelRequest:
  request_id, provider, model, messages, tools, reasoning_options,
  max_output_tokens, context_manifest, purpose

ModelEvent:
  text_delta | tool_delta | usage | completed | failed

ExecutionHandle:
  submit(), steer(), pause(), cancel(), resume(), whenIdle()
```

Context 中身份、模型、协议和资料范围按回合冻结；`signal` 和实时授权校验不能冻结失效。所有工具在实际开始和知识提交边界再次检查 RunController 的状态与权限版本。

模型供应商要求的 opaque replay state 由适配器处理，不能和用户可见消息混为一谈。确需协议回传的数据单独保护、限定保留范围，不保存或展示隐藏思维链文本；如果某供应商无法在此约束下完成工具续轮，标注能力不支持，不用丢字段伪装兼容。

### 6.3 工具目录与调度

单次请求冻结一个工具目录。允许读取类任务并发上限为 3，但仅限声明为 `parallel_safe` 且没有共享可变副作用的工具。现有工具可能更新阅读账本或 seen set，不能因为名为 read 就直接 Promise.all。

读取并行时先返回不可变读取结果，阅读记录由宿主按顺序集中写入；共享结构变更、研究状态更新、成果准备和确认串行执行。回灌结果按模型 tool-call 顺序排列，并保存实际开始/结束时间。

工具具有独立超时及任务总取消信号。不能用 Promise.race 超时后放任后台工作继续写入；需要硬中止的解析、PDF 或耗时计算在受控子进程/worker 中运行。模型没有 shell 或任意代码工具。

### 6.4 对外接口与事件协议

保留已有页面所用路由的兼容响应，通过以下版本化服务协议归一化。兼容层只转换 DTO，不能再转发到原生 DSH。

| 拟议接口 | 输入关键字段 | 返回与幂等要求 |
|---|---|---|
| `POST /api/conversations` | `project_id, knowledge_scope` | `conversation_id`；不保存永久 quick 类型 |
| `POST /api/conversations/:id/turns` | `client_message_id, content, effort:auto\|research, source_scope, expected_revision` | 事务接纳后返回 `turn_id, run_id, sequence`，不等模型输出才响应；相同 client_message_id 返回同一回合 |
| `GET /api/conversations/:id/events` | `after_sequence` 或 Last-Event-ID | SSE 补发与实时事件；越权先拒绝 |
| `GET /api/conversations/:id/messages` | `before_sequence, limit` | 有界分页，不回传全部工具正文 |
| `POST /api/runs/:id/control` | `command_id, action:pause\|cancel\|deliver_current, expected_revision` | 已接纳命令与最新状态；是否排空由后续事件确认 |
| `POST /api/runs/:id/steer` | `client_message_id, content` | `queued_sequence`；被下一步领取后发 `steer.applied` |
| `POST /api/runs/:id/resume` | `command_id, expected_revision, grant_requests?` | 原 run 的新 execution epoch；重复命令不补两次额度 |
| `POST /api/interactions/:id/answer` | `command_id, answer` | 仅恢复所属 run，旧问题/已终态拒绝 |
| `GET /api/operations/:id` | operation ID | 草稿、目标版本、状态、收据及允许操作 |
| `POST /api/operations/:id/confirm` | `command_id, candidate_hash, confirmation_token` | 原子接纳一次确认；提交未知返回确认中，不能假装成功 |
| `GET /api/artifacts/:id` | 受管 artifact ID | 授权下载，不接受文件路径 |

HTTP 错误统一为 `{error:{code,message,retryable,recovery}, request_id}`。版本冲突用 409，参数失败用 400，授权失败用 403；HTTP 200 中的工具业务失败仍使用 `ok:false`，客户端不能只按 HTTP 成功显示任务完成。

持久事件最少包含 `turn.accepted / run.started / request.started / request.settled / tool.started / tool.settled / steer.applied / interaction.requested / run.state_changed / message.committed / outcome.updated`。临时文本增量另带 `attempt_id + chunk_sequence`；最终提交时用确定消息 ID 替换同一流式草稿，不追加第二份答案。

事件持久化失败则不能发送“已提交”事件。模型请求内容和工具结果保存为私有审计对象，UI 事件只携带摘要与受权访问 ID，避免每次进度广播把整段知识正文发送给无关页面。

## 7. 工具契约与“真正读到”的证据

### 7.1 对话实际开放的工具

| 工具 | 能力与限额 | 开放条件 |
|---|---|---|
| `search_evidence` | 基于现有路线检索，最多 6 个摘要候选及 3 个已读取正文片段，共 12,000 字符；逐项来源与版本 | 自动模式的主要取证入口，避免简单问题先搜再逐张读 |
| `search_knowledge` | 按问题、关键词、来源或领域找候选，最多 12 项；摘要明确不是正文 | 研究 |
| `read_knowledge` | 一次最多 3 个卡片/已授权来源对象，共享 12,000 字符；逐对象游标 | 研究，或自动模式有限补读 |
| `explore_relations` | 有界邻居/路径查询，最多 2 跳、20 个节点；保留边方向、类型、版本 | 研究，结果只作导航 |
| `read_source` | 按合法来源映射读原文区间，每次最多 12,000 字符；提取缺口显式返回 | 研究核对来源时 |
| `read_conversation` | 读取授权会话的相关消息/成果，分页，保留说话者和时间 | 需要找回历史讨论时；其他会话须在项目授权范围 |
| `select_method` | 读取已批准的分析方法说明 | 研究，可不用 |
| `update_research` | 更新结构化问题/论点/缺口，不修改知识 | 研究，串行 |
| `ask_user` | 提交一个明确的缺失条件或权限选择，结束本轮活动等待 | 所有模式按需 |
| `prepare_outcome` | 为明确要求准备保存、修订、报告或复盘成果；不发布知识 | 宿主已从用户操作获得相应意图能力时 |

工具由一个注册源生成模型描述、输入/输出 Schema、权限标识、UI 名称与测试样本。JSON Schema 使用标准 `required` 数组，不把 DSH 自定义字段写法直接交给新验证器。拟采用 Ajv，启动时编译并缓存 Schema，不在每次调用重新编译。[Ajv 官方管理建议](https://ajv.js.org/guide/managing-schemas.html)

普通聊天不暴露全部旧认知工具、编译工具和写入工具。必要时通过明确技能扩展工具集合，但每轮都要记录实际发出的目录；未知工具名返回 `TOOL_NOT_AVAILABLE`，不回退到任意函数调用。

### 7.2 标准返回结构

```json
{
  "ok": true,
  "status": "partial",
  "data": {"items": []},
  "coverage": {"complete": false, "reason": "page_limit"},
  "evidence": [],
  "next_cursor": "opaque-version-bound-cursor",
  "warnings": [],
  "execution": {"call_id": "call-1", "cache_hit": false}
}
```

成功状态为 `complete / partial / empty`；失败为 `ok:false, status:"failed", error:{code,message,retryable,recovery}`。批量调用还需逐项状态。`empty` 表示成功查询但没有结果；`failed` 表示没有获得有效查询结果，绝不可都折叠为 `[]`。

Schema 验证错误必须标明参数路径、期待类型和是否执行过，不依赖中文错误消息正则判断。输出 Schema 不合格返回 `TOOL_OUTPUT_INVALID`，隔离原始结果用于诊断；不能把未校验结果当证据送入后续判断。

### 7.3 阅读游标与账本

每个阅读对象标识为 `kb_id + object_id + revision/hash`。分页以规范化 Markdown 的 Unicode code point 半开区间计数，统一处理 CRLF；游标包含对象版本和下一区间，宿主签名并校验，模型不能自行构造路径或越过授权范围。

证据记录包含：对象与库、内容版本、来源角色、实际片段、起止位置、片段哈希、对应工具调用、被加入的请求 ID、提取完整性。`loaded`、`included_in_request` 和 `cited` 分开，工具读到但被上下文裁掉的内容不能当作本轮模型已读。

同一版本的区间可以合并证明交付覆盖，但全文覆盖不等于理解正确。片段足以支持局部判断时无需强制读整卡；声称总结整篇/整卡或作整体修订则必须满足相应覆盖。没有显式单元的旧卡同样支持通用分页。

数据变更导致游标过期返回 `STALE_REVISION`；重新读取新版本并失效旧引用，不拼接两个版本后声称读完。旧快照可以作为注明时点的历史证据，但不能当作当前正文。

### 7.4 失败后的具体动作

| 错误/状态 | 宿主与 Agent 行为 | 用户兜底 |
|---|---|---|
| `INVALID_ARGUMENTS` | 未执行；允许模型按错误定位修正一次 | 持续失败时展示能力故障，可继续只用已有证据 |
| `NOT_FOUND` | 标注对象缺失；允许在原范围重新检索 | 选择其他资料/修正 ID |
| `PERMISSION_DENIED / SCOPE_VIOLATION` | 不自动重试，不换工具绕过 | 明确选择范围或取消相关操作 |
| `PARTIAL_READ / EXTRACTION_GAP` | 使用游标继续或保留未读缺口 | 打开来源、补充可读材料 |
| `STALE_REVISION` | 重新取得版本并重新检查受影响判断 | 保留旧结果为历史，不覆盖新知识 |
| `TIMEOUT / NETWORK_ERROR` | 只读幂等请求最多自动重试一次；受总预算约束 | 重试该步骤/当前结果/结束 |
| `AUTH_REQUIRED / QUOTA_EXCEEDED` | 暂停，不循环重试 | 修复凭据或额度后继续 |
| `RATE_LIMITED` | 不反复 429；显示供应商重试时间，有界等待需可停止 | 稍后继续/换模型并建立新模型快照 |
| `COMMIT_UNKNOWN` | 先查 operation ID 的 Gateway 收据 | 确认中；不得直接重放写入 |
| `TOOL_OUTPUT_INVALID` | 隔离结果，记录具体 Schema 路径 | 使用其他有效资料或报告工具问题 |
| `STORAGE_FAILED` | 停止新请求和新写入，不显示已保存 | 释放空间/导出尚存结果/修复后恢复 |

## 8. 上下文、记忆与性能预算

### 8.1 三种记录，不混成一份长对话

1. **原始会话记录：** 用户与助手消息、工具事件及交付，持久保留，可分页查看。
2. **本次研究工作记忆：** 目标、约束、有效证据、候选结论、缺口与下一步，有界投影。
3. **用户明确保存的长期内容：** 知识经 Gateway 保存；偏好保存于 Profile 的有限配置。模型不能把一次反馈自动升级为永久系统规则。

历史摘要标注 `derived_from_message_ids`、摘要版本和生成时间；它是导航及记忆投影，不成为独立知识事实。涉及重要历史原话时取回原消息，无法取回就说明缺口。不得为了减少上下文而删除原始记录。

### 8.2 预算默认值

下列为拟议产品默认值，不是实测最优值，也不覆盖现有编译/建构已冻结的预算。

| 项目 | 自动交流 | 深入研究 |
|---|---|---|
| 正常直接回答 | 1 次模型请求、0 次工具 | 不强制使用满额度 |
| 每次授权模型尝试上限 | 3 次，含错误恢复 | 12 次，至少预留 3 次用于核对、局部修正和最终交付 |
| 工具执行上限 | 4 次 | 24 次，批量逐项读写也记录成本 |
| 累计活动时间 | 3 分钟 | 15 分钟；等待用户时不计活动时间 |
| 工作记忆目标上限 | 4,000 Unicode 字符 | 8,000 Unicode 字符 |
| 单步正文证据上限 | 12,000 Unicode 字符 | 24,000 Unicode 字符，按需而非填满 |
| 方法 | 通常不加载 | 零到两个按需加载 |

每次请求实际输入还必须满足模型能力上限，预留输出与安全余量；若模型提供 tokenizer 就实计，否则用保守估算，不能把字符数等同于 token。小上下文模型缩小证据包；无法容纳必要材料则暂停/局部交付，不暗中裁掉决定性证据。

预算包含审核、格式恢复、压缩、网络重试和失败请求，不只计成功回答。费用单价未知时显示“费用未知”与真实请求/token 数，不能显示为零。用户继续研究只增加一次明确额度，保留全部历史消耗，并发/重复点击不叠加。

### 8.3 上下文压缩与复用

- 公共指令、工具 Schema、方法说明按版本缓存，保持稳定顺序；不承诺所有模型供应商都会缓存命中。
- 最近对话按相关性与预算组装，不只机械取固定四轮；明确的用户要求和尚未解决的问题优先保留。
- 已完成工具结果按版本去重；当前待回灌结果不能因压缩消失，tool-call/tool-result 必须成对。
- 优先从结构化研究状态确定性生成工作记忆。确需模型摘要时计入预算，不每轮额外做一次摘要。
- 在输入达到可用预算的 70% 时整理历史投影；最终外发前重新核算完整 wire body。临界请求宁可减少导航摘要，不丢未处理的错误和决定性来源片段。
- 来源正文按 `kb_id + revision + range` 缓存，不按“当前库”全局缓存。切库、修订、退役和权限变化及时失效。
- 大图查询、文档提取、PDF 渲染离开主事件循环；SSE 合并小片段，建议 50–100ms 一次，队列有上限与背压。
- 应用模型请求并发默认最多 2 个，单 run 串行；前台对话优先于尚未开始的后台请求，已发送请求不为抢占而重发。编译、建构和研究共用供应商并发限制，队列显示等待原因，并有公平调度避免后台永久饥饿。

输入 token、首字延迟、总延迟、数据库等待、工具时间、缓存命中分别记录。不把“循环运行过”或“回答更长”当作性能或认知提升。

## 9. 会话、任务和持久化

### 9.1 实体与唯一事实位置

| 实体 | 含义与权威位置 |
|---|---|
| Conversation | 用户持续交流的容器；RuntimeStore，包含项目和资料范围策略 |
| Turn | 一条被接纳的用户请求及其回答；RuntimeStore，不等于整个研究任务 |
| Run | 一次可暂停/继续的研究执行；RuntimeStore，绑定 conversation 和预算 |
| Attempt | 一次真正外发模型请求或工具尝试；RuntimeStore/请求账本 |
| Workflow job | 现有编译/建构领域进度；继续由现有任务存储负责，不复制一份可写 job 状态到新库 |
| Outcome operation | 一次候选准备、确认、报告等成果操作；RuntimeStore，绑定原消息和具体版本 |
| Knowledge / receipt | 正式 Markdown、历史与 Gateway 收据，仍在所属知识实例中 |

RunController 控制“此刻谁在执行、能否再发请求/写入”；Workflow job 决定“哪些单元/卡片已完成”。执行状态与业务进度是不同事实，通过执行句柄和收据对账，不维护两份互相覆盖的 `completed`。

保留 `owner_session_id`、参与会话列表及任务归属的等价关系。会话删除、任务控制、消息事件与附件访问必须检查完整归属，不能只查单个当前 session ID。

### 9.2 存储选择

运行状态采用本地 SQLite `runtime.sqlite`，通过单独 storage worker 和单连接串行事务访问。拟使用锁文件固定的 `better-sqlite3`，不把数据库同步调用放进 HTTP 主线程；其同步 API、事务及 worker 支持可由官方项目核对。[依赖说明](https://github.com/WiseLibs/better-sqlite3)

主要表：`conversations`、`turns`、`runs`、`events`、`messages`、`requests`、`tool_calls`、`evidence`、`operations`、`inbox`。每条事件含 `schema_version / sequence / conversation_id / run_id / attempt_id / type / timestamp`。事件、状态投影和最终消息在同一事务更新，使用唯一键防止重复交付。

最低数据库约束：`turns(conversation_id,client_message_id)` 唯一、`events(conversation_id,sequence)` 唯一、`tool_calls(attempt_id,tool_call_id)` 唯一、`operations(operation_id,candidate_revision)` 唯一；命令有独立去重表，状态更新带 revision 比较。活跃运行与历史消息分页所需索引在 schema migration 中声明，不依赖前端去重补数据库缺口。

RuntimeStore 与 Markdown Gateway 不是一个跨介质原子事务。确认操作先持久化提交意图与稳定 operation ID，再调用 Gateway；返回后写入收据引用。若在两者之间崩溃，恢复器按原 operation ID 查询 Gateway 收据来完成对账；没有收据且结果未知时保持 `needs_attention`，不得凭数据库状态推断 Markdown 已写入或未写入。

请求快照和原始工具结果按 run 分目录保存，数据库保存哈希与索引；不能让数据库无限膨胀成全库副本。诊断详细载荷默认保留 30 天，可配置容量；活跃/待恢复任务所需载荷、最终消息、预算账本和正式收据引用不因普通 TTL 被清理。自动清理只处理声明为可清理的诊断数据，不触碰知识、归档原书、来源单元或用户成果。

采用 WAL、`synchronous=FULL`、外键检查、有界 busy timeout；短事务，不在数据库事务内等模型。运行目录必须是本机文件系统，拒绝把 WAL 数据库放在网络共享路径；SQLite WAL 只允许一个同时写者，不能据此宣称具备多租户并发能力。[SQLite WAL 文档](https://www.sqlite.org/wal.html)

发行检查读取真正嵌入的 SQLite 版本；选用包含 WAL-reset 修复的版本，例如 3.51.3 或更新版本，而不是只核对 npm 包名。SQLite 官方列明了修复版本与适用条件。[修复说明](https://www.sqlite.org/wal.html#the_wal_reset_bug)

程序使用运行目录锁排除第二个宿主：锁含本机进程身份及随机 owner token；只在可证明旧 owner 已退出时接管，不因 TTL 到期抢占仍存活的进程。所有写入入口和 Gateway 桥接验证 owner/epoch；不允许两个应用实例各持一套内存权限状态写同一个运行目录。

### 9.3 取消与恢复

- 先持久化停止意图，再撤销执行能力、触发取消信号，停止新增工具和模型请求。
- 状态先变为 `stopping`，真正排空后才变为 `paused/cancelled`。超时仍未排空显示故障，不假称已经停止。
- 用户停止前已越过 Gateway 提交线性化点的事务需完成或回滚并查收据；不能把已提交知识改称取消。停止意图生效后不允许新事务进入提交。
- 迟到的模型输出、工具异常或 SSE 事件带 attempt/epoch；不能覆盖终态或把任务重新激活。
- 崩溃重启将未终结执行标为 interrupted，核对请求、工具结果和 Gateway 收据后提供恢复；不能自动重发结果未知的写入。
- 已成功保存的工具结果可以重放给模型，不再执行同一工具。尚未完成的纯读取可重新执行，但生成新的尝试记录。
- 模型网络请求通常不能跨进程接续原 token 流；重启后的“继续”是用持久检查点发新请求，不伪装无损续流。
- 预算记录不可用或持久化失败时阻止外发，避免不可审计的付费请求。

### 9.4 浏览器断线与后端任务

SSE 使用递增事件 ID，重连携带 `Last-Event-ID`；服务器重放已持久事件，再接实时流。用户消息携带 `client_message_id`，重复提交返回原 turn，不启动重复模型请求。

浏览器断线不自动等于用户取消。后端可在既定预算内继续，界面重连后取得真实状态；用户主动停止通过单独控制请求确认。消息流结束、回答落盘、报告可下载、知识已保存显示为不同状态。

## 10. 知识成果、报告、复盘与偏好

### 10.1 一套成果操作记录

复用既有对话成果设计中的五类能力：沉淀、定向修订、研究与报告、复盘、方法/知识利用改进。统一 Outcome operation，不同时在旧 pending、CognitiveRun 和 UNO job 三处登记同一新草稿。

状态为 `preparing → awaiting_confirmation → committing → completed`，另有 `partial / needs_attention / cancelled / failed`。报告无需知识发布确认，但涉及新范围、付费扩额或覆盖已有文件时另行取得明确授权。

### 10.2 保存与修订

准备时冻结目标库、目标卡片版本、候选正文、来源、关系端点、操作类型和内容哈希。确认页面展示实际内容与影响范围，并发出的 confirmation token 绑定 operation ID、内容哈希、目标版本和用户身份；模型不能生成有效确认令牌。

用户要求修改候选后生成新候选版本，旧确认失效。确认前再次校验权限、卡片与来源版本；真正提交仍由 HarnessGateway 处理。重复点击查询同一收据，不重复创建卡片。版本冲突时给“查看当前内容 / 重新准备 / 取消”，不覆盖冲突版本。

保存的知识保持唯一主类型、合法领域、来源与关系契约。新领域及挂靠通过独立领域治理事务；研究模型不能借保存观点自动新建领域。知识候选准备不是阅读知识库之外的任意写文件能力。

### 10.3 报告

报告绑定研究快照、时点和证据集合，提供 Markdown 与 PDF。正文内容确定后再渲染，PDF 字体、分页、表格溢出、引用链接与下载均验收。

“整理刚才讨论”仅使用已经取得的材料，不默认重新研究。需要补资料时明确新增范围与预算；报告生成失败只恢复相应步骤，渲染失败直接提供 Markdown 和“重试导出”，不丢失研究成果。

报告和请求附件进入受管成果目录，通过 artifact ID 下载，不接受任意服务器绝对路径。报告输出不是知识卡；要保存其中判断仍须单独走 Gateway。

### 10.4 复盘与方法偏好

复盘冻结原判断当时可用信息和当前新增信息，区分依据错误、遗漏条件、后续变化与随机结果。不能用今天的信息重写昨天的记录，也不把一次结果好坏当成方法有效性证明。

“这一轮简短些”只作用于当前要求；“以后回答默认简短”可保存为有限表达偏好并提供撤销。方法改进产生有适用范围和证据的候选；模型不得修改系统提示、程序、权限或预算。方法正文的正式知识版本与启用配置分离，配置只引用版本及作用范围。

## 11. 模型适配与安全边界

### 11.1 模型兼容不能只测试一句“你好”

保留当前 [model-providers.js](D:/UESR/Desktop/NEXOGENESIS-UNO/packages/nexogenesis-tools/lib/model-providers.js) 的能力登记与精确模型选择，迁移现有协议编码和输出预算规则，不趁独立化替用户换模型或降低思考设置。

每个已支持供应商必须核对：工具参数增量、多个工具调用、工具结果回传、思考参数、最大输出、使用量/缓存用量、图片、错误帧、截断、重试、取消。Kimi API 与 Kimi Code Plan 是不同接入，不能用一套兼容 URL 替代原生 Code Plan 行为。

模型能力包括 `tools / streaming / vision / reasoning_controls / context_window / max_output / usage_reporting`，未知不等于支持。不支持工具的模型不能被标为研究可用：界面说明并允许换模型或继续无工具交流，不隐式降级仍显示研究完成。

模型网关依赖显式传输函数与凭据服务，API headers 不进入检查器。每个真正 HTTP dispatch 先持久预留预算；SDK 若有内部自动重试应关闭或纳入同一计数入口，不能产生计数之外的请求。

### 11.2 默认权限

- 本地服务默认只绑定 loopback，保留 Host/Origin 检查和防跨站请求机制；请求令牌不能放进普通日志或公开 URL。
- UI、会话、运行、附件、提案和知识库均检查相同 principal/scope。知道 ID 不等于有权读取。
- 提示注入防护不能只靠一段文字：检索内容标记为不可信数据，不能触发写权限、扩大库范围或调用系统工具；工具层与 Gateway 执行实际拦截。
- 每个 run 固定允许库 ID；用户切换 UI 当前库不改变在途任务。跨库引用使用完整库 ID，禁止裸 card ID 产生歧义。
- 知识目录、上传目录和成果目录经过 realpath/reparse-point 范围检查；读取、下载与写入都防止路径穿越和链接逃逸。
- 自定义模型端点只允许用户明确配置；禁止携带凭据跨重定向。访问本地模型与访问外网模型是不同信任配置，模型不能自己修改地址。
- 凭据用 Windows 用户范围保护，配置仅保存引用；解密失败要求重新输入，不能回退明文。备份/诊断/分发默认不携带密钥。
- 普通对话与研究不开放通用 shell、任意文件写入、代码执行、模型自行安装 Skill 或任意 MCP 服务。

当前没有接通并验收的外部联网检索，不在此方案中伪称已经存在。目标研究以授权知识库、可读来源和用户提供的材料为依据；涉及“最新”且没有实时来源时明确时间缺口。若需外网研究工具，应作为另一个有供应商、费用与外发数据边界的明确能力需求，不能偷偷把本地知识上传到搜索服务。

## 12. 现有文件逐项处理

| 现有文件/目录 | 实施动作与完成结果 |
|---|---|
| `web/src/App.tsx`、`api/client.ts` | 去掉新会话 quick 固化；增加回合策略、run ID、预算和资料范围 DTO |
| `ChatComposer.tsx`、`ChatPanel.tsx` | 同一会话研究、补充要求、排队发送、停止、继续与当前成果；不增加多套聊天入口 |
| `ConversationControls.tsx`、`ConversationStateCard.tsx`、`conversations/state.ts` | 以服务端序号和真实状态更新；草稿不阻塞聊天，迟到流不覆盖终态 |
| `PromptInspector.tsx` | 展示实际模型/请求/工具目录/证据交付/用量，不显示密钥或隐藏思维链 |
| `nexogenesis-web-host/lib/index.js` | 改为自有 HTTP 路由装配；移除 Cordis、原生静态托管和运行时注入依赖 |
| `chat.js`、`thinking.js`、`projects.js` | 接 TurnService/RuntimeStore；保留必要 HTTP 兼容映射，删除模式互斥与原生 session.prompt 调用 |
| `quick-thinking.js`、`thinking-intent.js` | 保留受控基线夹具；从最终生产路径退出，不形成第二个对话执行器 |
| `thinking-routes.js`、`project-knowledge.js` | 保留有效检索与跨库逻辑，抽出无 DSH 依赖服务，供 search_evidence 使用 |
| `rpc.js` | 保留/迁移必要 HTTP 安全、SSE 与错误辅助；去掉原生 apiProxy/会话 RPC |
| `session-events.js`、`meta.js` | 新会话使用自有 Schema/数据库；旧 quick 事件只在兼容导入器解析，不再修改原生事件 Set |
| `model-adapter.js`、`native-kimi-budget.js`、`model-credentials.js`、`settings.js` | 提取并接入自有模型、预算、配置和凭据服务；移除继承和全局 fetch 包装 |
| `prompt-inspector.js`、`latency-telemetry.js` | 保留可观测性，统一 request/attempt/run 关联，增加工具结果实际交付记录 |
| `work.js`、`conversation-control.js`、`cognition.js`、`turn-state.js` | 接 RunController，不再轮询原生会话来猜执行状态；保留归属与操作互斥规则 |
| `analysis-delivery.js` | 改为自有事件/消息事务对账，保留已交付、部分交付、中断的区别 |
| `nexogenesis-tools/lib/index.js` | 将工具业务处理器与 DSH register/defineTool 分开；新注册源生成统一 Schema |
| `cognition/operator-registry.js`、`cognition/tools.js` | 去重能力登记；保留必要操作，移除常规研究机械工具打卡与隐式双状态 |
| `cognition/run-store.js`、`working-memory.js`、`model-output.js` | 迁移研究运行与有界投影到 RuntimeStore/ResearchState；旧存储只作导入兼容 |
| `conversation-analysis.js`、`evidence-inspection.js`、`reading-coverage.js` | 保留证据规则并扩展版本化分页、请求交付、局部判断覆盖 |
| `general-analysis.js`、`thinking-models.js`、`schemes/default/thinking-models/` | 通用预算抽离；严格测试与日常方法分开，方法按需交付 |
| `cards.js`、`card-units.js`、`graph-ops.js`、`compile/source-ledger.js` | 复用算法；增加统一分页和不可变调用上下文，不自动重建真实知识 |
| `instances/registry.js` | 应用选中库只服务 UI 默认值；执行工具使用冻结实例上下文，移除执行时对全局“当前库”的隐式依赖 |
| `harness/gateway.js` | 保留知识事务规则；接新身份、取消提交门和真实收据对账，不扩大写权限 |
| `pending.js`、`write.js` | 新成果使用单一 operation 存储；旧提案只读导入、确认版本与幂等信息保留 |
| `uno-jobs.js`、`book-compile.js`、`unit-card-request.js` | 接 WorkflowRunner 与 ModelGateway；当前 v3 单元请求仍无工具，账本、隔离、恢复、领域治理不改 |
| `construction-service.js`、`construction-request.js` | 接共享服务；保留策略、选卡、独立作者/审核、局部修复及 Gateway 提交 |
| `construction-host.js`、`uno/construction-workflow.js`、`uno/agent.js` | 将当前仍允许恢复的历史建构协议接自有执行接口；不保留 DSH 执行器，也不把历史任务改签为新协议 |
| `uno/native-request-context.js`、`uno/request-context.js`、`uno/request-budget.js` | 移除原生方法形状检查；保留请求范围、上下文和外发预算不变量，进入显式网关 |
| `presets/*/agent.cordis.yml`、`patch/cordis.patch.yml` | 提取有用提示资产和业务配置；最终生产装配不再使用 Cordis presets/patch |
| `prepare-nexogenesis.ps1`、`start-nexogenesis.ps1`、`deploy/runtime.ps1` | 改用项目入口与明确应用/数据路径；不探测 dsh.cmd，不链接外部包 |
| `deploy/runtime-profile.json`、根/包 `package.json` 与锁文件 | 声明完整自有工作区依赖，删除生产 DSH 依赖；构建不依赖全局安装 |
| `tools/export-clean-agent.ps1`、`deploy/clean-agent-distribution.json` | 保留默认干净导出入口，增加可运行发行格式与清单；不混入真实知识与运行数据 |

迁移现有处理器采用显式 `services` 参数，不实现一个看似原生 `ctx` 的万能兼容对象作为最终架构。历史 HTTP 字段可以兼容；运行时的私有 API 耦合不保留。

## 13. 分发、历史数据与撤回

### 13.1 两种明确的交付物

**源码包：** UNO 全部自有源码、工作区 manifest、锁文件、测试、模板、Skill、许可和构建说明。`npm ci` 后可以构建与测试；不包含 node_modules、密钥、知识库和运行状态。

**Windows 可运行包：** 已构建前端、自有服务器、锁定的 Node 运行时、生产依赖及原生二进制、现有编译所需 Python/提取依赖、PDF 渲染所需资源、启动器、校验清单与许可。语音等按需资源若分离分发，设置页必须准确显示缺失项和受校验的安装入口；不能影响基本对话与知识工作启动。

应用根目录与数据目录独立，首次启动选择/创建 UNO 数据目录，不自动寻找旧 DSH 知识库。升级替换应用文件，不覆盖数据。Node、数据库原生依赖、Python 与渲染组件必须按目标平台配套验证，不能在用户启动时要求临时装 C++ 编译工具。

`uno doctor` 报告实际进程入口、应用版本/构建哈希、数据根、模型协议能力、工具清单、数据库版本、缺失资源和外部路径依赖。健康标记本身不是语义质量证明。

发行包进行静态内容扫描、路径/junction 扫描、凭据/实例/会话排除检查，并在干净 Windows 环境启动。不以开发机上的 `npm run build` 代替这一验收。

独立性检查同时核对 lockfile 的生产依赖闭包、构建产物中的静态/动态 import、启动脚本和实际模块解析路径。历史导入说明与许可证可以出现 DSH 字样，但生产解析不得命中 DSH 包或外部 checkout；不能用简单全文搜索命中数代替运行依赖检查。

新增 `deploy/runtime-components.lock.json` 固定 Node、数据库模块及其嵌入 SQLite、Python、提取组件和 PDF 渲染组件的版本、平台、下载来源、SHA-256 和许可路径；选定经过实际安装验证的补丁版本后写入，不在设计文档里虚构一个已验收版本。运行包不使用 `latest` 或首次启动在线解析版本，升级组件时重新运行对应协议/发行测试。

### 13.2 历史导入

历史迁移是单独命令，默认 dry-run；先列出源目录、格式、会话数、任务协议、缺失文件、冲突和预计目标。获得明确数据迁移授权后，复制到新运行目录，旧目录保持不变。

读取当前实际 rc.6 会话格式与 UNO quick 扩展、项目元数据、待确认提案和任务归属；不能用新 DSH master 的格式假设覆盖旧数据。未知事件保留原始载荷并报告，不能静默丢弃成“导入成功”。导入器自身包含所需解码依赖，不靠调用全局 DSH 读取。

导入映射保存原 ID、新 ID、原文件哈希、消息数、事件数、附件和引用对应关系；幂等导入不重复生成消息。密钥不跟随普通导出，用户重新配置或走明确的受保护迁移操作。

当前允许继续的 v2/v3 编译、建构任务保留原 workflow、分类、预算和恢复字段。已完成请求与 Gateway 收据不重放；因独立运行时而替换会话承载，不意味着改写任务语义。原本只读的历史任务继续只读；无法可靠解码/恢复的条目阻止该条迁移，不能擅自降格全部可恢复任务。

### 13.3 切换与撤回

实际切换前停止旧进程并确认排空，备份程序与运行数据、记录知识版本/收据边界。新程序以明确新运行目录启动，经健康及实际功能检查后才宣告接管。

撤回程序不覆盖正式知识库、原书或新生成收据；撤回前停止新任务并导出切换后的操作记录。旧程序不能继续执行新协议研究任务，显示为只读历史；若共享知识已经产生新提交，必须核验旧程序兼容性后再恢复服务，不能把应用回滚当成知识回滚。

## 14. 统一验收清单

下表是目标完成条件，不是已经跑过的结果。新增测试路径为实施要求。所有程序测试使用合成临时实例；真实模型评测另需明确材料和费用授权。

### 14.1 程序、故障与安全

| 测试文件/套件 | 必须证明的行为 |
|---|---|
| `tests/agent-loop-contract.test.mjs` | 假模型第一次调用搜索，第二次根据结果调用补读，第三次回答；三次请求内容可核对，非固定脚本假循环 |
| `tests/agent-direct-chat.test.mjs` | 无资料问题一次请求零工具；同会话可进入研究并返回交流 |
| `tests/agent-tool-contract.test.mjs` | 每个已公布工具输入/输出符合实际 Schema；不存在、拒绝、空结果、截断分别返回 |
| `tests/agent-reading-pagination.test.mjs` | 长中文、emoji、CRLF、无单元旧卡可续读；无缺字/重叠伪覆盖，版本变化使游标失效 |
| `tests/agent-skill-delivery.test.mjs` | 指定技能及必需引用完整进入实际请求；缺失文件阻止能力，不伪称已加载 |
| `tests/agent-cancel-races.test.mjs` | 请求前、流中、工具前、工具中、提交门、最终事件、唤醒队列窗口的停止均正确 |
| `tests/agent-crash-recovery.test.mjs` | 进程被终止后恢复；已保存读取不重做，未知写入先查收据，坏记录不变空记录 |
| `tests/agent-execution-ownership.test.mjs` | 两个进程争用同运行目录时只有一个 owner；旧 epoch 无法继续写入 |
| `tests/agent-context-budget.test.mjs` | wire body 不超能力预算，必要工具结果成对，重试/审核/摘要均计数，存储失败不外发 |
| `tests/agent-provider-wire.test.mjs` | 所有保留供应商协议的流拆包、工具结果、截断、usage、取消、图片与能力拒绝 |
| `tests/agent-scope-security.test.mjs` | 两库相同卡 ID、UI 切库、过期权限、路径穿越、恶意文档指令均不能越权 |
| `tests/agent-outcome-transaction.test.mjs` | 候选未确认不写入；改稿使确认失效；重复确认单一收据；冲突不覆盖 |
| `tests/agent-event-replay.test.mjs` | 双击发送、双标签页、断线重连、迟到异常不会重复执行或覆盖终态 |
| `tests/agent-legacy-import.test.mjs` | 旧 quick/native 混合历史、未知事件、附件、参与会话映射与在途任务协议保留 |
| `tests/agent-workflow-regression.test.mjs` | 当前编译/建构合同、隔离修复、预算、领域治理和停止规则不退化 |
| `tests/agent-standalone.test.mjs` | PATH 不含 DSH、无旧目录/junction、无用户 DSH 配置时，独立 HTTP 服务和完整假模型循环运行 |

停止测试必须断言没有迟到新请求/新提交，而不只是按钮变灰。循环测试必须检查下一次真实模型输入确实含上一轮工具结果，而不只是 mock 被调用几次。

### 14.2 用户界面与操作兜底

实际浏览器执行：新建对话、自动取证、同会话深入研究、研究中纠正、排队消息、暂停继续、立即停止、预算不足、修复密钥后继续、切库、刷新重连、候选确认/改稿/取消、报告导出失败重试、会话删除保护。

验收键盘、输入法回车、滚动定位、窄屏、长引用和可访问状态提示。服务重启后再次操作，而不是仅前端 mock。运行状态、任务状态、消息最终状态和收据必须一致。

### 14.3 真正的思维质量与成本

固定 48 个问题：12 个直接交流、12 个有限知识取证、24 个研究（解释比较、条件反例、跨来源综合各 8 个）。包含库中无答案、错误前提、知识冲突、同源重复、长文尾部决定性条件、历史信息污染和用户纠正方向的样本。

使用同一模型、同一精确版本配置、同一知识快照和同一问题；当前 quick 路径作为冻结基线，新 Agent 作为候选。各运行三次，随机匿名呈现答案；原始请求、工具结果、实际读取范围、输出、token、费用和时长完整记录。真实请求只在明确批准总预算后执行，本方案没有授权自动开始。

验收目标：

- 范围越权、未经确认写入、失败伪装成功、缺失资料冒充依据：零容忍。
- 直接交流正确性与简洁性不劣于基线；简单问题的正常路径保持一次模型请求。
- 有限取证关键结论引用可回查，不能用增加大量工具调用换得同等答案。
- 研究题在事实准确、条件完整、反证处理、问题回应、可用性五项盲评中，新 Agent 获得明确偏好的题目不少于 60%，明显退步不多于 10%；同时列出全部失败样本，不只展示成功案例。
- 非空引用锚点解析率 100%；内容是否真正支持结论由独立人工/盲审判断，不用锚点存在代替语义忠实。
- 自动交流输入 token 与总延迟的中位数/P95 相对基线增幅目标不超过 15%；同硬件、同网络交错运行并拆开供应商延迟。达不到时定位上下文/调度开销，不通过取消必要证据检查掩盖。
- 研究的新增耗时和费用公开报告，与质量增益一起判断；不承诺自主循环比轻量聊天更快。

这些百分比是拟议验收阈值，不是统计结论或已实现收益。保存样本与复测结果，不能仅由开发模型给自己打分通过。

### 14.4 构建与发行证据

实现后保留现有 `npm test`、`npm run test:web`、`npm run build`，新增 `npm run test:agent`、`npm run test:standalone`、`npm run test:distribution`。脚本必须实际存在并包含上述套件，不能只在文档里列命令。

完成交付必须提供：源码提交哈希、全部锁文件、依赖/许可清单、上述测试结果、真实模型评测记录或明确未获授权状态、干净机器发行验收、实际运行服务版本核验。缺少真实模型验收时只能说“工程实现通过”，不能说“思维质量已达标”。

## 15. 完成时应看到的结果

用户打开独立 UNO，直接在一个对话里交流、取证、深入研究、纠正方向、交付报告和准备知识保存。系统的主动性体现在根据证据调整行动，而不是工具动画或固定分析步骤；系统的可靠性体现在每次读取、失败、停止、继续和保存都有真实状态与可行出口。

开发者从仓库可以沿着 `server → turn-service → loop-runner → model-gateway/tool-scheduler` 找到全部执行路径；分发者不用知道开发机安装过什么 DSH；用户不用换一个对话才能让助手认真研究。

最终保留的是 UNO 已经形成的知识规则、Gateway、来源与版本保护、编译/建构协议和有价值的分析方法；接管的是此前外置的运行控制权，并把对话、工具交付和成果操作连接成一个可验证的完整产品。
