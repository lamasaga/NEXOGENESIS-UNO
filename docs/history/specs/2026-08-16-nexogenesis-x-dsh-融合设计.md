# Nexogenesis × DeepSeek Harness 融合设计

> 日期：2026-08-16
>
> 状态：设计文档（路线 A 已确认；M0–M4 已完成，2026-08-19 核对）

> 📌 勘误（2026-08-19）：本文中「融合项目根 = `D:\UESR\Desktop\dsh`」均指实际根目录
> **`D:\UESR\Desktop\NEXOGENESIS-DSH`**（§12.1 已用新名；后续统一用此根）。patch 实际部署位为
> `$DSH_HOME/profiles/nexogenesis/cordis.patch.yml`（§12.2 隔离纪律），§6.1 中 `profiles/web` 的示例不再采用。
>
> 基线：开发仓当前 HEAD；Web v2.0；能力内核与双执行平面重构设计（2026-08-16）为本设计的上游方向
> （勘误 2026-08-19：该上游方向中的**双执行平面拆分不采纳**——融合仓为单体系，Web 界面 + DSH agent 一体；
> 见 `docs/specs/2026-08-19-单体系架构决策-不追随上游双执行平面.md`）
>
> 变更等级：v3 平台级架构融合
>
> 作用：把 Nexogenesis 的 Web 界面、思维体（Agent）与知识体（卡片库）融合进 DeepSeek Harness（DSH）框架，形成「WEB + DSH 框架 + 高质量 Agent」的单一新项目

---

## 1. 决策摘要

本次融合采用「**DSH 为底座、Agent 插件化、UI 零改动**」的目标架构，以渐进方式迁移。

已确认的核心决策：

1. **DSH 是新的 Harness**：会话、对话循环、LLM 调用、工具系统、审批、后台任务、技能加载、目标机制全部由 DSH 接管；Python `runtime/` 不再承担 agent 编排。
2. **思维体插件化**：`nexo-*` 技能（`.agent/skills/`）注册为 DSH skill 包；`BASE_PROMPT` / `RETRIEVAL_DISCIPLINE` / `style_prompt` 成为 agent preset 与 system prompt sections；自研 DSML 工具协议被 DSH 原生工具调用取代。
3. **知识体插件化**：知识体 = markdown 卡片数据层 + 一个「知识域工具包」（retrieve / read_card / list_domains / graph_query / propose_candidates / propose_write / confirm_write），打包为可安装 skill + tools 集合，会话按需加载。
4. **Web UI 零改动（路线 A）**：React 前端保持现状，通过「API 兼容层」host 插件把现有 `/api/*` REST 端点逐条适配到 DSH 服务；DSH webserver 路由「最长前缀优先」，兼容层注册的前缀路由天然压过 DSH 原生 `/api` RPC 网关。
5. **Python 渐进保留**：对话/agent/审批/会话立即 DSH 化；RAG 检索、图谱构建、材料标准化等计算密集且已调优的模块**阶段 1 保留 Python 并 MCP 化**（DSH 通过 `dsh-mcp-client` 以工具语义调用），阶段 2 按质量验证结果逐模块移植。不在融合初期重写 RAG。
6. **Markdown 仍是唯一长期语义事实源**（继承项目宪法）；运行状态、事件、中间产物不取代知识体文件。
7. **Nexogenesis UI 为主界面**：`dsh web` 启动即呈现 Nexogenesis 界面；官方前端作为可选备胎（patch 层切换，不删除）。
8. **迁移到 DSH 文件夹，原项目只读**：融合项目根 = `D:\UESR\Desktop\NEXOGENESIS-DSH`；原项目 `Nexogenesis-org` 只读不动，作为迁移来源与历史存档（见 §8）。
9. **知识体复制独立（✅ 已确认）**：`01-Cards/` 等数据目录复制到 DSH 文件夹，Agent 只写入副本；原项目数据完全冻结（见 §8.1.1）。
10. **交付双形态（✅ 已确认）**：最终产物 = ① 有独立安装包的桌面应用（Electron 壳 + 内嵌 dsh 服务）；② 可部署在服务器上的 Web 项目（反向代理/Docker）；同源同构，分阶段实现，最终是独立项目（见 §7）。
11. **公网认证与多用户（✅ 已确认）**：公网部署前置认证（方案 A/B/C 暂不定，M7 选型，见 §7.3）；**需要多用户隔离**（推荐 T2 单实例 + 按用户数据根，见 §7.3.1）。
12. **双 Agent 独立（✅ 已确认）**：Kimidata 内的 DSH 是**官方 agent**（开发工具），NEXOGENESIS-DSH 是**新 agent**（被开发的产品）——两者彼此独立，官方安装只读、端口与 profile 隔离、会话互不污染（见 §12）。
13. **单体系架构（✅ 已确认，2026-08-19）**：融合仓**不采用**上游「双执行平面」——Web 界面即唯一入口，界面下调用 DSH agent 完成任务；talk/emerge/assess/refine/report/compile/digest/construct 全部由同一会话 agent 执行，`.agent/skills/` 9 技能保持统一 DSH 技能集（见 `docs/specs/2026-08-19-单体系架构决策-不追随上游双执行平面.md`）。

---

## 2. 背景与现状盘点

### 2.1 三方现状

| 组件 | 现状 | 位置 |
|---|---|---|
| **Web 前端** | React 18 + Vite 5 + TS + Tailwind；图谱动画（GraphCanvas + ActivationEngine）、流式对话（ChatPanel/ChatComposer）、侧栏（Sidebar）、设置（SettingsModal）、卡片阅读（CardReader）、写入审批（ConfirmCard）、pipeline 面板、EventLog 模拟 | `web/` |
| **Python Harness + Agent** | `nexogenesis/` 包：CLI 命令 + `runtime/`（agent.py 多轮循环、chat.py 流式、pipeline.py、conversations.py、settings.py、pending_writes.py、pending_candidates.py、graph_data.py、simulate.py、events.py）；自研 **DSML 工具调用协议**（`<||DSML||tool_calls>` 文本标记）、关键词技能路由（`route_skill`）、统一检索上下文注入、写入提案审批 | `nexogenesis/` |
| **思维体（技能）** | `nexo-talk / emerge / assess / refine / report / compile / digest / construct`，SKILL.md 剧本 | `.agent/skills/` |
| **知识体** | markdown 卡片（`01-Cards/`、`05-Buffer/`）+ Profile + 图关系；RAG 索引（`nexogenesis/rag/`） | 仓库目录 |

### 2.2 前端 API 依赖清单（兼容层必须覆盖的全部端点）

来源：`web/src/api/client.ts`（融合设计以它为契约基线，**前端不改**）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/settings` | GET / PUT | 模型配置（base_url/model/api_key 掩码）、username、style_prompt |
| `/api/projects` | GET / POST | 项目列表 / 新建 |
| `/api/conversations` | POST / GET / PATCH / DELETE `/:id` | 会话 CRUD（title/pinned/task_kind/pipeline_history） |
| `/api/chat/stream` | POST | 流式对话（SSE：delta/done/error/step/sources/confirm_request/candidate_request/pipeline_status） |
| `/api/chat` | POST | 非流式对话 |
| `/api/events?conversation_id=` | GET（EventSource） | 图谱模拟事件订阅 |
| `/api/graph` | GET | 图谱数据（节点/边/布局） |
| `/api/cards/:id` | GET | 卡片详情 |
| `/api/retrieve`（隐含） | — | 检索（agent 内部工具，UI 不直接调） |
| `/api/simulate/:scenario`、`/api/replay/:scenario` | POST / GET | 图谱模拟与回放（动画演示） |
| `/api/inbox` | POST（multipart） | 上传 Inbox 材料 |
| `/api/pipeline/:stage/conversation`、`/api/pipeline/status`、`/api/pipeline/job`、`/api/pipeline/jobs/:id/stop` | POST/GET | 编译/消化/建构工作流 |
| `/api/candidates/prepare` | POST | 涌现候选预检 |
| `/api/write/confirm` | POST | 写入提案确认/取消 |

### 2.3 Agent 现状的关键事实（DSH 化的改造点）

- 工具协议：**DSML 文本标记**解析（自研，易受模型输出格式影响）；
- 技能路由：`route_skill()` 按消息关键词匹配 5 个技能域（talk/emerge/assess/refine/report），再加载对应 `SKILL.md` 剧本；
- 检索纪律：`RETRIEVAL_DISCIPLINE` 强制「先使用 Harness 预生成的统一检索上下文，非盲区不再检索」；
- 写入：必须先 `propose_write`（≤3 项提案），界面确认后执行；丰富已有卡片必须 read_card 后提交完整替换记录；domains 必须来自 `list_domains`；
- 涌现：先 `propose_candidates`（1–3 个）由用户选定，再确定性预检为提案（不占模型轮次）；
- 上限：`MAX_ROUNDS=10`、`HISTORY_LIMIT=10`、`AGENT_MAX_TOKENS=6144`。

---

## 3. 融合架构总览

```
┌────────────────────────── dsh web（单进程，127.0.0.1:3080）──────────────────────────┐
│                                                                                      │
│  ┌─────────────────────────────┐        ┌──────────────────────────────────────────┐ │
│  │  Nexogenesis React UI (dist) │        │  DSH 底座                                │ │
│  │  GraphCanvas / ChatPanel /   │        │  session · llm · tools · jobs · goals    │ │
│  │  Sidebar / Settings / ...    │        │  subagents · skills · approvals · fs      │ │
│  └──────────────┬──────────────┘        └───────────────▲──────────────────────────┘ │
│                 │ REST /api/*                            │ 服务注入 / RPC             │
│                 ▼                                        │                            │
│  ┌───────────────────────────────────────────────────────────┐                        │
│  │  nexogenesis-web-host（API 兼容层插件，本项目新增）          │                        │
│  │  · 挂载 frontend-static（dist = web/dist）                  │                        │
│  │  · 提供 webRuntime 服务（connection 行依赖）                │                        │
│  │  · 注册前缀路由：/api/settings /api/projects                │                        │
│  │    /api/conversations /api/chat /api/events /api/graph      │                        │
│  │    /api/cards /api/inbox /api/pipeline /api/write           │                        │
│  │    /api/candidates（最长前缀优先，压过原生 /api RPC）         │                        │
│  │  · SSE 桥：DSH 事件流 → 前端帧（delta/step/sources/…）       │                        │
│  └──────────────────────┬────────────────────────────────────┘                        │
│                         │ 工具调用（MCP 语义）                                        │
│                         ▼                                                            │
│  ┌──────────────────────────────────────────────────────────┐                        │
│  │  知识域插件（Agent DSH 化的载体）                           │                        │
│  │  · skills：nexo-* SKILL.md（按需加载）                      │                        │
│  │  · preset：persona（宪法 + style_prompt + 检索纪律）        │                        │
│  │  · tools：retrieve/read_card/list_domains/graph_query/     │                        │
│  │          propose_candidates/propose_write/confirm_write    │                        │
│  │  · 数据层：markdown 卡片目录（DSH fs）                      │                        │
│  │  · 阶段1 MCP：RAG 检索 / 图谱构建 / 材料标准化（Python）     │                        │
│  └──────────────────────────────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

职责划分（继承 2026-08-16 设计「入口不拥有业务流程」原则）：

| 能力 | 归属 |
|---|---|
| 对话循环、工具调用、模型调度、会话持久化 | DSH（session / llm / tools） |
| 技能加载与剧本注入 | DSH（skill 系统，按需加载 SKILL.md） |
| 写入审批、用户提问 | DSH（user-questions / approvals） |
| 编译/消化/建构长任务 | DSH（jobs + goal 机制） |
| 图谱/卡片/检索（计算侧） | 阶段 1：Python MCP 服务；阶段 2：DSH 工具 |
| 图谱/卡片（读侧，兼容层直读 fs） | DSH fs + 解析 |
| 界面呈现 | Nexogenesis React UI（零改动） |

---

## 4. Agent DSH 化设计（核心）

### 4.1 现状 → DSH 替换映射

| 现状 | DSH 化后 | 质量收益 |
|---|---|---|
| DSML 文本工具协议 | DSH 原生工具调用（JSON Schema 参数 + 结构化结果回灌） | 消除文本标记解析错误与「模型在回答里输出工具 JSON」的幻觉路径 |
| `route_skill` 关键词路由 | DSH skill 系统（会话内按需加载 SKILL.md） | 上下文精简：仅当前任务注入剧本；路由规则可演进 |
| `BASE_PROMPT`（agent.py 常量） | agent preset persona + system prompt sections | 分层管理（宪法/技能/会话），可版本化 |
| `RETRIEVAL_DISCIPLINE` | prompt section + retrieve 工具设计（首轮注入上下文） | 检索纪律显式化，可审计 |
| `MAX_ROUNDS=10` / `HISTORY_LIMIT` | DSH agent loop 配置 + compaction（会话压缩） | 长对话不爆上下文，轮次上限可配置 |
| 统一检索上下文（模型调用前注入） | turn 前工具注入 / 上下文打包 | 与现有 Context Package 语义一致 |
| `propose_write` → 界面确认 | user-questions 审批工具 + confirm_write | 审批闭环纳入 DSH 提问体系（UI 可弹窗/流内帧） |
| `propose_candidates` → 用户选定 | 候选工具（确定性预检保持不占模型轮次） | 保持现有设计优点 |
| 单 agent 串行 | 可选：goal 跨会话推进 + subagent 并行（检索/写作） | 长期目标与并行能力（M5 启用） |
| 单一 deepseek 直连 | DSH llm 层（多 provider / 模型切换 / retry） | 模型选择与容错 |
| 自定义事件帧（step/sources/…） | DSH 工具调用事件 → 兼容层转帧 | UI 的 steps/sources/tool_trace 展示原样保留 |

### 4.2 思维体插件化（nexo-* → DSH skill 包）

- `.agent/skills/nexo-*/SKILL.md` **已是 DSH skill 兼容格式**（SKILL.md + frontmatter），注册路径：
  - 开发期：`dsh/skills/` 复制或软链；DSH 的 `dsh-skill-filesystem` 行负责加载本地技能目录；
  - 与现有 `.agent/skills/` 的关系：**以 `.agent/skills/` 为唯一事实源**，DSH 配置指向该目录（`skill-filesystem` 的 roots），避免双份维护。
- 技能与工具的绑定：每个 nexo-* 技能声明依赖的知识域工具（talk 依赖 retrieve/read_card；emerge 依赖 propose_candidates/propose_write；…）。
- 入口语义：用户消息到达会话 → DSH agent 按意图选择技能（替代 route_skill 的关键词路由；保留 `/judge` 删除决策，统一 assess）。

### 4.3 知识体插件化（知识域工具包）

「知识体插件」= 数据层 + 工具集 + 加载配置，作为一个可安装的 skill/tool 集合：

| 工具 | 语义 | 实现（阶段） |
|---|---|---|
| `retrieve(query, context)` | 统一检索上下文（core/conflict/expansion 节点 + 关系路径 + RAG 质料） | 阶段1：MCP 调 Python RAG；阶段2：DSH 侧检索 |
| `read_card(id)` | 精读单卡（frontmatter + body） | DSH fs + YAML 解析（可直接做） |
| `list_domains()` | 领域卡片清单（写入约束） | DSH fs 扫描（可直接做） |
| `graph_query(node/relations)` | 图结构查询 | 阶段1：MCP；阶段2：DSH 工具 |
| `propose_candidates(summary, cards)` | 涌现候选（1–3 个） | DSH 工具 + storage 暂存 |
| `propose_write(operations)` | 写入提案（≤3 项，完整卡片记录） | DSH 工具 + user-questions 审批 |
| `confirm_write(decision)` | 执行/取消写入（原子写 + 校验） | DSH fs + 写入事务校验（移植 `operations.py`/`validate`） |

数据层不变量（继承宪法）：任何实质写入必须走确认后的写入工具；markdown 是唯一事实源。

### 4.4 「更高质量的 AGENT」——DSH 带来的具体提升

1. **工具调用可靠性**：原生 JSON Schema 工具协议替代 DSML 文本解析，模型输出不合法参数时 DSH 返回结构化错误并可重试（`dsh-tool-call-timeout-policy`、`dsh-repeat-tool-reminder`）。
2. **审批闭环**：写入提案进入 DSH 提问体系（`dsh-tool-ask-user` / user-questions），UI 的 ConfirmCard 通过兼容层接入；审批状态与会话投影一致。
3. **长期目标**：`dsh-goal` 让编译/消化/建构成为跨会话目标，Agent 可自主推进并在每轮汇报进度（UI 的 GoalBar 可复用或隐藏）。
4. **多 agent 协作**：`dsh-tool-subagent` 支持检索子代理与写作子代理并行；`dsh-workflow` 支持大规模编排（如全库图谱重建）。
5. **上下文管理**：compaction（`dsh-compaction-basic`）压缩长会话；技能按需加载精简 prompt。
6. **计划模式**：`dsh-plan-mode` 让复杂任务先产出计划再执行（对应既有 pipeline 的步骤化执行）。
7. **模型与容错**：llm 层多 provider、重试、token 计量；`dsh-token-meter` 可观测成本。
8. **事件与可审计性**：DSH 工具调用事件流完整对应真实能力动作（解决 2026-08-16 设计中「动画事件由入口补发」问题）；UI 的 EventLog / step 展示直接消费真实事件。
9. **技能治理**：技能目录、约束分层（宪法/Skills/环节）在 DSH 的 skill 系统里获得统一加载、版本与信任标记（`dsh-skill` / `dsh-agent-instructions`）。
10. **可测试性**：DSH 的 loader 快照（`--dump-config`）与插件单元测试替代「入口 + CLI stdout 解析」的黑盒测试（解决双执行平面摩擦）。

---

## 5. API 兼容层设计（nexogenesis-web-host）

### 5.1 插件职责

一个 DSH host 插件包（Node ESM，cordis 插件），由 patch 层挂载：

```text
dsh/packages/nexogenesis-web-host/
├── package.json          # name: nexogenesis-web-host
├── lib/index.js          # 插件入口：inject [webServer, webStartup?]
│   ├── 1. 提供 webRuntime 服务 { lanAddresses, trustedHosts }
│   │     （connection 行 inject [webRuntime]，缺失则 /api 不启动——必须提供）
│   ├── 2. 挂载 @deepseek-ai/dsh-host-frontend-static
│   │     distIndex = config.dist（指向 web/dist/index.html）
│   ├── 3. 注册前缀路由（见 5.2 映射表）
│   ├── 4. SSE 桥（见 5.3）
│   └── 5. 可选：注册 web-surface prompt section + 打印 URL
└── lib/handlers/         # 每类端点的适配实现
    ├── settings.js  projects.js  conversations.js  chat.js
    ├── graph.js  cards.js  inbox.js  pipeline.js
    ├── write.js  candidates.js  events.js  simulate.js
```

关键机制依据（已核实源码）：

- **路由优先级**：`dsh-host-webserver` 的 `match()` 先查 exact 表，再按「最长前缀优先」匹配 prefix 表。兼容层注册的 `/api/chat`、`/api/graph` 等前缀**压过** `dsh-client-connection` 注册的原生 `/api` 前缀 → 只有未适配的路径落到 DSH RPC 网关。
- **fallback seat**：默认由 `web-runtime`（`dsh-web-app`）挂载官方 dist；patch 层 `disabled: true` 该行后，兼容层插件挂载自己的 dist（fallback 单主人，无冲突）。
- **index tap**：`dsh-client-modules` 的 `window.__DSH_BOOT__` 注入对所有 index 渲染生效——Nexogenesis 前端无需理会该变量（官方 shell 才消费），可原样存在。
- **浏览器信任围栏**：所有 `/api` 请求的 Host 必须是 loopback 或 `trustedHosts` 声明；兼容层路由位于同一围栏内，无需额外处理。

### 5.2 接口映射表（前端端点 → DSH 服务）

| 前端端点 | 适配实现 |
|---|---|
| `GET/PUT /api/settings` | 读/写 `dsh-settings` 命名空间 + credentials（base_url/model/api_key 存 credentials 或 settings；`api_key_masked` 只回掩码）；username/style_prompt/default_style_prompt → preset 配置域 |
| `GET/POST /api/projects` | DSH 无原生 project → 兼容层以 **workspace + session 元数据**模拟：project = 一组 session（tag/group）；新建 = 创建分组记录（storage） |
| `POST /api/conversations` | `session.create`（cwd = 仓库根）；返回兼容层会话 DTO |
| `GET /api/conversations/:id` | `session.get` + 消息投影（messages 从会话事件/JSONL 投影）；pipeline_history/pinned/task_kind → session 元数据（storage） |
| `PATCH/DELETE /api/conversations/:id` | `session.patch`（title/pinned）/ `session.remove` |
| `POST /api/chat/stream` | 兼容层开启会话 turn（DSH 会话发送用户消息），把 DSH 事件流转为前端帧：工具调用 → `step`/`sources`；user-questions 提问 → `confirm_request`/`candidate_request`；assistant 增量 → `delta`；turn 完成 → `done`；异常 → `error` |
| `POST /api/chat` | 同上的非流式变体（缓冲后一次性返回） |
| `GET /api/events?conversation_id=` | 兼容层订阅会话事件流（DSH events 域 SSE），转发图谱/模拟事件帧 |
| `GET /api/graph` | 读 markdown 卡片 + relations 构建图数据（frontmatter 解析 + 边构建；阶段1 可调 MCP graph 服务）；返回前端 `GraphData` 形状 |
| `GET /api/cards/:id` | 兼容层读卡片文件（`01-Cards/<id>.md` 解析 frontmatter + body）；不存在返回既有 404 语义 |
| `POST /api/inbox` | multipart 解析 → DSH fs 写入 `00-Inbox/`（原子写） |
| `POST /api/pipeline/:stage/conversation` | 创建/定位 pipeline 会话（session + 元数据 task_kind） |
| `GET /api/pipeline/status`、`GET /api/pipeline/job` | `jobs` 域查询（DSH 后台任务投影）→ 前端 `PipelineStatus`/`PipelineJobRecord` |
| `POST /api/pipeline/jobs/:id/stop?after_wave=` | `jobs.stop`（DSH 任务取消） |
| `POST /api/candidates/prepare` | 确定性预检服务（移植 `pending_candidates.py` 的预检逻辑为 DSH 服务，不占模型轮次） |
| `POST /api/write/confirm` | 审批决策回执 → 执行写入工具（原子写 + 校验，移植 `operations.py`/`validate` 规则）；返回 created/enriched/outbox_count 等既有形状 |
| `POST /api/simulate/:scenario`、`GET /api/replay/:scenario` | 模拟器：阶段1 保留 Python（MCP 或直连），或兼容层实现事件回放（低优先级，纯演示） |

### 5.3 SSE 桥设计（/api/chat/stream 与 /api/events）

前端帧契约保持不变（`web/src/api/client.ts` 已定义）：

```jsonc
// 兼容层 → 前端
{ "type": "delta", "text": "…" }
{ "type": "done" }
{ "type": "error", "detail": "…" }
{ "type": "step", "kind": "retrieve|read_card|propose_write|…", "label": "…" }
{ "type": "sources", "cards": [{ "id": "…", "title": "…", "kind": "evidence|read|retrieved|legacy" }] }
{ "type": "confirm_request", "proposal_id": "…", "summary": "…", "operations": […], "warnings": […] }
{ "type": "candidate_request", "candidates": [{ "candidate_id": "…", "title": "…", "type": "…", "summary": "…" }] }
{ "type": "pipeline_status", "state": "starting|running|completed|failed|paused|cancelled", "label": "…", "detail": "…", "job_id": "…" }
```

- 兼容层维护「会话 turn → SSE 响应体」的订阅映射；DSH 事件（工具调用、assistant 增量、提问）经 `lib/sse.js` 转帧写入响应流。
- user-questions 的提问在兼容层转成 `confirm_request`/`candidate_request` 帧；用户在前端确认后调 `POST /api/write/confirm` 或 `POST /api/candidates/prepare` 回执。

---

## 6. 部署与配置

### 6.1 Patch 层（两种部署位，任选其一）

```yaml
# 方案一：全局生效（每个 profile 都应用）—— $DSH_HOME/cordis.patch.yml
# 方案二：仅产品 profile —— $DSH_HOME/profiles/nexogenesis/cordis.patch.yml（本项目实际采用，§12 隔离纪律）
- id: web-runtime
  disabled: true            # 关掉官方 dist 挂载（web-app 的 web-runtime 行）

- insert:
    - id: nexogenesis-web-host
      name: nexogenesis-web-host
      inject: [webStartup]
      config:
        dist: "D:/UESR/Desktop/NEXOGENESIS-DSH/web/dist/index.html"
        trustedHosts: []
```

- 插件包安装：`dsh plugin --profile web add <nexogenesis-web-host 本地路径或 registry>`（profile 目录 pnpm 管理）。
- 回退：删除 patch 或改回 `web-runtime` 未禁用即恢复官方界面（Nexogenesis UI 为主，官方为备胎）。

### 6.2 开发循环

- 前端：`web/` 现有 `vite dev`（proxy /api → 兼容层在 3080 或直连）；生产构建 `vite build` → `web/dist` 由兼容层挂载。
- 插件：host 插件随 profile 安装，改码后重启 `dsh web`；DSH 支持 `--dump-config` 预览组合树验证 patch 生效。
- Agent 技能：`.agent/skills/` 改动即生效（skill-filesystem 目录加载），无需重建。

---

## 7. 交付形态与独立项目化

> 需求（✅ 已确认）：最终产物 = ① 有独立安装包的桌面应用；② 可部署在服务器上的 Web 项目；可分阶段实现（阶段一核心融合 → 阶段二桌面 → 阶段三服务器部署）；**最终是一个独立项目**。

### 7.1 双交付形态总览

| 形态 | 载体 | 说明 |
|---|---|---|
| **桌面独立应用** | Electron 壳 + 内嵌 dsh 核心服务 + Nexogenesis UI | Windows NSIS 安装包（.exe）/ 便携版；macOS dmg；Linux AppImage |
| **服务器 Web 项目** | 同一代码库，dsh web 服务 + 反向代理 / Docker | 内网（trusted-host）或公网（前置认证 + HTTPS） |

**同源同构**：桌面与服务器共享同一套核心（dsh 底座 + 兼容层 + 知识域插件 + Nexogenesis UI dist），只差外壳与部署形态；核心融合成果（M0–M5）在两种形态下直接复用。

### 7.2 桌面独立应用（Electron）

现状依据：DSH 源码预留了 Electron 概念（`dsh-host-webserver`：Electron 从 file:// 加载 dist 并经 IPC bridge 携带 fetch），但**未实现**壳，需要本项目自建。

采用 **方案 S1（本地 HTTP + BrowserWindow，零 IPC 改造）**：

```
Electron 主进程（Node）
├── 启动核心服务：项目内依赖 @deepseek-ai/dsh，boot web profile
│   （in-process boot 或 spawn dsh CLI），监听 127.0.0.1:<随机端口>
├── 端口就绪后创建 BrowserWindow → 加载 http://127.0.0.1:<port>/
├── 生命周期：窗口关闭 → 优雅停机（DSH shutdown 控制器）；托盘/单实例可选
└── 打包：electron-builder（asar 内嵌 node_modules + web/dist；cards/ 首次启动初始化）
```

- 渲染进程 = 标准浏览器形态：Nexogenesis UI **零改动**；兼容层路由、SSE 桥、信任围栏全部按 Web 逻辑工作（loopback 命中浏览器信任围栏）。
- 备选 **方案 S2（file:// + IPC bridge，DSH 注释预留路线）**：需改前端 fetch 注入桥，仅当离线/签名安全强约束时启用；默认不做。
- 数据目录：知识体（cards/）放用户数据目录（如 `%APPDATA%/Nexogenesis/`），首次启动从安装资源复制/初始化；模型配置与 api_key 存 DSH credentials（用户级）。

### 7.3 服务器部署

| 方式 | 形态 | 说明 |
|---|---|---|
| 1（推荐内网） | `dsh --profile web --patch <patch>` 监听 127.0.0.1 + nginx/caddy 反向代理 + HTTPS | 局域网访问用 `--trusted-host` 声明 IP/域名；零信任/VPN 内网 |
| 2 | Docker 镜像（node 基础镜像 + 项目 + `dsh web`） | `docker compose` 管理端口与数据卷（cards/、$DSH_HOME） |
| 3 | 公网直连 | **不推荐**：DSH 无认证层，必须前置认证（见下） |

- **认证（重要）**：`dsh-host-webserver` 注释明确「认证 out of scope」。公网部署必须前置认证；trusted-host 围栏只防 DNS rebinding 与跨站，**不是认证层**。方案对比（**✅ 已确认：暂不定，M7 再选**）：

  | 方案 | 适用 | 优点 | 缺点 |
  |---|---|---|---|
  | **A. Caddy + Basic Auth**（htpasswd） | 单用户/极少数人 | 3 行配置，Caddy 自动 HTTPS | 无多用户管理、密码难撤销、无 SSO |
  | **B. nginx + oauth2-proxy** | 多用户/团队 SSO | GitHub/Google/企业 IdP 登录、可撤销、标准 OIDC | 配置复杂，需 IdP 账户 |
  | **C. Cloudflare Tunnel + Access** | 无公网 IP/不想开端口 | 免费额度、邮箱验证码/SSO、免开端口、自带防护 | 域名走 Cloudflare，依赖其服务 |

  共同架构：`公网用户 → HTTPS → 认证网关（A/B/C） → 127.0.0.1:3080（dsh web）`；TLS、cookie 安全属性（`Secure`/`HttpOnly`/`SameSite`）由网关处理；DSH 内部仍监听 loopback 明文。
  **⚠️ 公网部署必做**：`--trusted-host <域名>` 声明 Host（否则浏览器信任围栏对 `/api` 一律 403）。

- **多用户隔离（✅ 已确认：需要）**：DSH 无用户概念，认证通过 ≠ 多租户。设计见 §7.3.1。
- 进程守护：systemd / pm2 / docker restart。

### 7.3.1 多用户隔离设计（✅ 已确认：需要多用户隔离）

**问题**：DSH 单实例没有 owner 概念——所有通过认证的用户默认共享同一会话列表与数据。多用户公网部署需要隔离设计。

| 方案 | 形态 | 隔离粒度 | 优点 | 缺点 |
|---|---|---|---|---|
| **T1 多实例** | 每用户一个 DSH 实例/容器（各自 DSH_HOME、cards/、workspace） | 进程级，最强 | 安全边界清晰、互不影响、可按用户扩容 | 资源开销大；实例管理复杂（N 用户 N 进程） |
| **T2 单实例 + 按用户数据根**（推荐起步） | 认证网关注入用户身份头 → 兼容层按用户解析数据根（cards/、会话元数据、fs 沙箱根） | 数据级 | 单进程省资源；融合层内实现 | 需要兼容层加用户维度；DSH fs 沙箱须按会话限制路径 |
| **T3 单实例 + 仅会话隔离** | 会话标 owner、知识体共享 | 会话级 | 最轻；适合团队共享知识库 | 共享区权限与冲突需额外治理 |

**推荐路径**：T2 起步（单实例 + 每用户数据根，用户量小到中），规模扩大后演进 T1（容器化多实例，可配合负载均衡）。T3 作为「团队共享知识体」的变体，若业务确认知识库是团队共享的再启用。

**T2 关键实现点**（M7 细化）：
1. 认证网关（A/B/C）把身份注入请求头（如 `X-Auth-Request-User`、Caddy 自定义头）；
2. 兼容层读取该头：projects/conversations 列表按用户过滤；卡片读写根解析为 `<数据根>/users/<user>/cards/`（或共享区）；
3. DSH 会话（session）元数据存 owner；`dsh-session` 的查询按 owner 过滤；
4. Agent 的工具 fs 操作经 DSH fs 沙箱限制在该用户目录（会话级 workspace/沙箱根配置）；
5. 未知用户头（未认证直连）→ 拒绝（认证网关已挡，双保险）。

### 7.4 独立项目化（最终形态）

- **DSH 成为项目依赖**：`package.json` 声明 `@deepseek-ai/dsh`（版本锁定）；启动走项目自己的入口（`dsh` bin 或自定义 boot 脚本，调用 `dsh-app-boot` 的 boot API）；不再依赖全局 npm 安装与 `$DSH_HOME` 手工配置（`$DSH_HOME` 仅作开发期覆盖）。
- **独立 git 仓库**：`D:\UESR\Desktop\NEXOGENESIS-DSH` 为仓库根（docs/、web/、packages/、desktop/、deploy/、cards/）。
- **自有构建链**：`web build` → `host 插件` → `桌面打包（electron-builder）` → `服务器部署包（Docker/发布目录）`。
- **发布矩阵**（阶段二/三）：Windows NSIS 安装包、Windows 便携版、macOS dmg、Linux AppImage、Docker 镜像。

### 7.5 阶段化路径（与 §9 里程碑衔接）

- **阶段一（M0–M5）核心融合**：DSH 底座 + API 兼容层 + Agent 插件化 + Nexogenesis UI；以开发模式（`dsh web`）跑通全部功能。
- **阶段二（M6）桌面应用**：Electron 壳 + electron-builder，出 Windows 安装包（含核心服务自动启停）。
- **阶段三（M7）服务器部署**：反向代理/Docker + 认证 + 进程守护，出可部署制品与部署文档。

---

## 8. 仓库结构与模块清单

> **迁移约束（用户确认）**：融合项目根目录 = `D:\UESR\Desktop\NEXOGENESIS-DSH`；原项目 `D:\UESR\Desktop\Nexogenesis智构涌现\Nexogenesis-org` **只读不动**，仅作为迁移来源与历史存档。所有开发、构建、配置都在融合项目根内进行。

```
D:\UESR\Desktop\NEXOGENESIS-DSH\        # ★ 融合项目根（独立 git 仓库）
├── docs/                         # 设计文档（本文件在此）
├── web/                          # 前端（从原项目复制，M0 落位）
├── .agent/skills/nexo-*/         # 思维体（从原项目复制，插件事实源）
├── 00-Inbox … 06-Journal/      # 知识体（平级目录，从原项目复制，完全独立；Agent 写入目标，不入库）
├── nexogenesis/                  # Python（阶段1：MCP 服务化，按需复制）
├── packages/nexogenesis-web-host/   # API 兼容层插件（见 §5）
├── presets/nexogenesis/             # agent preset：
│   ├── preset.yml                   # persona（宪法 + style_prompt + 检索纪律）
│   └── agent.cordis.yml             # 会话默认挂载的 tools/skills 行
├── tools/                           # 知识域工具（Node 实现，阶段2 落位）
├── mcp/                             # Python MCP server（RAG/图谱/材料标准化）
├── desktop/                         # Electron 壳（M6，见 §7.2）
│   ├── main.js                      # 主进程：启动核心服务 + BrowserWindow
│   ├── preload.js                   # 渲染进程桥（方案 S1 下最小化）
│   └── electron-builder.yml         # 打包配置（NSIS/dmg/AppImage）
├── deploy/                          # 服务器部署（M7，见 §7.3）
│   ├── Dockerfile
│   ├── nginx.conf                   # 反向代理 + HTTPS/认证示例
│   └── systemd/nexogenesis.service
└── patch/cordis.patch.yml           # 融合组合配置（§6.1 的内容源）
```

模块依赖：`nexogenesis-web-host` → `@deepseek-ai/dsh-host-frontend-static`、`@deepseek-ai/dsh-host-webserver`（service）、`@deepseek-ai/dsh-mcp-client`（阶段1）、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-session`（service 使用）、storage。桌面/部署形态追加：`electron`、`electron-builder`。

### 8.1 迁移边界（原项目只读）

| 原项目路径 | 迁移动作 | 运行时角色 |
|---|---|---|
| `web/` | 复制到 DSH 文件夹（M0） | 前端源码 + 构建产物（`web/dist` 由兼容层挂载） |
| `.agent/skills/nexo-*/` | 复制到 DSH 文件夹 | 思维体插件事实源（DSH skill 加载） |
| `nexogenesis/` | 阶段1 按需复制（MCP 服务化部分） | Python 计算服务 |
| `01-Cards/ 02-Profile/ 03-Archive/ 04-OutBox/ 05-Buffer/ 06-Journal/` | ✅ 已确认：复制独立（§8.1.1） | 知识体数据层（Agent 写入目标） |
| `docs/`、`AGENTS.md`、`README.md` | 复制参考/宪法 | 文档与约束源 |
| `schemes/`、`hooks/`、`tests/` | 按需复制 | 沉淀方案/钩子/回归测试 |

#### 8.1.1 知识体数据路径决策（✅ 已确认：选项 1 —— 复制，完全独立）

知识体是 **Agent 的写入目标**（`propose_write`/`confirm_write` 会落盘卡片），「原项目只读」与「知识体运行时写入」的数据所有权决策如下：

- **✅ 选项 1（复制，完全独立）——已确认**：把 `01-Cards/ 02-Profile/ 03-Archive/ 04-OutBox/ 05-Buffer/ 06-Journal/` 复制到 DSH 文件夹；Agent 只写入 DSH 文件夹内的副本，原项目完全冻结。→ 最符合「原项目不动」；原项目从此作为历史存档。
  - 迁移动作：M0 阶段复制目录骨架与现有内容（✅ 已完成：6 目录平级复制，`02-Profile/` 3 个文件随迁）。
  - 运行时：兼容层/工具把卡片读写根配置为融合项目根内平级目录（`D:\UESR\Desktop\NEXOGENESIS-DSH\01-Cards\` 等，与原项目路径名一致，技能/工具无需改路径）。
- ~~选项 2（原位引用，运行期可写）~~：数据不复制但运行期写原项目，与「原项目不动」冲突，未选。
- ~~选项 3（软链接）~~：读写落原项目，同选项 2 冲突，未选。

### 8.2 开发循环（DSH 文件夹内）

- 前端：`web/` 内 `vite dev`（proxy /api → 兼容层 3080）与 `vite build`；构建产物挂载。
- 插件：`packages/nexogenesis-web-host` 随 profile 安装，改码重启 `dsh web`；`dsh --dump-config` 验证 patch。
- 技能：`.agent/skills/` 改动即生效（skill-filesystem 目录加载）。
- 原项目：**不写、不改、不构建**；如需对照实现细节只读查阅。

---

## 9. 实施里程碑

> 阶段划分：**M0–M5 = 阶段一（核心融合）**；**M6 = 阶段二（桌面应用）**；**M7 = 阶段三（服务器部署）**。M6/M7 共享 M0–M5 的核心成果（同源同构，§7.1）。

| 里程碑 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| **M0 骨架** | 项目初始化（docs/、packages/、patch/）；host 插件挂载 Nexogenesis dist；patch 生效 | ✅ **已完成（2026-08-16）**：`dsh web` 返回 Nexogenesis UI（200, lang=zh）+ `/api/health` 探针；官方界面回退已验证（清空 patch 即恢复官方 UI） | 0.5–1 天 |
| **M1 基础打通** | settings / projects / conversations / chat 端点适配；会话 CRUD 走 DSH session | ✅ **已完成（2026-08-16）**：settings 保存/读回/凭据双写；会话创建/详情/列表/软删除；`/api/chat` 非流式 + `/api/chat/stream` SSE 桥；全链路实测（含错误传播，真实回答待有效 `DEEPSEEK_API_KEY`） | 2–3 天 |
| **M2 Agent DSH 化** | 知识域工具（read_card/list_domains/retrieve 桥）；skill 按需加载；事件桥（step/sources）；原生工具调用替代 DSML | ✅ **已完成（2026-08-16）**：nexogenesis-tools（retrieve/read_card/list_domains，presentationMeta → sources 帧）；nexogenesis preset（persona 宪法+检索纪律 + 工具行 + nexo-* skill 挂载）；实测模型主动调用 retrieve/read_card、UI 帧 step/sources/delta/done 完整 | 3–5 天 |
| **M3 知识工作流** | pipeline → jobs/goal；candidates 预检；write 审批闭环（user-questions + 原子写）；inbox 上传 | ✅ **已完成（2026-08-17）**：pipeline 以「task_kind 会话 + agent 技能执行」实现（`/compile` 触发 → 技能 + list_inbox/read_inbox/write_buffer 工具 → pipeline_status 帧）；propose_write → pending → confirm_request 帧 → /api/write/confirm 原子落盘（staging→rename）+ Journal；Inbox multipart 上传（中文文件名）；实测 compile/digest/emerge 全链路（2 卡落盘 + 提案确认） | 3–5 天 |
| **M4 图谱与检索** | graph/cards 数据服务（fs 直读）；RAG MCP 接入 | 图谱动画还原；检索质量与现状持平（对照测试集） | ✅ **已完成（2026-08-17）**：检索升级为 BM25（TF/IDF+标题加权）+ 图关系扩散（core/expansion 双轨，对齐 retrieval-design）；**图谱事件桥**（chat 翻译 agent 认知 → /api/events → 前端 ActivationEngine：retrieve.query/graph.hit/context.ready/card.read/session.idle 实测全链路）；simulate/replay 稳定空实现。RAG MCP 决策：小语料下以纯 JS 混合检索替代 Python 向量 RAG（语料扩大后再接，见 §4.3） | 2–3 天 |
| **M5 质量强化** | ✅ **2026-08-19**：preset 挂载 tool-goal / plan-mode（知识工作版文案）/ compaction 组（basic + command-compact + tool-result-pruner）/ subagent（spawn + fork + control + list-agents）/ ask-user / todo；前端对齐上游 v2.1（digest_two_stage 两阶段消化设置 + 浏览历史/收藏/帮助菜单 + 动画时序）；settings 增加 `digest_two_stage` 持久化。✅ **digest enrich 段落补丁**：移植上游 digest v2.1 语义——`propose_write` 支持 `mode:"enrich"`（replace_sections / append_sections / add_sources / add_relations），模型不重抄未改段落，Harness 展开合并后校验、交用户确认（保留标题层级）。⏳ 多模型切换（填 key 后验证）、pipeline 接入 goal 跨会话驱动 | 长期任务可跨会话推进；长会话不退化；可切换模型 | 持续 |
| **M6 桌面应用** | Electron 壳（主进程启动核心服务 + BrowserWindow 加载本地 http）；electron-builder 打包 | Windows 安装包可安装运行；窗口关闭优雅停机；cards/ 初始化到用户数据目录 | 3–5 天 |
| **M7 服务器部署** | Dockerfile + 反向代理 + **认证网关选型落地（A/B/C）** + **多用户隔离（T2）** + 进程守护；部署文档 | 一键构建镜像；公网部署文档可复现；多用户登录后数据与会话相互隔离 | 3–5 天 |

每阶段结束做一次「质量对照」：同一批问题分别在旧 Python 栈与 DSH 栈上运行，比较回答质量与工具调用正确率（沉淀为 `tests/` 回归集）。

---

## 10. 风险与决策点

| 风险/决策 | 说明 | 缓解 |
|---|---|---|
| **Python RAG 质量 vs 移植成本** | RAG 索引已调优，移植有质量风险 | 阶段1 MCP 保留；移植前建立对照测试集（M4 验收门槛） |
| **会话模型差异** | DSH session（agent 会话）vs 现有 conversation（pipeline_history/pinned/task_kind 元数据） | 兼容层用 storage 存扩展元数据；映射表见 §5.2 |
| **审批体验差异** | DSH user-questions 是独立提问机制，现前端期待流内帧 | 兼容层把提问转帧（§5.3）；UI 的 ConfirmCard 无需改 |
| **多项目语义** | DSH 无原生 project | 兼容层以 workspace + session 分组实现；或后续 DSH 版本提供 |
| **api_key 安全** | 前端不再持有明文 key | 存 DSH credentials；`api_key_masked` 只回掩码 |
| **simulate/replay** | 纯前端动画演示，Python 专属 | 阶段1 保留直连；可降级为兼容层事件回放 |
| **patch 与官方升级** | DSH 版本升级可能变更行 id/服务名 | 融合层插件化隔离；升级时用 `--dump-config` 校验；文档记录行 id 契约 |
| **双执行平面继承** | 2026-08-16 重构（能力内核）与本次融合并行 | 融合即该重构的落地路径之一：DSH 提供能力内核与工作流，入口适配原则一致 |
| **公网认证缺失** | DSH 无认证层（webserver 明确认证 out of scope），公网直连不安全 | 反向代理前置认证（A: Caddy+Basic Auth / B: oauth2-proxy / C: Cloudflare Access），M7 选型 |
| **多租户隔离复杂度** | DSH 无用户概念；T2 方案需兼容层加用户维度 + fs 沙箱按会话限路径 | 按用户解析数据根（§7.3.1）；先单实例 T2，规模扩大再演进 T1 容器化 |
| **Electron 打包体积与签名** | node_modules + dist 打包较大；Windows 代码签名可选 | asar 内嵌 + 按需精简依赖；签名证书按需采购（M6） |
| **端口占用** | 桌面模式固定端口可能冲突 | 桌面模式用随机端口 + 就绪探测；Web 模式 `--port` 可配置 |
| **桌面与 Web 配置一致性** | 两形态共用核心但数据目录/配置路径不同 | 统一配置模块（环境变量/配置文件按形态解析）；文档记录差异 |

---

## 11. 术语对照

| Nexogenesis | DSH | 说明 |
|---|---|---|
| conversation | session | 对话会话 |
| project | workspace + session 分组（兼容层） | 项目容器 |
| 思维体（nexo-*） | skill + agent preset | 编排能力 |
| 知识体（卡片库） | 数据层 + 知识域工具包 | markdown 事实源 |
| Harness（python -m nexogenesis …） | DSH tools / jobs / fs | 过程执行 |
| 写入提案/确认 | user-questions + confirm_write 工具 | 审批 |
| pipeline（compile/digest/construct） | jobs + goal 编排 | 知识工作流 |
| 统一检索上下文（Context Package） | retrieve 工具 + turn 前注入 | 检索纪律 |
| DSML 协议 | 原生工具调用 | 工具协议 |

---

## 12. 双 Agent 独立性纪律（✅ 已确认）

> 用户确认（2026-08-16）：**Kimidata 内的 DSH 是官方 agent（开发工具）；NEXOGENESIS-DSH 是新 agent（产品）**。官方 agent 用于开发新 agent，两者彼此独立。以下为本项目所有开发的铁律。

### 12.1 角色与边界

| 项 | 官方 agent（DSH） | 新 agent（NEXOGENESIS-DSH） |
|---|---|---|
| 位置 | `D:\KimiData\...\npm-global\node_modules\@deepseek-ai\dsh\` | `D:\UESR\Desktop\NEXOGENESIS-DSH\` |
| 角色 | 框架 / 开发工具 | 被开发的产品 |
| GUI 端口 | **3080**（官方 GUI） | **3083**（`start-nexogenesis.cmd` 固定） |
| profile | `$DSH_HOME/profiles/web/`（官方，**不再改动**） | `$DSH_HOME/profiles/nexogenesis/`（专属） |
| 依赖方向 | — | 新 agent 依赖官方安装（junction 只读） |

### 12.2 隔离铁律

1. **官方安装只读**：`D:\KimiData\...\@deepseek-ai\dsh\` 及其嵌套 node_modules **永不修改**；新 agent 仅通过 junction 只读引用其依赖包。
2. **端口隔离**：官方 GUI = 3080；新 agent = 3083（验证时也只用 3083，**禁用 3080/3081/3082** 避免与官方或历史测试冲突）。
3. **profile 隔离**：新 agent 只用 `profiles/nexogenesis/`；`profiles/web/` 是官方 GUI 的 profile（当前 patch 为 `[]`），**不再向它部署任何内容**。
4. **$DSH_HOME 分区**：
   - 新 agent 专属：`profiles/nexogenesis/`、`.agent-presets/nexogenesis/`、`nexogenesis-meta.json`
   - 官方专属：`profiles/web/`、`settings.yaml`（不主动修改）
   - 共享但不互写：`sessions/`（会话日志）、`.credentials.yaml`（凭据）
5. **会话互不污染**：兼容层的项目/会话列表**只显示 meta 登记过的会话**（新 agent 创建的）；官方 GUI 的会话不进入新 agent 列表（`handleProjectsGet` 已实现 known-filter）。
6. **凭据谨慎**：`.credentials.yaml` 是共享凭据文件——测试写 key 后必须清理；优先用用户级环境变量（官方与新的会话都能读）。
7. **不动官方运行**：不杀 3080 进程、不改官方 GUI 的配置与状态。
