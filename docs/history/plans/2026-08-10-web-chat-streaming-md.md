# Web 对话体验修复实施计划：流式输出 + Markdown 渲染 + 检索激活链路

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Web 对话加流式输出与 Markdown 渲染，并在 chat 路径上加 RAG 增量索引刷新以杜绝检索静默退化。

**Architecture:** 新增 `POST /api/chat/stream` SSE 流式端点（DeepSeek `stream: true`，起搏动画与 LLM 流式并行），原 `/api/chat` 保留不动；前端 `fetch + ReadableStream` 逐帧接收、增量渲染，`react-markdown + remark-gfm` 渲染助手消息。依据 spec：`docs/specs/2026-08-10-web-chat-streaming-md-design.md`。

**Tech Stack:** FastAPI / httpx / pytest（后端）；React 18 + Vite + vitest（前端，无 jsdom，组件测试用 `react-dom/server` 的 `renderToString`）。

**工作目录与命令约定（全程遵守）：**

- 开发仓根目录：`D:/UESR/Desktop/Nexogenesis智构涌现/Nexogenesis-org`（下称「开发仓」）
- 后端命令需把 Python 3.13 放到 PATH 最前（Git Bash 裸 `python` 会落到 MS Store 占位符）：
  ```bash
  cd "D:/UESR/Desktop/Nexogenesis智构涌现/Nexogenesis-org"
  export PATH="/c/Users/MECHREVO/AppData/Local/Programs/Python/Python313:$PATH"
  ```
- 前端命令在 `web/` 子目录下执行（node v24 / npm 11 已确认可用）
- 每个 Task 末尾的 commit 步骤已获用户批准（随本计划批准一并授权），commit 前 pre-commit 钩子会跑 `nexogenesis validate`，WARNING 输出属正常

---

### Task 1: 后端 SSE delta 解析 + `call_deepseek_stream`

**Files:**
- Modify: `nexogenesis/runtime/chat.py`
- Test: `tests/runtime/test_chat_api.py`

- [ ] **Step 1: 写失败测试**

在 `tests/runtime/test_chat_api.py` 顶部 import 区追加 `parse_sse_delta`：

```python
from nexogenesis.runtime.chat import (
    build_messages, parse_sse_delta, run_chat, select_activation,
)
```

在文件中新增测试：

```python
def test_parse_sse_delta_extracts_text():
    line = 'data: {"choices":[{"delta":{"content":"你好"}}]}'
    assert parse_sse_delta(line) == "你好"


def test_parse_sse_delta_skips_non_data_lines():
    assert parse_sse_delta("") is None
    assert parse_sse_delta(": comment") is None
    assert parse_sse_delta('event: message') is None


def test_parse_sse_delta_done_and_empty():
    assert parse_sse_delta("data: [DONE]") is None
    assert parse_sse_delta("data:") is None
    # role-only delta（首帧常见）与空 content 都返回 None
    assert parse_sse_delta('data: {"choices":[{"delta":{"role":"assistant"}}]}') is None
    assert parse_sse_delta('data: {"choices":[{"delta":{"content":""}}]}') is None
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_chat_api.py -k parse_sse_delta -v
```
预期：FAIL，`ImportError: cannot import name 'parse_sse_delta'`

- [ ] **Step 3: 实现**

`nexogenesis/runtime/chat.py`：顶部 import 区加 `import json`；在 `call_deepseek` 之后追加：

```python
def parse_sse_delta(line: str) -> str | None:
    """解析单行 OpenAI 兼容 SSE 帧，返回文本 delta；非数据帧/[DONE]/空 delta 返回 None。"""
    if not line.startswith("data:"):
        return None
    data = line[len("data:"):].strip()
    if not data or data == "[DONE]":
        return None
    chunk = json.loads(data)
    return chunk["choices"][0].get("delta", {}).get("content") or None


async def call_deepseek_stream(settings: dict, messages: list[dict]):
    """调用 OpenAI 兼容 chat completions（流式），逐 delta yield 文本。"""
    url = settings["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings['api_key']}"}
    payload = {"model": settings["model"], "messages": messages, "stream": True}
    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                text = parse_sse_delta(line)
                if text:
                    yield text
```

- [ ] **Step 4: 跑测试确认通过**

```bash
python -m pytest tests/runtime/test_chat_api.py -k parse_sse_delta -v
```
预期：3 passed

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/chat.py tests/runtime/test_chat_api.py
git commit -m "feat(chat): SSE delta 解析与 DeepSeek 流式调用"
```

---

### Task 2: 提取 `_publish_pacing` + 流式编排 `run_chat_stream`

**Files:**
- Modify: `nexogenesis/runtime/chat.py`
- Test: `tests/runtime/test_chat_api.py`

- [ ] **Step 1: 写失败测试**

`tests/runtime/test_chat_api.py` import 区追加 `run_chat_stream`；文件顶部加 `import logging`（若已有则跳过）。新增测试与辅助函数：

```python
async def _collect(gen):
    return [d async for d in gen]


def _fake_llm_stream(chunks):
    async def gen(settings, messages):
        for c in chunks:
            yield c
    return gen


def test_run_chat_stream_deltas_events_and_index_refresh(monkeypatch, tmp_path):
    order = []
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: order.append("search") or HITS)

    async def fake_refresh(root):
        order.append("index")

    bus = FakeBus()
    deltas = asyncio.run(_collect(run_chat_stream(
        bus, tmp_path, GRAPH, [], "问题",
        settings={"base_url": "x", "model": "m", "api_key": "k"},
        sleep=lambda d: asyncio.sleep(0),
        llm_stream=_fake_llm_stream(["你", "好"]),
        index_refresh=fake_refresh,
    )))
    assert deltas == ["你", "好"]
    assert order == ["index", "search"]          # 索引保鲜先于检索
    types = [t for t, _ in bus.events]
    assert types[0] == "skill.trigger"
    assert types[1] == "retrieve.query"
    seed_hits = [p for t, p in bus.events
                 if t == "graph.hit" and p["role"] == "seed"]
    assert seed_hits and seed_hits[0]["node_ids"] == ["a", "b"]
    assert "card.read" in types
    assert types[-1] == "session.idle"


def test_run_chat_stream_index_refresh_failure_continues(monkeypatch, tmp_path, caplog):
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: [])

    async def bad_refresh(root):
        raise RuntimeError("db locked")

    bus = FakeBus()
    with caplog.at_level(logging.WARNING, logger="nexogenesis.runtime.chat"):
        deltas = asyncio.run(_collect(run_chat_stream(
            bus, tmp_path, GRAPH, [], "问题",
            settings={"base_url": "x", "model": "m", "api_key": "k"},
            llm_stream=_fake_llm_stream(["回答"]),
            index_refresh=bad_refresh,
        )))
    assert deltas == ["回答"]                     # 刷新失败不阻断对话
    assert any("索引刷新失败" in r.message for r in caplog.records)
    assert bus.events[-1][0] == "session.idle"


def test_run_chat_stream_no_seeds_skips_pacing(monkeypatch, tmp_path):
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: [])

    async def noop_refresh(root):
        pass

    bus = FakeBus()
    deltas = asyncio.run(_collect(run_chat_stream(
        bus, tmp_path, GRAPH, [], "问题",
        settings={"base_url": "x", "model": "m", "api_key": "k"},
        llm_stream=_fake_llm_stream(["裸回答"]),
        index_refresh=noop_refresh,
    )))
    assert deltas == ["裸回答"]
    types = [t for t, _ in bus.events]
    assert "graph.hit" not in types
    assert types[-1] == "session.idle"


def test_run_chat_stream_llm_failure_partial_and_idles(monkeypatch, tmp_path):
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: [])

    async def noop_refresh(root):
        pass

    async def failing_stream(settings, messages):
        yield "半截"
        raise RuntimeError("boom")

    bus = FakeBus()

    async def collect():
        out = []
        async for d in run_chat_stream(
            bus, tmp_path, GRAPH, [], "问题",
            settings={"base_url": "x", "model": "m", "api_key": "k"},
            llm_stream=failing_stream, index_refresh=noop_refresh,
        ):
            out.append(d)
        return out

    with pytest.raises(RuntimeError):
        asyncio.run(collect())
    assert bus.events[-1][0] == "session.idle"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_chat_api.py -k run_chat_stream -v
```
预期：FAIL，`ImportError: cannot import name 'run_chat_stream'`

- [ ] **Step 3: 实现（含 `run_chat` 起搏提取重构）**

`nexogenesis/runtime/chat.py` 顶部 import 区补充：

```python
import logging
from typing import AsyncIterator
from nexogenesis.rag.index import index_rag

logger = logging.getLogger(__name__)
```

把 `run_chat` 中的起搏段提取为模块级函数（放在 `_edge_nodes` 之后），并让 `run_chat` 改调它：

```python
async def _publish_pacing(bus, act: dict, sleep) -> None:
    """检索起搏动画：seed → expand×1~2 → card.read×≤2（节奏与 build_talk 对齐）。"""
    await sleep(1.0)
    await bus.publish("graph.hit", {
        "node_ids": act["seeds"], "edge_ids": [], "role": "seed",
    })
    await sleep(1.0)
    await bus.publish("graph.hit", {
        "node_ids": _edge_nodes(act["hop1"]),
        "edge_ids": [e["id"] for e in act["hop1"]],
        "role": "expand",
    })
    if act["hop2"]:
        await sleep(0.8)
        await bus.publish("graph.hit", {
            "node_ids": _edge_nodes(act["hop2"]),
            "edge_ids": [e["id"] for e in act["hop2"]],
            "role": "expand",
        })
    for cid in act["seeds"][:2]:
        await sleep(1.2)
        await bus.publish("card.read", {"card_id": cid})
```

`run_chat` 的 try 体改为（行为不变，现有起搏测试必须继续通过）：

```python
    try:
        act = select_activation(graph, rag_search(root, message, top=8))
        if act["seeds"]:
            await _publish_pacing(bus, act, sleep)
        messages = build_messages(history, act["excerpts"], message)
        answer = await llm(settings, messages)
    finally:
        await bus.publish("session.idle", {"reason": "talk-complete"})
    return answer
```

在 `run_chat` 之后追加流式编排：

```python
async def _default_index_refresh(root: Path) -> None:
    await asyncio.to_thread(index_rag, root, incremental=True)


async def run_chat_stream(
    bus,
    root: Path,
    graph: dict,
    history: list[dict],
    message: str,
    *,
    settings: dict,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    llm_stream: Callable[[dict, list[dict]], AsyncIterator[str]] = call_deepseek_stream,
    index_refresh: Callable[[Path], Awaitable[None]] = _default_index_refresh,
) -> AsyncIterator[str]:
    """流式对话编排：索引保鲜 → 检索 → 起搏动画与 LLM 流式并行，逐 delta yield。

    事件序列与 run_chat 一致；起搏在并发 task 中按原节奏播放，
    LLM 首 token 无需等待起搏完成。正常结束时等动画播完再 idle。
    """
    await bus.publish("skill.trigger", {"skill": "nexo-talk"})
    await bus.publish("retrieve.query", {"mode": "talk", "query": message})
    try:
        try:
            await index_refresh(root)
        except Exception:
            logger.warning("RAG 增量索引刷新失败，沿用现有索引", exc_info=True)
        act = select_activation(graph, rag_search(root, message, top=8))
        messages = build_messages(history, act["excerpts"], message)
        pacing = (asyncio.create_task(_publish_pacing(bus, act, sleep))
                  if act["seeds"] else None)
        try:
            async for delta in llm_stream(settings, messages):
                yield delta
            if pacing is not None:
                await pacing
        finally:
            if pacing is not None and not pacing.done():
                pacing.cancel()
    finally:
        await bus.publish("session.idle", {"reason": "talk-complete"})
```

- [ ] **Step 4: 跑新测试 + 回归既有测试**

```bash
python -m pytest tests/runtime/test_chat_api.py -v
```
预期：全部 passed（含既有 `test_run_chat_event_order_and_pacing` 等——起搏提取后节奏不变）

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/chat.py tests/runtime/test_chat_api.py
git commit -m "feat(chat): run_chat_stream 流式编排 + chat 前增量 RAG 索引刷新"
```

---

### Task 3: 流式端点 `POST /api/chat/stream`

**Files:**
- Modify: `nexogenesis/runtime/api.py`
- Test: `tests/runtime/test_chat_api.py`

- [ ] **Step 1: 写失败测试**

`tests/runtime/test_chat_api.py` 顶部加 `import json`。新增辅助函数与测试：

```python
def _read_sse_frames(r) -> list[dict]:
    frames = []
    for line in r.iter_lines():
        if line.startswith("data:"):
            frames.append(json.loads(line[len("data:"):].strip()))
    return frames


def _stream_client_with_conv(kb_root, monkeypatch, chunks=None, exc=None):
    """流式端点测试夹具：patch 检索/索引/LLM 流，返回 (client, conv)。"""
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: [])
    monkeypatch.setattr("nexogenesis.runtime.chat.index_rag",
                        lambda root, incremental=True: {})

    async def fake_stream(settings, messages):
        for c in chunks or []:
            yield c
        if exc is not None:
            raise exc

    monkeypatch.setattr("nexogenesis.runtime.chat.call_deepseek_stream",
                        fake_stream)
    proj = ensure_default_project(kb_root)
    conv = create_conversation(kb_root, proj["id"])
    return TestClient(create_app(kb_root)), conv


def test_chat_stream_requires_key(kb_root, monkeypatch):
    client, conv = _stream_client_with_conv(kb_root, monkeypatch, chunks=["x"])
    r = client.post("/api/chat/stream",
                    json={"conversation_id": conv["id"], "message": "hi"})
    assert r.status_code == 400
    assert "API Key" in r.json()["detail"]


def test_chat_stream_unknown_conversation(kb_root, monkeypatch):
    client, _ = _stream_client_with_conv(kb_root, monkeypatch, chunks=["x"])
    r = client.post("/api/chat/stream",
                    json={"conversation_id": "nope", "message": "hi"})
    assert r.status_code == 404


def test_chat_stream_success(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    client, conv = _stream_client_with_conv(kb_root, monkeypatch,
                                            chunks=["朋", "友"])
    with client.stream("POST", "/api/chat/stream",
                       json={"conversation_id": conv["id"], "message": "hi"}) as r:
        assert r.status_code == 200
        frames = _read_sse_frames(r)
    assert frames == [
        {"type": "delta", "text": "朋"},
        {"type": "delta", "text": "友"},
        {"type": "done"},
    ]
    saved = get_conversation(kb_root, conv["id"])
    assert [m["role"] for m in saved["messages"]] == ["user", "assistant"]
    assert saved["messages"][1]["content"] == "朋友"


def test_chat_stream_llm_failure_no_partial(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    client, conv = _stream_client_with_conv(kb_root, monkeypatch,
                                            exc=httpx.HTTPError("boom"))
    with client.stream("POST", "/api/chat/stream",
                       json={"conversation_id": conv["id"], "message": "hi"}) as r:
        frames = _read_sse_frames(r)
    assert frames[-1]["type"] == "error"
    assert "API Key" in frames[-1]["detail"]
    saved = get_conversation(kb_root, conv["id"])
    assert [m["role"] for m in saved["messages"]] == ["user", "system"]


def test_chat_stream_llm_failure_partial_persisted(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    client, conv = _stream_client_with_conv(kb_root, monkeypatch,
                                            chunks=["半截"], exc=RuntimeError("boom"))
    with client.stream("POST", "/api/chat/stream",
                       json={"conversation_id": conv["id"], "message": "hi"}) as r:
        frames = _read_sse_frames(r)
    assert frames[0] == {"type": "delta", "text": "半截"}
    assert frames[-1]["type"] == "error"
    saved = get_conversation(kb_root, conv["id"])
    roles = [m["role"] for m in saved["messages"]]
    assert roles == ["user", "assistant"]
    assert "半截" in saved["messages"][1]["content"]
    assert "中断" in saved["messages"][1]["content"]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_chat_api.py -k chat_stream -v
```
预期：FAIL，404/405（路由不存在）

- [ ] **Step 3: 实现**

`nexogenesis/runtime/api.py`：顶部 import 区加 `import asyncio` 和 `import json`。在 `_chat_router` 内、`chat` 路由之后追加：

```python
    from fastapi.responses import StreamingResponse

    @router.post("/api/chat/stream")
    async def chat_stream(body: ChatIn) -> StreamingResponse:
        conv = load_conversation(root, body.conversation_id)
        if conv is None:
            raise HTTPException(status_code=404,
                                detail=f"对话不存在: {body.conversation_id}")
        settings = load_settings(root)
        if not settings["api_key"]:
            raise HTTPException(status_code=400,
                                detail="请先在设置中配置 LLM API Key")

        def frame(obj: dict) -> str:
            return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

        async def gen():
            parts: list[str] = []
            failure: str | None = None
            try:
                async for delta in chat_module.run_chat_stream(
                    bus, root, graph_fn(), conv["messages"], body.message,
                    settings=settings,
                    llm_stream=chat_module.call_deepseek_stream,  # 调用时解析，便于测试 monkeypatch
                ):
                    parts.append(delta)
                    yield frame({"type": "delta", "text": delta})
            except (httpx.HTTPError, KeyError, IndexError, ValueError):
                logger.exception("LLM 流式调用失败")
                failure = "LLM 调用失败，请检查网络与 API Key 配置"
            except asyncio.CancelledError:
                # 客户端中途断开：尽力落盘已生成部分（best effort，重进会话可见）
                answer = "".join(parts)
                if answer:
                    append_messages(root, body.conversation_id, [
                        {"role": "user", "content": body.message},
                        {"role": "assistant",
                         "content": f"{answer}\n\n（本轮回答中断：客户端断开）"},
                    ])
                raise
            except Exception:
                logger.exception("对话服务内部失败")
                failure = "服务内部错误，请查看服务端日志"
            answer = "".join(parts)
            msgs: list[dict] = [{"role": "user", "content": body.message}]
            if failure is None:
                msgs.append({"role": "assistant", "content": answer})
            elif answer:
                msgs.append({"role": "assistant",
                             "content": f"{answer}\n\n（本轮回答中断：{failure}）"})
            else:
                msgs.append({"role": "system",
                             "content": f"（本轮回答失败：{failure}）"})
            append_messages(root, body.conversation_id, msgs)
            if failure is not None:
                yield frame({"type": "error", "detail": failure})
            else:
                yield frame({"type": "done"})

        return StreamingResponse(gen(), media_type="text/event-stream")
```

- [ ] **Step 4: 跑测试确认通过 + 全量后端回归**

```bash
python -m pytest tests/runtime/test_chat_api.py -v
python -m pytest
```
预期：全部 passed

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/api.py tests/runtime/test_chat_api.py
git commit -m "feat(api): POST /api/chat/stream 流式对话端点（含落盘纪律）"
```

---

### Task 4: 前端流式客户端 `sendChatStream`

**Files:**
- Modify: `web/src/api/client.ts`
- Test: `web/src/api/client.test.ts`

- [ ] **Step 1: 写失败测试**

`web/src/api/client.test.ts`：import 区把 `sendChatStream` 加入 `./client` 的导入列表。新增：

```ts
function mockStreamFetch(chunks: string[]) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    }),
  })));
}

describe("sendChatStream", () => {
  const noop = () => undefined;

  it("reassembles SSE frames across chunk boundaries", async () => {
    mockStreamFetch([
      'data: {"type":"delta","text":"你"}\n\nda',
      'ta: {"type":"delta","text":"好"}\n\ndata: {"type":"done"}\n\n',
    ]);
    const deltas: string[] = [];
    let done = false;
    await sendChatStream("c1", "hi", {
      onDelta: (t) => deltas.push(t),
      onDone: () => { done = true; },
      onError: () => { throw new Error("不应触发 onError"); },
    });
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toBe(true);
  });

  it("dispatches error frames", async () => {
    mockStreamFetch(['data: {"type":"error","detail":"LLM 调用失败，请检查网络与 API Key 配置"}\n\n']);
    let detail = "";
    await sendChatStream("c1", "hi", {
      onDelta: noop,
      onDone: noop,
      onError: (d) => { detail = d; },
    });
    expect(detail).toContain("API Key");
  });

  it("throws backend detail on non-streamed HTTP error", async () => {
    mockFetch(() => ({ ok: false, status: 400, body: { detail: "请先在设置中配置 LLM API Key" } }));
    await expect(sendChatStream("c1", "x", {
      onDelta: noop, onDone: noop, onError: noop,
    })).rejects.toThrow("请先在设置中配置 LLM API Key");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npx vitest run src/api/client.test.ts
```
预期：FAIL，`sendChatStream is not a function`（或导出不存在）

- [ ] **Step 3: 实现**

`web/src/api/client.ts`：在 `sendChat` 之后追加：

```ts
// ---------- 流式对话 ----------

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (detail: string) => void;
}

export async function sendChatStream(
  conversationId: string,
  message: string,
  h: ChatStreamHandlers
): Promise<void> {
  const r = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, message }),
  });
  if (!r.ok) {
    // 流开始前的校验错误（400/404）仍是普通 JSON 响应
    let detail = `${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch { /* 保留 status */ }
    throw new Error(detail);
  }
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === "delta") h.onDelta(ev.text);
      else if (ev.type === "done") h.onDone();
      else if (ev.type === "error") h.onError(ev.detail);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 前端全量回归**

```bash
cd web && npx vitest run
```
预期：全部 passed

- [ ] **Step 5: Commit**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts
git commit -m "feat(web): sendChatStream 流式客户端（fetch + ReadableStream 分帧重组）"
```

---

### Task 5: 助手消息 Markdown 渲染

**Files:**
- Modify: `web/package.json`（经 npm install）
- Modify: `web/src/components/ChatPanel.tsx`
- Modify: `web/src/index.css`
- Test: `web/src/components/ChatPanel.test.tsx`（新建）

- [ ] **Step 1: 安装依赖**

```bash
cd web && npm install react-markdown remark-gfm
```
预期：`package.json` dependencies 新增 `react-markdown`、`remark-gfm`，lock 更新

- [ ] **Step 2: 写失败测试**

新建 `web/src/components/ChatPanel.test.tsx`：

```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ChatPanel } from "./ChatPanel";

describe("ChatPanel markdown", () => {
  it("renders assistant message as markdown (list + table)", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false} onSend={() => undefined}
        messages={[{
          role: "assistant",
          content: "- 甲\n- 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
        }]} />
    );
    expect(html).toContain("<li>");
    expect(html).toContain("<table>");
  });

  it("keeps user message as plain text", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false} onSend={() => undefined}
        messages={[{ role: "user", content: "**不是粗体**" }]} />
    );
    expect(html).not.toContain("<strong>");
    expect(html).toContain("**不是粗体**");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd web && npx vitest run src/components/ChatPanel.test.tsx
```
预期：FAIL（assistant 消息按纯文本渲染，无 `<li>`）

- [ ] **Step 4: 实现**

`web/src/components/ChatPanel.tsx`：顶部加导入：

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
```

assistant 分支改为（去掉 `whitespace-pre-wrap`，交给 md 排版）：

```tsx
          ) : m.role === "assistant" ? (
            <div key={i} className="md-body px-1 text-[13px] leading-6 text-zinc-200">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
            </div>
          ) : (
```

`web/src/index.css` 末尾追加：

```css
/* ---------- 助手消息 Markdown 排版 ---------- */
.md-body > *:first-child { margin-top: 0; }
.md-body > *:last-child { margin-bottom: 0; }
.md-body p { margin: 0.5em 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 {
  margin: 0.9em 0 0.4em;
  font-weight: 600;
  color: #e4e4e7;
}
.md-body h1 { font-size: 1.15em; }
.md-body h2 { font-size: 1.08em; }
.md-body h3, .md-body h4 { font-size: 1em; }
.md-body ul, .md-body ol { margin: 0.5em 0; padding-left: 1.4em; }
.md-body ul { list-style: disc; }
.md-body ol { list-style: decimal; }
.md-body li { margin: 0.2em 0; }
.md-body li > ul, .md-body li > ol { margin: 0.2em 0; }
.md-body blockquote {
  margin: 0.5em 0;
  padding-left: 0.8em;
  border-left: 2px solid rgba(45, 212, 191, 0.4);
  color: #a1a1aa;
}
.md-body code {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.92em;
}
.md-body pre {
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 0.7em 0.9em;
  overflow-x: auto;
  margin: 0.6em 0;
}
.md-body pre code { background: none; padding: 0; }
.md-body table { margin: 0.6em 0; border-collapse: collapse; width: 100%; }
.md-body th, .md-body td {
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 0.3em 0.6em;
  text-align: left;
  font-size: 0.95em;
}
.md-body th { background: rgba(255, 255, 255, 0.05); font-weight: 600; }
.md-body a { color: #5eead4; text-decoration: underline; }
.md-body hr { border: none; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 0.8em 0; }
.md-body strong { color: #fafafa; }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd web && npx vitest run
```
预期：全部 passed

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/components/ChatPanel.tsx web/src/components/ChatPanel.test.tsx web/src/index.css
git commit -m "feat(web): 助手消息 react-markdown + remark-gfm 渲染与排版样式"
```

---

### Task 6: App.tsx 发送流程改流式

**Files:**
- Modify: `web/src/App.tsx`

说明：App 的 send 流程涉及 React 状态时序，无 jsdom 环境下不做组件级测试；行为由 Task 4 的客户端测试 + Task 7 的实际走查覆盖。

- [ ] **Step 1: 修改 import 与 send**

`web/src/App.tsx`：import 区把 `sendChat` 替换为 `sendChatStream`（`sendChat` 在 client.ts 中保留，仅此处不再使用）。

`send` 整个替换为：

```tsx
  const send = useCallback(async (text: string) => {
    if (!conv || sending) return;
    const convId = conv.id;
    const startCount = conv.messages.length;
    setSending(true);
    // 乐观追加 user 消息 + 空 assistant 气泡（流式填充）
    setLocalMsgs((list) => [
      ...list,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);
    const alignFromServer = async () => {
      const fresh = await fetchConversation(convId);
      if (convIdRef.current === convId) {
        setConv(fresh);
        // 保留本地系统提示；乐观消息已由服务端落盘
        setLocalMsgs((list) => list.filter((m) => m.role === "system"));
      }
      refreshProjects();
    };
    try {
      await sendChatStream(convId, text, {
        onDelta: (d) =>
          setLocalMsgs((list) => {
            const next = [...list];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, content: last.content + d };
            }
            return next;
          }),
        onDone: () => undefined,
        onError: () => undefined, // 失败/中断已落盘，统一以服务端为准对齐
      });
      await alignFromServer();
    } catch (e) {
      // 非流式错误（400/404/网络中断）：服务端若已落盘则以服务端为准
      let aligned = false;
      try {
        const fresh = await fetchConversation(convId);
        if (fresh.messages.length > startCount) {
          if (convIdRef.current === convId) {
            setConv(fresh);
            setLocalMsgs((list) => list.filter((m) => m.role === "system"));
          }
          aligned = true;
        }
      } catch { /* 落到下方失败提示 */ }
      if (!aligned && convIdRef.current === convId) {
        // 移除空 assistant 占位，保留乐观 user 消息，追加失败提示
        setLocalMsgs((list) =>
          list.filter((m) => !(m.role === "assistant" && m.content === "")));
        pushLocal({ role: "system", content: `发送失败：${e}` });
      }
    } finally {
      setSending(false);
    }
  }, [conv, sending, pushLocal, refreshProjects]);
```

- [ ] **Step 2: 类型检查 + 前端全量测试 + 构建**

```bash
cd web && npx tsc -b && npx vitest run && npm run build
```
预期：类型检查无错误；测试全 passed；`dist/` 构建成功

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(web): 对话发送改流式——乐观气泡增量填充，结束以服务端落盘对齐"
```

---

### Task 7: 全量回归 + 实践仓同步走查

**Files:** 无新增（验证与部署）

- [ ] **Step 1: 开发仓全量回归**

```bash
cd "D:/UESR/Desktop/Nexogenesis智构涌现/Nexogenesis-org"
export PATH="/c/Users/MECHREVO/AppData/Local/Programs/Python/Python313:$PATH"
python -m pytest
cd web && npx vitest run && npm run build
```
预期：后端、前端测试全 passed；构建成功（`web/dist/` 已更新，serve 直接托管 dist，无需实践仓再构建）

- [ ] **Step 2: 实践仓同步补丁**

```bash
cd "D:/UESR/Desktop/Nexogenesis智构涌现/NexogenesisV1.6org 金融2"
git merge dev/main
cd web && npm install
```
预期：合并无冲突；npm 补齐 react-markdown / remark-gfm

- [ ] **Step 3: 重启实践仓 Web 服务**

停掉旧服务进程（当前后台任务 `bash-bjqdlo4y`），重新启动：

```bash
cd "D:/UESR/Desktop/Nexogenesis智构涌现/NexogenesisV1.6org 金融2"
./.venv/Scripts/python.exe -m nexogenesis serve --root . --host 127.0.0.1 --port 8787
```

- [ ] **Step 4: 实际走查（用户在浏览器操作，代理协助观察）**

打开 http://127.0.0.1:8787/ ，发一条问题（如「金本位」相关），确认三件事：

1. 流式：回答逐字/逐段出现，首 token 约 1s 内可见
2. Markdown：列表/标题/加粗等排版正确渲染
3. 图谱：发送后种子卡片短暂点亮并沿关系扩散（RAG 索引已于 2026-08-10 全量重建，5455 chunks）
