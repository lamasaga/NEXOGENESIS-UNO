# Web 对话界面改版与 DeepSeek 接入设计

> 日期：2026-08-10
> 状态：待用户审阅
> 上游文档：`docs/specs/2026-08-08-web前端与图谱可视化-design.md`（本设计在其前端壳与事件协议之上，接入真实 LLM 对话）
> 前提决议（本次 brainstorm 确认）：
> 1. **LLM 调用链路**：浏览器 → `POST /api/chat` → FastAPI 后端代理 → DeepSeek。密钥只存后端，不暴露给浏览器。
> 2. **中央仍是图谱**：三栏布局中知识图谱居核心位置；图谱动画的意义是「对话中 agent 检索/利用知识卡片时，被召回卡片对应节点闪烁，呈现神经元兴奋与信息传递」，这是项目核心视觉设计，不是可移除的演示。
> 3. **对话编排**：单轮检索增强为基础——每条用户消息触发一次 `rag_search`，命中卡片作为种子节点闪烁，并沿图谱边做关键节点多跳扩散（expand），检索结果作为上下文调用 DeepSeek。
> 4. **会话持久化**：本地文件持久化，新增专门存放会话的文件夹 `07-Conversations/`。
> 5. **项目 = 对话分组**：侧边栏项目列表即对话分组，本轮实现分组逻辑。
> 6. **Add 材料**：上传本地文件到 `00-Inbox/`，与现有 compile 摄入流水线衔接。

---

## 一、目标与非目标

**目标：**

- 界面改版为 Codex 风格三栏：左侧边栏（功能按钮 + 能力按钮 + 项目/对话列表 + 用户/设置）、中央图谱、右侧全高对话窗口。
- 对话接入真实 LLM（默认 DeepSeek），检索激活驱动图谱神经元闪烁动画。
- 对话与项目本地持久化到 `07-Conversations/`。
- 设置弹窗可配置 LLM API（API Key / Base URL / 模型），默认 DeepSeek。
- Add 材料上传文件到 `00-Inbox/`。
- 现有图谱渲染、事件协议、simulate 演示能力零破坏（URL 参数 `autoplay` 等入口保留）。

**非目标：**

- 「思考」「记忆」「反思」三个能力按钮的实际效果（仅占位，用户后续自行开发）。
- 多轮 agentic 工具调用循环（LLM 自主决定何时检索；下一阶段）。
- DeepSeek 流式（SSE）输出（v1 非流式返回完整答案；后续可平滑升级）。
- 对话的删除/重命名/跨项目移动等管理操作（仅保留最小新建与切换）。
- RAG 索引自动重建（沿用现有索引触发方式，聊天时若索引不存在则退化为无检索）。

## 二、界面布局

```
┌────────────┬──────────────────────────┬────────────┐
│ 左侧边栏    │                          │ 右侧对话    │
│ ~260px     │     中央图谱 GraphCanvas  │  ~380px    │
│            │      （核心视觉，占满）     │  全高       │
│ [+ 新对话] │                          │            │
│ [+ Add材料]│                          │  消息列表   │
│            │                          │            │
│ 能力        │                          │            │
│  思考 记忆  │                          │            │
│  反思      │                          │            │
│            │                          │            │
│ 项目列表    │                          │            │
│  ▾ 项目A   │                          │            │
│    对话1   │                          │ [输入框]    │
│    对话2   │                          │            │
│  ▾ 项目B   │                          │            │
│            │                          │            │
│────────────│                          │            │
│ 用户名  ⚙  │                          │            │
└────────────┴──────────────────────────┴────────────┘
```

- **移除**：右侧对话窗口下方的「事件流」面板（`EventLog` 组件代码保留，不再挂载）；顶栏 header 移除，主区三栏占满全高。
- **侧边栏顶部**：「新对话」「Add 材料」两个功能按钮。
- **能力区**：「思考」「记忆」「反思」三个预设按钮，本轮占位——点击在对话区插入一条系统提示「该能力开发中」。
- **项目/对话列表**：项目可折叠，项目下嵌套对话；每个项目有「+」新建对话；点击对话切换当前会话。默认内置一个「默认项目」。
- **底部**：用户名（v1 取系统登录名，只读展示，不可编辑）+ 设置按钮（⚙）打开设置弹窗。

## 三、LLM 设置

- 设置弹窗字段：
  - `api_key`：密码框输入；保存后 GET 接口只返回掩码（如 `sk-···ab12`）。
  - `base_url`：默认 `https://api.deepseek.com`。
  - `model`：默认 `deepseek-chat`。
- 持久化：后端写 `.nexogenesis/web-settings.json`（`.gitignore` 新增该行）。
- 后端接口：
  - `GET /api/settings` → `{ base_url, model, api_key_masked, has_key }`
  - `PUT /api/settings` → 接收上述字段；`api_key` 为空字符串表示不修改。
- 未配置 `api_key` 时，`/api/chat` 返回明确中文错误：「请先在设置中配置 LLM API Key」。

## 四、会话持久化（`07-Conversations/`）

- 新增目录 `07-Conversations/`（gitignored，遵循单向镜像纪律，`.gitignore` 新增该行）。
- 结构：
  - `07-Conversations/_projects.json`：`[{ id, name, created_at }]`，启动时若不存在则写入「默认项目」。
  - `07-Conversations/<conversation_id>.json`：`{ id, project_id, title, created_at, updated_at, messages: [{ role, content, ts }] }`。
  - `title` 取首条用户消息前 20 字。
- 后端接口：
  - `GET /api/projects` → 项目列表（各项目附带其对话摘要 `[{ id, title, updated_at }]`，按 updated_at 倒序）。
  - `POST /api/projects` `{ name }` → 新建项目。
  - `POST /api/conversations` `{ project_id }` → 新建空对话。
  - `GET /api/conversations/{id}` → 完整对话（含 messages）。

## 五、对话编排（检索激活核心链路）

`POST /api/chat` 请求体 `{ conversation_id, message }`，后端编排：

1. 发布 `skill.trigger` 事件 `{ skill: "nexo-talk" }` 与 `retrieve.query` 事件 `{ mode: "talk", query: <用户消息> }`。
2. `rag_search(root, message, top=8)` 全文检索；取命中 chunk 的 `linked_cards` 并集（去重、封顶 6 张）作为**种子节点**，发布 `graph.hit` `{ node_ids: seeds, edge_ids: [], role: "seed" }`。
3. **图谱多跳扩散**：基于 `/api/graph` 同源图数据，从种子沿边扩展——复用 simulate 的 `_edges_touching` 逻辑，第 1 跳封顶 9 条边；对第 1 跳命中的关键节点（按边连接度取前 3）再扩第 2 跳，封顶 6 条边。发布 `graph.hit` `{ node_ids, edge_ids, role: "expand" }`。
4. 对种子卡片中前 2 张发布 `card.read` 事件。
5. 组装上下文：种子卡片 excerpt（`rag_search` 返回的 excerpt 字段，逐条标注卡片 id 与 attribution）+ 会话历史（最近 10 条）+ 系统提示（说明这是基于个人知识库的问答，引用卡片时注明卡片 id）→ 调用 DeepSeek chat completions（httpx，`base_url + /chat/completions`，非流式，timeout 60s）。
6. 发布 `session.idle` `{ reason: "talk-complete" }`。
7. 用户消息与 assistant 回答落盘到会话 JSON，返回 `{ answer, conversation_id }`。

> 修订注记（2026-08-10 实施定稿）：返回值由原拟的 `{answer, retrieved_card_ids}` 改为 `{answer, conversation_id}`——前端图谱动画由 SSE 事件驱动，不需要 `retrieved_card_ids`。另：非 multipart 的 `/api/inbox` 请求按 FastAPI 默认返回 422（§九原写 400），以框架行为为准。

**视觉起搏（与模拟剧本节奏对齐，关键）**：真实检索是毫秒级的，若事件按执行速度发出，seed/expand/card.read 会在同一瞬间到达前端，「闪烁 → 扩散 → 阅读」的分层动画会塌缩成一次齐闪。因此编排任务在各事件阶段之间插入与 `build_talk` 剧本一致的起搏间隔：

| 事件 | 距上一阶段间隔 |
|---|---|
| `skill.trigger` + `retrieve.query` | 0（立即） |
| `graph.hit` seed | +1.0s |
| `graph.hit` expand（第 1 跳） | +1.0s |
| `graph.hit` expand（第 2 跳，若有） | +0.8s |
| `card.read` ×2 | 各 +1.2s |
| `session.idle` | DeepSeek 返回答案后立即 |

检索在 seed 发布前同步完成（毫秒级，不影响节奏）；起搏由后端编排协程用 `asyncio.sleep` 实现，DeepSeek 调用在最后一个 `card.read` 发出后即开始，不等待起搏表走完后才发起（起搏与 LLM 生成自然重叠，用户感知是「图谱还在扩散，回答随后到达」）。

**降级路径：**

- RAG 索引不存在或零命中：跳过步骤 2–4（无闪烁），直接带历史调用 DeepSeek。
- DeepSeek 请求失败（网络/配额/密钥错误）：发布 `session.idle`，返回 HTTP 502 + 中文错误信息，前端在对话区显示为系统消息；用户消息仍落盘并标记未应答。

## 六、Add 材料

- 侧边栏「Add 材料」→ 原生文件选择器（多选，`.md/.txt/.pdf/.docx` 等不限类型）→ `POST /api/inbox`（multipart）→ 后端原样存入 `00-Inbox/`（重名时追加 `-2`、`-3` 后缀）。
- 上传成功在对话区插入系统提示「已放入 Inbox：xxx.md，可用 /compile 编译」。本轮不做自动 compile。

## 七、前端改动清单

| 文件 | 改动 |
|---|---|
| `web/src/App.tsx` | 改为三栏布局；移除 header 与 EventLog 挂载；侧边栏/对话状态提升到此层 |
| `web/src/components/Sidebar.tsx` | 新增：功能按钮、能力按钮占位、项目/对话树、底部用户+设置 |
| `web/src/components/SettingsModal.tsx` | 新增：LLM 配置表单（GET/PUT `/api/settings`） |
| `web/src/components/ChatPanel.tsx` | 重写：真实对话（加载历史、发送、纯文本渲染，不做 Markdown 渲染）、多会话切换、材料上传入口联动 |
| `web/src/api/client.ts` | 新增 conversations/projects/settings/chat/inbox API |
| `web/src/components/EventLog.tsx` | 不改动，仅不再挂载 |

图谱组件（`GraphCanvas`、`ActivationEngine`）零改动——真实对话复用现有事件协议。

## 八、后端改动清单

| 文件 | 改动 |
|---|---|
| `nexogenesis/runtime/api.py` | 挂载新 router：settings / projects / conversations / chat / inbox |
| `nexogenesis/runtime/chat.py` | 新增：对话编排（检索 + 多跳扩散 + DeepSeek 调用 + 事件发布 + 落盘） |
| `nexogenesis/runtime/conversations.py` | 新增：项目与会话的 JSON 文件存取（原子写，与 harness 写入纪律一致） |
| `nexogenesis/runtime/settings.py` | 新增：`.nexogenesis/web-settings.json` 读写、key 掩码 |
| `requirements.txt` | 增加 `fastapi`、`uvicorn`、`httpx`（环境已装，补声明） |
| `.gitignore` | 增加 `07-Conversations/`、`.nexogenesis/web-settings.json` |

多跳扩散的 `_edges_touching` 从 `simulate.py` 提取为公共函数（simulate 与新聊天编排共用），simulate 行为不变。

## 九、错误处理

- 未配置 API Key → `/api/chat` 返回 400 + 中文提示。
- DeepSeek 调用异常 → 502 + 中文提示，前端系统消息展示，不中断 SSE。
- 会话/项目 JSON 损坏 → 读取时跳过该文件并在响应中忽略，不拖垮整个列表。
- 上传文件重名 → 自动加后缀；非 multipart 请求 → 400。

## 十、测试

- `tests/runtime/test_chat_api.py`：mock httpx DeepSeek 响应，验证——事件发布顺序（skill.trigger → retrieve.query → graph.hit seed → expand → card.read → session.idle）、起搏间隔存在（patch `asyncio.sleep` 断言调用次数与时长）、检索零命中降级、未配 key 报错、消息落盘。
- `tests/runtime/test_conversations.py`：项目/会话 CRUD、标题生成、损坏文件容错。
- `tests/runtime/test_settings_api.py`：读写、key 掩码、空 key 不覆盖。
- 前端：`npm run build` 通过；手动走查对话时图谱闪烁。
