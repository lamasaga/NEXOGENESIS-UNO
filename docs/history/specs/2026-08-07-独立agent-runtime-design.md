# Nexogenesis 独立 Agent Runtime 设计（A→B 路线）

> 日期：2026-08-07
> 状态：待用户审阅
> 前提决议：独立产品化；非通用 code agent；Web 应用；中央知识图谱 + 对话型 agent；图谱激活可视化在 A 阶段交付。

---

## 一、背景与目标

### 1.1 现状

当前仓库是**纯确定性 harness**：`pyproject.toml` 仅依赖 pyyaml/jsonschema/click/jinja2，没有任何 LLM 调用代码。所谓的"agent"实际是外部 code agent（Kimi Code / Claude Code / Codex）——它读 `AGENTS.md` 与 `.agent/skills/`，代替人思考，然后调用 `python -m nexogenesis ...` 系列 CLI。

从 code agent 免费继承、自建后必须补齐的能力：

| 现在借用的能力 | 自建后的对应物 |
|---|---|
| Agent loop（多轮推理 + 工具调用） | LLM client + tool-call 循环 |
| 模型切换 / 计费 / 重试 | Provider 抽象层（OpenAI 兼容协议） |
| Skill 加载与编排 | Skill runtime（SKILL.md → 可调度 prompt + 工具子集） |
| 上下文管理 / 压缩 | 会话 STM + 压缩策略（复用 `thinking/stm.py`） |
| 权限与防呆（write --batch、确认环节） | Web 端 human-in-the-loop 确认队列 |
| 终端交互 | Web UI：中央图谱 + 对话 + 流程可视化 |

### 1.2 方向性优势

code agent 是通用的（任意 shell、任意文件改写），本设计**不需要**。工具面是封闭的——十几个 `nexogenesis` 子命令。自建 runtime 的难度因此从"造 Kimi Code"降为"造一个固定工具集的领域 agent"，工作量差一个数量级，安全性天然更好。

### 1.3 目标与非目标

**目标：**

- 任何 OpenAI 兼容 API（DeepSeek / Kimi / 本地模型）插入即可完整跑通 talk / compile / digest / construct / judge 全流程。
- Web 应用：中央知识图谱 + 对话，服务问答、沉淀、反思、讨论、输出五类场景。
- Agent 检索/调用过程中，图谱对应区域有"神经元激活"可视化。
- 现有 harness 行为零改动；CLI + code agent 路径继续可用。

**非目标：**

- 通用 code agent 能力（任意 shell 执行、任意文件编辑）。
- 多平台消息网关、cron 自动化、远程沙箱（Hermes 的这些部分明确不抄）。
- 多用户/多租户。单用户本地优先。

### 1.4 路线总览

- **A 阶段**：完整产品骨架——provider 层 + agent loop + skill runtime + 工具适配 + HITL 确认 + Web 前端（**含中央图谱与激活可视化**）+ 事件总线。单模型。
- **B 阶段**：差异化增强——多模型角色路由、双时序检索增强、construct 后台化（sleep-time compute）、成本与质量度量。

---

## 二、总体架构（A 阶段）

新增 `nexogenesis/runtime/` 包，**不改现有 harness 核心逻辑**。CLI 保持可用，runtime 是它的第二个宿主。

```
┌─ Web 前端（中央图谱 + 对话 + 确认队列）── SSE ──────────┐
│                                                          │
│  FastAPI server（python -m nexogenesis serve）           │
│    ├─ Agent loop（runtime/loop.py）                      │
│    │    messages → tool_calls → 执行 → 追加 → 循环        │
│    ├─ Skill runtime（runtime/skills.py）                 │
│    │    加载 .agent/skills/，触发路由，注入 Grounding     │
│    ├─ Tool adapter（runtime/tools.py）                   │
│    │    现有 CLI 函数 → LLM tool 定义，三级权限           │
│    ├─ HITL 确认队列（runtime/approvals.py）              │
│    │    写入类操作挂起，SSE 推送，用户批准后续跑           │
│    ├─ Provider 层（runtime/providers.py）                │
│    │    OpenAI 兼容 client，重试/退避/token 计量          │
│    └─ 事件总线（runtime/events.py）                      │
│         检索/图查询/写入事件 → 前端图谱激活                │
│                                                          │
└─ 现有 harness（write --batch / validate / retrieve…）───┘
```

关键纪律继承：

- `write --batch` 仍是**唯一实质写入入口**；runtime 只是它的调用方之一。
- markdown 仍是唯一语义事实之源；runtime 不引入任何新的状态存储（会话/STM 落盘沿用 `.nexogenesis/memory/`）。
- `origin: system` 卡片 mature / `theory_status: active` 的批准纪律不变，由 HITL 队列承载。

---

## 三、组件设计

### 3.1 Provider 层（`runtime/providers.py`）

- OpenAI 兼容 `chat/completions` + `tool_calls` 协议。DeepSeek 官方 API 本身 OpenAI 兼容，零适配成本；Kimi（moonshot）同理；本地模型经 llama.cpp / vLLM 的 OpenAI 兼容端点接入。
- 配置：`.nexogenesis/runtime.yaml`——provider 列表（base_url、api_key 的环境变量名、model 名、超时）。密钥只从环境变量读，配置文件中只存变量名。
- 内置：指数退避重试（限流/超时最多 3 次）、token 计量（按 provider 价格表估算成本，写入会话日志）。
- A 阶段单一活跃模型；B 阶段扩展为角色路由（见 §7）。

### 3.2 Tool adapter（`runtime/tools.py`）

**直接 import 现有命令函数，不起 subprocess**——避免进程开销、保留类型化返回值、错误可结构化回灌。

工具分三级：

| 级别 | 工具 | 执行策略 |
|---|---|---|
| 只读 | `retrieve`、`graph retrieve/stats/analyze`、`rag search`、读卡片/Buffer/Profile | 自由执行 |
| 流程 | `compile`（plan/生成/check-responses/apply→Buffer）、`digest --plan/--prompt`、`construct --diagnose/--lens/--plan` | 自由执行，结果留痕（Journal） |
| 写入 | `write --batch`、`digest --apply`、`construct --apply`、Profile 改写 | **一律进 HITL 确认队列**，批准后执行 |

注意：`compile --apply` 落盘的是 `05-Buffer/`（质料，可逆性高），归入流程级；`digest --apply` 写 `01-Cards/`，归入写入级。

每个工具定义包含：name、description（从 harness-cli.md 语义提炼）、JSON Schema 参数、级别。工具执行结果统一包装为 `{ok, summary, payload_path?, error?}`，`summary` 进上下文，`payload` 大结果落 `.nexogenesis/tmp/` 只给路径——防止上下文膨胀。

### 3.3 Skill runtime（`runtime/skills.py`）

- 解析 `.agent/skills/*/SKILL.md` frontmatter（name/description）做触发路由，复用现有 description 语义（「消化」「/digest」等触发词）。
- 命中后：把该 skill 的 Grounding 清单按序注入上下文（懒加载，用到才读全文），Workflows 作为 system prompt 追加，并**约束本轮可用工具子集**（如 digest 轮不暴露 construct 工具）。
- 未命中任何 skill 时默认 nexo-talk。
- skill 文件保持 markdown 唯一事实源——runtime 不复制其内容到代码里，运行时读取。

### 3.4 Agent loop（`runtime/loop.py`）

标准 tool-call 循环：

1. 组装 messages（system=skill 注入 + AGENTS.md 纪律摘要；history=会话；STM 热槽摘要）。
2. 调 provider，带工具定义。
3. 有 tool_calls → 经 tool adapter 执行（写入级挂起等批准）→ 结果追加 → 回到 2。
4. 无 tool_calls → 输出最终回答，STM 落槽，结束。

护栏：

- 最大步数（默认 25，可配）；超限挂起并输出已完成步骤摘要。
- 中断与恢复：会话状态（messages + 待批准项）持久化到 `.nexogenesis/memory/sessions/`，进程重启可续跑。
- 上下文压缩：工具大结果只留 summary + 路径；历史轮次超阈值时对最旧工具结果做摘要替换（复用 STM 的滚动卷思路）。A 阶段不做 LLM 摘要压缩，只做确定性截断+路径化。

### 3.5 HITL 确认队列（`runtime/approvals.py`）

- 待确认项结构：`{id, kind, title, diff_summary, payload_path, created_at, session_id}`。
- 写入级工具被调用时：生成预览（batch.yaml 的 diff 摘要：新建/丰富哪些卡、加哪些边、改哪些 Profile 字段）→ 入队 → SSE 推送 → loop 挂起等待。
- 用户操作：批准 / 拒绝（可附言，附言回灌 loop 让模型修正）/ 本轮自动（等价现有 `--auto` 语义，本会话内同类操作免确认）。
- 这承载了宪法"任何写入须经授权"的纪律。

### 3.6 事件总线（`runtime/events.py`）

A 阶段即交付——它是图谱激活可视化的数据源。

- 事件类型：`retrieve.query`（查询词+命中节点）、`graph.hit`（节点 id 列表+角色：种子/扩展）、`card.read`、`write.applied`（新建/丰富的卡 id）、`skill.trigger`、`approval.pending/resolved`。
- 产生点：tool adapter 在只读/写入工具执行后发射；zero 侵入 harness——事件在 adapter 层从工具返回值提取，不改 harness 代码。
- 传输：进程内 pub/sub，SSE 通道广播给前端。

### 3.7 Web 前端

技术选型：**FastAPI 原生托管的 SPA**——React + Vite + Cytoscape.js（图谱）。不引入 Next.js 等重框架；构建产物由 FastAPI 静态托管，单进程交付。

布局（中央图谱优先）：

- **中央：知识图谱**（Cytoscape.js）。数据源 `graph export`/只读 API。节点=卡片（按类型着色），边=关系。
- **图谱激活效果**：订阅事件总线 SSE——`graph.hit` 命中的节点脉冲发光并按角色着色（种子/扩展不同色），`card.read` 节点呼吸高亮，`write.applied` 新节点入场动画+与相连节点的新边生长动画。激活强度随时间衰减（神经元不应期隐喻）。
- **右侧：对话面板**。流式输出；skill 触发时显示当前技能徽章；工具调用以可折叠条目展示。
- **确认队列**：对话面板内嵌卡片式待批准项（diff 摘要 + 批准/拒绝/本轮自动）。
- **辅助视图**：卡片阅读器（点击图节点打开）、Buffer 状态、流程进度（compile/digest 波次进度条）。

只读 API（FastAPI）：`/api/graph`（全图或子图）、`/api/cards/{id}`、`/api/buffers`、`/api/graph/stats`。对话与控制走 `/api/chat`（SSE）与 `/api/approvals`。

### 3.8 服务入口

`python -m nexogenesis serve [--port 8787] [--provider deepseek]`：启动 FastAPI + uvicorn，托管前端构建产物，打开浏览器。开发模式前端 Vite dev server 代理到后端。

---

## 四、数据流（典型场景）

### 4.1 问答（nexo-talk）

用户提问 → skill 路由命中 talk → loop 调 `retrieve --mode talk`（发射 `retrieve.query` + `graph.hit`，图谱对应区域激活）→ 按需 `card.read`（节点呼吸高亮）→ 生成带归因的回答 → STM 落槽。不写卡（除非用户说「记一下」→ 转 nexo-emerge 流程，≤3 候选进确认队列）。

### 4.2 消化（nexo-digest）

用户说「开始消化」（= 本轮授权）→ loop 按 SKILL.md 六步工作流：`digest --plan` → `digest`（生成 prompt）→ 模型读 prompt 与 Grounding 文档写 `batch.yaml` → 自检（YAML/必填/幽灵链接/必需槽）→ **确认队列推送 diff 摘要** → 用户批准 → `digest --apply` → harness 自动级联 validate + index + graph rebuild + rag index → 发射 `write.applied` → 图谱上新卡入场动画。

### 4.3 反思（nexo-judge）

用户「深判 X」→ loop 调 `retrieve --mode judge` 取 2–4 透镜材料（图谱激活）→ 生成定位性分析（不裁决）→ 留对话，不落盘；用户要沉淀时转 emerge 流程。

---

## 五、错误处理

| 故障 | 处理 |
|---|---|
| 模型产出非法 batch.yaml | harness `--check` 拦截，错误结构化回灌 loop 自修，最多 2 次，仍失败则挂起交人 |
| API 超时/限流 | 指数退避重试 3 次；失败挂起会话，可恢复重试 |
| 工具执行异常 | `{ok:false, error}` 回灌 loop；harness 非零退出码原样透传 |
| loop 超最大步数 | 挂起，输出已完成步骤摘要，用户可继续或终止 |
| 用户拒绝批准 | 附言回灌 loop，模型修正后重新入队（同一项最多 3 轮，防死循环） |
| 前端断连 | SSE 重连；会话状态在服务端，刷新不丢 |
| harness 行为回归 | 现有测试套件必须全绿；runtime 不改 harness 代码（架构级保证） |

---

## 六、测试策略

- **Mock provider**：录制 tool_call 脚本回放的假 client，单测覆盖 loop 分支（正常终态/超步数/工具错误/批准-拒绝循环）、工具三级权限、确认队列状态机、事件发射。
- **Golden 测试**：工具适配层在 `tests/fixtures/` 工作区上跑，断言工具定义 schema 与执行结果快照。
- **事件总线测试**：模拟工具执行，断言事件序列与前端激活协议的契约。
- **Live 冒烟**：真实 DeepSeek 端点跑一遍「digest 一波」最小场景，pytest 标记 `live` 默认跳过，手动触发。
- **回归纪律**：现有全部测试保持绿色；runtime 测试放 `tests/runtime/`。

---

## 七、B 阶段规划（A 完成后启动，本设计仅定方向）

- **多模型角色路由**：`runtime.yaml` 定义角色——cheap（compile 分波、初筛、摘要）用 DeepSeek-V3 级；strong（digest 判别、judge、冲突识别）用更强模型；embedding 走 RAG 现有路径。router 按 skill + 工具级别选模型。
- **双时序检索增强**（借鉴 Zep/Graphiti）：卡片 frontmatter 增补 `event_time`（思想/事件发生时间）与现有摄入时间并列；图检索支持时序过滤与"某时点视角"查询。
- **construct 后台化**（借鉴 Letta sleep-time compute）：低峰期自动跑结构诊断与 seed-links，产出建议入确认队列，人只批准不触发。
- **成本与质量度量**：token/成本按 skill 分账；digest 自检通过率、返修率进 Journal，用于评估弱模型是否够用。

---

## 八、参考借鉴清单（逐项说明）

### 8.1 Hermes-agent（NousResearch）——首要参照

链接：https://github.com/NousResearch/hermes-agent

与 Nexogenesis 哲学高度同构：model-agnostic provider 层 + skill 系统 + 持久记忆（其 SOUL.md/MEMORY.md 对应我们的 AGENTS.md/02-Profile）。

**借鉴：**

- **Provider 抽象**：一套 OpenAI 兼容接口覆盖任意端点，`hermes model` 命令式切换——对应 `nexogenesis serve --provider` 与 runtime.yaml。
- **Skill 系统结构**：SKILL.md 作为 procedural memory，frontmatter 路由 + 正文注入——与我们 `.agent/skills/` 现状一致，证明路线正确；其 agentskills.io 开放标准可作为未来 skill 格式演进的兼容目标。
- **Agent loop 骨架**：其公开架构文档（agent loop、key classes）可直接作为 loop.py 的参照实现。
- **同构验证**：它用 markdown 文件承载人格与记忆，证明"markdown 唯一事实源"在独立 agent 中成立。

**明确不抄：**

- 多平台消息网关（Telegram/Discord/Slack…）、cron 调度、七种 terminal backend（Docker/SSH/Modal…）、语音转写——通用 agent 的包袱，与领域知识架构目标无关。
- Skill 自我创建/自我改进闭环（B 阶段以后才值得评估；当前 skill 是编排宪法，不宜让模型自改）。

### 8.2 Letta（MemGPT 系）——记忆架构参照

**借鉴：**

- **记忆分层映射**：core memory（常驻上下文）→ AGENTS.md 纪律摘要 + STM 热槽；archival memory（分页检索）→ 01-Cards + RAG；recall memory（会话历史检索）→ `.nexogenesis/memory/sessions/`。三层在 Nexogenesis 已有对应物，本设计只是显式化这一映射。
- **Sleep-time compute**：后台异步整理记忆——直接对应 B 阶段"construct 后台化"。
- **Context Repositories（2026）**：git 化 markdown 记忆、版本化与合并——与我们底座主权原则同构，验证"卡片文件即记忆"的方向；其 merge-based 冲突解决思路可作为未来卡片合并操作的参照。

**不抄：** 其专有框架与托管服务形态；我们要的是自托管单进程。

### 8.3 Zep / Graphiti——时序图谱参照

**借鉴：**

- **双时序建模**：区分事件发生时间与摄入时间（valid time vs transaction time）。落到 Nexogenesis：卡片 frontmatter 增 `event_time`；构造"2025 年时领域如何看待 X"这类时序查询。B 阶段实施。
- **时序知识图谱检索**的工程表现（公开基准上优于 Mem0 系）：证明图检索投入值得，支持我们继续走 graph 模块深化而非转向纯向量。

### 8.4 Microsoft GraphRAG——图谱激活的技术原型

**借鉴：**

- **检索路径可视化**：GraphRAG 的 local/global search 会产出明确的"命中社区→实体→关系"路径，把这条路径实时投射到图布局上，就是用户要的"神经元激活"的技术内核——本设计的事件总线 + Cytoscape.js 脉冲即此思路的产品化。
- **Community detection ↔ domain 卡**：GraphRAG 用社区检测聚合主题；Nexogenesis 已有 domain 卡作为人工策展的"社区"。图谱前端可按 domain 着色分区，激活时整区泛光。

### 8.5 smolagents（HuggingFace）——最小 loop 参照

**借鉴：** 几百行讲清 tool-call 循环的教科书实现，作为 `loop.py` 的极简参照，防止过度设计。**不抄**其 code-action 范式（模型写代码当工具调用）——我们的封闭工具集不需要也不安全。

### 8.6 Generative Agents（Stanford）——反思机制的学术原型

nexo-judge 的 reflection 思想原型。本设计不新增机制，仅在文档中显式化这一谱系：**观察→检索→反思→沉淀**的循环对应 talk→retrieve→judge→emerge。

### 8.7 Claude Code 记忆架构——分层落盘参照

Memory.md（常驻索引）+ 主题文件（按需加载）+ session transcripts（grep-only）三层，对应本设计：AGENTS.md 摘要 + 卡片按需 `card.read` + sessions 目录。已是 Nexogenesis 现行实践的变体，作为 A 阶段上下文管理的直接参照。

### 8.8 明确否决：LangGraph / CrewAI 等编排框架

理由：Nexogenesis 的 harness（compile→digest→construct 分波、检查、apply）已经是贴合领域的最优编排器，且其状态机语义已被 SKILL.md 与测试固化。套外部状态图框架等于用通用抽象替换领域特化逻辑，调试成本与认知负担双升，无对应收益。

---

## 九、A 阶段里程碑拆解（供实施计划参考）

1. **M1 Provider + Loop**：providers.py + loop.py + mock provider 单测；CLI 里能 `nexogenesis serve` 起一个只有对话的 demo（无工具）。
2. **M2 工具适配**：tools.py 三级工具 + fixtures golden 测试；loop 能跑只读问答。
3. **M3 Skill runtime + HITL**：skills.py 路由与注入；approvals.py 队列；digest 全流程在 mock 下跑通。
4. **M4 事件总线 + 后端 API**：events.py + 只读 REST + SSE。
5. **M5 前端**：图谱 + 激活 + 对话 + 确认队列，端到端联调。
6. **M6 Live 验证**：真实 DeepSeek 跑通 compile→digest 一波，成本与质量记录进 Journal。

---

## 十、风险与开放问题

- **弱模型语义质量**：DeepSeek 级模型做 digest 判别（enrich vs 新建、冲突识别）的质量未知。对策：M6 用真实数据评估；B 阶段角色路由兜底（弱模型不行就 strong 模型上）。这是本项目最大的不确定性。
- **工具结果体积**：retrieve/graph analyze 结果可能很大，路径化 + summary 策略需在 M2 实测调优。
- **前端图谱规模**：卡片上千后 Cytoscape.js 全图渲染压力；预留按 domain 分区加载的退路（M5 先全图，超标再切）。
- **开放问题**： sessions 目录与 STM 的边界（会话内 messages vs STM 热槽）在 M3 实现时需细化；本设计不预先锁死。
