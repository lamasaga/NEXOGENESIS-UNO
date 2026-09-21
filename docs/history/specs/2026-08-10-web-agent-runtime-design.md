# Web Agent Runtime 设计：对话框内复现思维体全部对话态能力

> 日期：2026-08-10
> 状态：已获用户方向确认，待实施（用户自行安排后续动工）
> 前置：`2026-08-10-web-chat-streaming-md-design.md`（流式 + md + 索引保鲜，已实施）

## 一、背景与目标

Web 端当前是「单发 bigram 检索 → 一次性答题」的固定管道：无 agent、无 skill 执行、无工具调用；事件流里的 `skill.trigger` 只是动画标签。CLI code agent 端则有完整技能体系（`.agent/skills/` 六个技能）+ 双轨多轮检索 + `write --batch` 写卡，体验差距是结构性的。2026-08-10 走查同时暴露：图谱动画含装饰成分（hop 扩散非真实读取）、检索与动画的对应关系不可查证。

**目标**：Web 对话框即 agent runtime 前端——用户仅在对话框输入，后端 agent loop 驱动 LLM 复现 code agent 的对话态全部能力：检索、读卡、判断、写卡（经确认）。图谱动画成为工具调用的真实副产品，天然忠实。

**本轮范围（用户确认）**：talk / emerge / judge 三个对话态技能一起接入。

**非目标**：

- compile / digest / construct 摄入管线的 Web 化（P3，形态更接近任务面板，单独设计）
- 引用解析二次点亮（由 sources 芯片替代）
- STM / 06-Journal 记忆集成、多用户与鉴权
- 侧边栏「思考/记忆/反思」占位按钮（面向未来的能力类别，不属于本轮）

## 二、关键决策（用户已确认）

| 决策点 | 结论 |
|---|---|
| 分期 | 对话态三技能（talk/emerge/judge）一起做 |
| 技能路由 | 触发词硬路由 + 模型兜底（忠实 AGENTS.md §四触发表） |
| 写入确认 | 对话内结构化确认卡，点击确认后才执行 `write --batch` |

## 三、总体架构

```
对话框输入 → POST /api/chat/stream（内部替换为 agent loop）
  → 技能路由（触发词硬路由，否则模型按技能索引自行判断）
  → 加载对应 SKILL.md 全文注入 system 层作为剧本
  → agent loop（DeepSeek function calling，≤6 轮）：
      retrieve / read_card / propose_write（emerge 与 talk 可用，见 §四）
      每次工具调用 → 实时映射图谱事件（忠实动画）
  → 最终回答轮流式输出；sources 帧列出本轮实际使用的卡片
  → 落盘（沿用现有纪律）
```

写入链路：`propose_write` → harness 校验（失败作为工具结果返回，模型修正后重提）→ 存待确认提案 → `confirm_request` 帧 → 前端确认卡 → `POST /api/write/confirm` → 执行 `write --batch` → `write.applied` 事件 + 结果落盘为 system 消息。

## 四、技能路由

| 技能 | 触发词（消息包含即命中） | 工具集 | 剧本 |
|---|---|---|---|
| judge | `深判`、`/judge` | retrieve、read_card | `nexo-judge/SKILL.md` |
| emerge | `记一下`、`/capture`、`涌现`、`记录` | retrieve、read_card、propose_write | `nexo-emerge/SKILL.md` |
| talk | （默认） | retrieve、read_card、propose_write | `nexo-talk/SKILL.md` |

- 硬路由：按上表顺序匹配首个触发词子串。
- 模型兜底：无触发词时加载 talk 剧本 + base prompt 中的技能索引摘要；talk 工具集保留 `propose_write`（base prompt 内嵌 emerge 核心纪律：≤3 候选、确认后写入、优先丰富已有卡片），使模型在未命中触发词时仍能完成记录类意图。完整 SKILL.md 只在硬路由命中时注入。
- SKILL.md 读取失败（文件缺失等）：降级为 base prompt + 日志警告，不阻断对话。
- 路由成功即发布 `skill.trigger`，`payload.skill` 为真实技能名（替换当前的固定标签）。

## 五、工具定义（function calling）

### 5.1 `retrieve`

```json
{
  "name": "retrieve",
  "description": "双轨检索知识库（图谱 + RAG）。换角度多次检索可提高召回。",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {"type": "string"},
      "note": {"type": "string", "description": "本轮检索目的；judge 模式下作为透镜名"}
    },
    "required": ["query"]
  }
}
```

- 返回（紧凑）：`{"seeds": [{"id", "title"}], "excerpts": [{"card_id", "attribution", "excerpt": "≤300字"}], "hop1_count": n}`。
- 事件映射（全部真实）：
  - talk/emerge：`retrieve.query` → `graph.hit(seed)` → `graph.hit(expand)`（复用 `select_activation`，种子=真实命中卡）
  - judge：第 N 次 retrieve 发布 `lens.begin {index: N, name: note || query, node_ids, edge_ids}`（引擎已有透镜渲染）
- 工具调用一律发 `step` 帧供前端渲染活动线。

### 5.2 `read_card`

```json
{
  "name": "read_card",
  "description": "读取卡片全文",
  "parameters": {"type": "object", "properties": {"card_id": {"type": "string"}}, "required": ["card_id"]}
}
```

- 返回 `{id, title, type, maturity, domains, updated, body}`（body 截断 4000 字）；不存在返回错误信息供模型更正。
- 事件：发布 `card.read {card_id}`。

### 5.3 `propose_write`（emerge 与 talk 工具集；judge 只读不含此工具）

```json
{
  "name": "propose_write",
  "description": "提出知识写入提案。经 harness 校验；用户在对话中确认后才执行。",
  "parameters": {
    "type": "object",
    "properties": {
      "summary": {"type": "string", "description": "给用户看的提案说明"},
      "operations": {"type": "array", "items": {"type": "object"},
                     "description": "write --batch 批处理 JSON（见 .agent/reference/write-transaction.md）"}
    },
    "required": ["summary", "operations"]
  }
}
```

- 后端立即用 harness 校验逻辑做 dry-run：
  - 校验失败 → 错误详情作为工具结果返回，模型修正后重新 `propose_write`（反馈循环）。
  - 校验通过 → 提案落盘 `.nexogenesis/pending-writes/<proposal_id>.json`（含 conversation_id、created_at、summary、operations），发 `confirm_request` 帧。模型随后应以简短收尾语结束本轮（剧本中写明）。
- 提案不自动执行；同一轮对话可多次提案（各自独立确认）。

## 六、agent loop 机制

1. 路由 → 组装 system（base prompt + 技能索引摘要 + 命中时注入 SKILL.md 全文）→ 发布 `skill.trigger`。
2. 循环 ≤6 轮。每轮调用 chat completions（`stream: true` + tools）：
   - 文本 delta 实时转发为 `delta` 帧。
   - `delta.tool_calls` 分片按 index 重组（id/name/arguments 跨帧拼接，arguments 为 JSON 字符串碎片）。
   - 轮结束：无 tool_calls → 最终轮，跳出；有 tool_calls → 依次执行工具，结果以 `tool` 角色消息回填，继续下一轮。
3. 达 6 轮上限：以当前上下文做最后一次无工具调用，强制产出回答。
4. 结束：发 `sources` 帧 → 落盘 → 发 `done` 帧。
5. 异常：沿用现有落盘纪律（LLM 错误/内部错误/客户端断开的部分落盘 + `error` 帧）。

**sources 语义**：本轮全部 retrieve 摘录关联的卡片 id ∪ read_card 读取的卡片 id，去重保序，上限 12，附标题。它同时回答「检索与动画的对应关系可查证」。

## 七、流式协议（在现有帧上扩展）

| 帧 | 载荷 | 前端行为 |
|---|---|---|
| `delta` | `{text}` | 填充 assistant 气泡（现有） |
| `step` | `{kind: "retrieve"\|"read_card"\|"propose_write", label: string}` | 回答上方灰色活动线，如「检索：金本位」「读卡：xxx」「提案：新建 2 卡」 |
| `sources` | `{cards: [{"id", "title"}]}` | 回答下方可点击卡片芯片，点击开 CardReader |
| `confirm_request` | `{proposal_id, summary, operations}` | 渲染确认卡：摘要 + 操作清单 + 确认/取消按钮 |
| `done` / `error` | （现有） | 结束 / 失败提示（现有） |

确认结果（`write/confirm` 返回后）：前端重新拉取 `/api/graph`（新卡入图）；`write.applied` 事件经现有 SSE 总线驱动点亮动画（引擎已支持）。

## 八、确认端点

`POST /api/write/confirm`，请求 `{proposal_id, decision: "confirm" | "cancel"}`：

- `confirm`：执行 `write --batch`（统一写入入口不变）；成功 → 发布 `write.applied {created, enriched}`，会话落盘 system 消息「已写入：…」；失败 → 落盘 system 失败消息。返回 `{applied, detail}`。
- `cancel`：丢弃提案，落盘 system 消息「已取消写入提案」。返回 `{applied: false}`。
- 提案不存在/已处理 → 404/409。
- 提案文件确认后删除；过期清理（24h）留待后续。

## 九、落盘与纪律

- 会话消息：user + assistant（assistant 消息附带 `sources` 字段，向后兼容的可选字段）。
- 写入纪律不变：`write --batch` 唯一入口；`origin: system` 限制仍由 harness 强制；确认卡是机械防呆，不用提示词维持。
- `propose_write` 的 operations 校验复用 harness 现有校验器，不在 agent 层另写一套。

## 十、错误处理

| 场景 | 行为 |
|---|---|
| SKILL.md 缺失 | 降级 base prompt + warning 日志 |
| 工具参数 JSON 解析失败 | 作为工具错误结果回填，模型自我修正 |
| retrieve/read_card 异常 | 工具结果返回错误文本，模型可见并决定换词/告知 |
| 6 轮上限 | 强制终答，回答中说明检索受限 |
| LLM 流异常 / 断连 | 沿用现有部分落盘 + error 帧纪律 |

## 十一、测试

- `tests/runtime/test_agent.py`（新）：脚本化假 LLM（预设 tool_calls 序列 + 文本）覆盖：
  - 三技能触发词路由（含模型兜底默认 talk）
  - retrieve/read_card 工具执行与对应图谱事件发布（事件=真实结果）
  - judge 模式多次 retrieve → `lens.begin` 序列（index 递增、name=note）
  - propose_write 校验失败 → 错误回填可重提；校验通过 → confirm_request 帧 + 提案落盘
  - 6 轮上限强制终答
  - sources 帧内容 = 检索 ∪ 读卡去重集合
- `tests/runtime/test_chat_api.py` 扩展：`/api/chat/stream` 走 agent loop 后的端到端（假 LLM）；`/api/write/confirm` 的 confirm/cancel/404/409 分支；确认后会话落盘 system 消息。
- 前端：`client` 新帧解析（step/sources/confirm_request）；`ChatPanel` 确认卡与 sources 芯片渲染（renderToString）。

## 十二、影响面

| 文件 | 改动 |
|---|---|
| `nexogenesis/runtime/agent.py` | 新增：路由、loop、工具调用重组 |
| `nexogenesis/runtime/agent_tools.py` | 新增：三个工具实现 + 事件映射 |
| `nexogenesis/runtime/pending_writes.py` | 新增：提案存取 |
| `nexogenesis/runtime/api.py` | `/api/chat/stream` 内部换 agent loop；+ `/api/write/confirm` |
| `nexogenesis/runtime/chat.py` | 保留（旧端点与共享函数不动） |
| `web/src/api/client.ts` | 新帧类型与解析；confirm API |
| `web/src/components/ChatPanel.tsx` | 活动线、sources 芯片、确认卡 |
| `web/src/components/ConfirmCard.tsx` | 新增（确认卡组件） |
| `web/src/App.tsx` | 确认动作接线、写后刷新图 |

## 十三、风险与对策

| 风险 | 对策 |
|---|---|
| DeepSeek tool_calls 流式分片重组出错 | 单元测试覆盖分片边界；解析失败按工具错误回填 |
| 多轮调用 token 成本 | 摘录/读卡截断；6 轮上限；历史限 10 条（现有） |
| SKILL.md 过长挤占上下文 | 只注入硬路由命中的那一份；talk 默认只用摘要 |
| 模型生成非法 write batch | dry-run 校验反馈循环；确认卡二次人工把关 |
