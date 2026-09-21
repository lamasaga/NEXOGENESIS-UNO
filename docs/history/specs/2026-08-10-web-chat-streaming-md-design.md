# Web 对话体验修复设计：流式输出 + Markdown 渲染 + 检索激活链路

> 日期：2026-08-10
> 状态：已获用户方向确认（流式方案 A；高亮节奏保持现状；图谱范围保持 cards-only）
> 背景：实践仓 Web 界面走查发现三个问题

## 一、问题与诊断

| # | 现象 | 诊断 |
|---|---|---|
| 1 | 无流式输出，等待数十秒后整段出现 | `runtime/chat.py:call_deepseek` 写死 `stream: False`；`/api/chat` 一次性返回完整 JSON |
| 2 | 助手回复无 Markdown 渲染，排版难看 | `ChatPanel.tsx` 以 `whitespace-pre-wrap` 纯文本直出 |
| 3 | 检索后中央图谱无点亮效果 | **非代码 bug**：实践仓 RAG 索引残缺（仅 3 个 OutBox 文件 26 chunk，卡片 0 索引），`rag_search` 零命中 → 无种子 → 后端从未发布 `graph.hit`。2026-08-10 已在实践仓全量重建（26 → 5455 chunk），链路复测通过 |

问题 3 暴露的设计缺口：RAG 索引依赖 `compile`/`write` 命令顺带刷新，漏跑即**静默退化**（聊天照常、检索为空、图谱不亮）。本设计在 chat 路径上加廉价的增量刷新，杜绝复发。

## 二、范围与非目标

**范围**：`/api/chat/stream` 流式端点；chat 前增量索引刷新；前端流式接收与增量渲染；助手消息 Markdown 渲染。

**非目标（用户确认）**：

- 中央图谱只呈现 `01-Cards/` 卡片节点。buffer/archive/outbox 命中若无 `linked_cards` 关联到卡片，则不在图谱上体现——这是有意的范围界定，不为其它文件夹建图节点。
- 检索高亮保持「短暂闪烁即消退」的现有节奏，不做钉住/常驻。
- 原 `/api/chat` 非流式端点保留不动（现有测试与降级路径零影响）。

## 三、后端设计

### 3.1 DeepSeek 流式调用

`runtime/chat.py` 新增 `call_deepseek_stream(settings, messages)`：异步生成器。
httpx `stream=True` POST，`payload["stream"]=True`；逐行解析 SSE 帧（`data: {json}`，遇 `data: [DONE]` 结束），yield 每个 `choices[0].delta.content` 文本片段。原 `call_deepseek` 保留。

### 3.2 流式编排 `run_chat_stream`

异步生成器，事件序列与 `run_chat` 对齐：

1. 发布 `skill.trigger` / `retrieve.query`（沿用现有事件类型与节奏）。
2. **检索前先增量刷新索引**：`index_rag(root, kinds=["archive","buffer","discussion","outbox","card_excerpt"], incremental=True)`，经 `asyncio.to_thread` 避免阻塞事件循环（增量为毫秒~几十毫秒级 sqlite 操作）。
3. `select_activation` 求种子与扩散边。
4. **起搏动画与 LLM 流式并行**：起搏（`graph.hit` seed/expand、`card.read`，含现有 sleep 节奏）放入并发 task；同时开始逐 delta yield LLM 输出——用户约 1s 内看到首个 token，图谱动画同时播放。
5. `finally` 发布 `session.idle`（沿用）。

### 3.3 流式端点 `POST /api/chat/stream`

- `StreamingResponse`，`media_type="text/event-stream"`，帧格式：`data: {"type":"delta","text":"..."}` / `{"type":"done"}` / `{"type":"error","detail":"..."}`。
- 前置校验与原端点一致：会话存在 404、未配 key 400。
- **落盘纪律**（沿用现有约定）：正常结束 → 落盘 user + assistant（完整答案）；LLM 中途异常 → 已生成部分照常落盘为 assistant 并追加中断标注，帧内发 `error`；服务内部异常 → 落盘 user + system 失败标记。前端最终以服务端会话为准对齐。

## 四、前端设计

### 4.1 流式客户端

`api/client.ts` 新增 `sendChatStream(conversationId, message, handlers)`：`fetch` POST + `response.body.getReader()` 逐帧读取（EventSource 不支持 POST，故用 fetch 流）；按 `\n\n` 切帧、JSON 解析，回调 `onDelta(text)` / `onDone()` / `onError(detail)`。

### 4.2 发送流程（`App.tsx`）

1. 发送即乐观追加 user 消息 + 空 assistant 消息（打字光标态），`sending` 指示器保留至首个 delta 到达。
2. 每个 delta 增量更新本地 assistant 消息内容。
3. `done` 后 `fetchConversation` 以服务端落盘为准对齐（沿用现有纪律）；`error` 时同样回读服务端状态。

### 4.3 Markdown 渲染（`ChatPanel.tsx`）

- 新依赖：`react-markdown` + `remark-gfm`（GFM 表格/删除线/任务列表；不引入代码高亮，YAGNI）。
- 仅 assistant 消息用 `<ReactMarkdown>` 渲染；user 消息保持纯文本气泡；流式期间持续重渲染，排版逐步成形。
- 排版样式走 Tailwind 自定义（项目未引入 `@tailwindcss/typography`，不为此加插件）。

## 五、错误处理

| 场景 | 行为 |
|---|---|
| DeepSeek 连接/鉴权失败（流开始前） | 帧 `error` + 落盘 system 失败标记（同现有 502 纪律） |
| 流中途断 | 已生成部分落盘 assistant + 中断标注；前端保留已渲染内容并提示 |
| 客户端中途关闭 | 生成器 `finally` 中尽力落盘已生成部分 + 中断标注（best effort，重进会话可见） |
| 索引刷新失败 | 记 warning 日志，用现有索引继续检索（不阻断对话） |

## 六、测试

- 后端：`/api/chat/stream` 单测——mock LLM delta 序列，断言帧序列（delta* → done）、落盘内容、检索起搏事件照常发布、chat 前触发了增量索引刷新；LLM 中途异常的分支。
- 前端：`ChatPanel` 渲染测试（assistant 消息 md 渲染出列表/表格）；`client` 流解析测试（模拟分帧/跨帧边界）。
- 走查：实践仓 pull 后全量重建索引已就位，实问一条验证「首 token 延迟、流式排版、图谱点亮」三件事。

## 七、影响面

- `nexogenesis/runtime/chat.py`：+ `call_deepseek_stream` / `run_chat_stream`
- `nexogenesis/runtime/api.py`：+ `/api/chat/stream` 路由
- `web/src/api/client.ts`：+ `sendChatStream`
- `web/src/App.tsx`：send 流程改流式
- `web/src/components/ChatPanel.tsx`：md 渲染 + 流式气泡
- `web/package.json`：+ react-markdown、remark-gfm
- 测试：`tests/runtime/` 新增流式用例；`web/src` 组件/客户端测试
