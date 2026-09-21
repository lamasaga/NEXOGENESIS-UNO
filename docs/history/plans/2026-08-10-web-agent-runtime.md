# Web Agent Runtime 实施计划：talk/emerge/judge 三技能 Web 化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web 对话框变为 agent runtime 前端——后端 agent loop 驱动 DeepSeek function calling，复现 talk/emerge/judge 三技能，图谱动画成为工具调用的真实副产品。

**Architecture:** 依据 spec `docs/specs/2026-08-10-web-agent-runtime-design.md`。`/api/chat/stream` 内部替换为 agent loop（≤6 轮工具调用，最终轮流式）；写卡走 `propose_write` → 对话内确认卡 → `/api/write/confirm` → `execute_batch`（从 `write --batch` 提取的程序化入口）。

**Tech Stack:** FastAPI / httpx 流式 / pytest（后端）；React 18 + vitest（前端，`renderToString` 测组件）。

**工作目录与命令约定（全程遵守）：**

- 开发仓根目录：`D:/UESR/Desktop/Nexogenesis智构涌现/Nexogenesis-org`
- 后端命令前缀：
  ```bash
  cd "D:/UESR/Desktop/Nexogenesis智构涌现/Nexogenesis-org"
  export PATH="/c/Users/MECHREVO/AppData/Local/Programs/Python/Python313:$PATH"
  ```
- 前端命令在 `web/` 下执行
- 每个 Task 末尾 commit（已随计划批准授权）

**关键背景知识（实施者需知）：**

- `BatchOperation`（`nexogenesis/operations.py`）是 dataclass，可直接构造：`BatchOperation(operation_id=..., source=..., approved_by=..., writes=[...], allow_system_promotion=False)`
- `append_messages(root, conv_id, messages)` 原样保留附加字段（assistant 消息可带 `sources`）
- 既有测试约定：FakeBus（`tests/runtime/test_chat_api.py`）、`kb_root` fixture（`tests/runtime/conftest.py`，含 5 张卡 + 图快照）
- SKILL.md 路径：`<root>/.agent/skills/nexo-{talk,emerge,judge}/SKILL.md`（2.4–4.8KB，直接注入）
- 旧 `/api/chat`（非流式）与 `run_chat`/`run_chat_stream` 保留不动

---

### Task 1: 提取 `execute_batch`（write.py 重构）

**Files:**
- Modify: `nexogenesis/commands/write.py`
- Test: `tests/test_write_command.py`（新增用例）

- [ ] **Step 1: 写失败测试**

`tests/test_write_command.py` 末尾追加（沿用该文件既有 fixture/辅助函数；若文件已有 `_write_card`/`init` 类辅助则复用，先看文件头部）：

```python
def test_execute_batch_returns_created_and_enriched(tmp_path):
    from nexogenesis.commands.init import init_cmd
    from nexogenesis.commands.write import execute_batch
    from nexogenesis.operations import BatchOperation
    from click.testing import CliRunner

    runner = CliRunner()
    runner.invoke(init_cmd, ["--root", str(tmp_path)])
    cards_dir = tmp_path / "01-Cards"
    cards_dir.mkdir(exist_ok=True)
    cards_dir.joinpath("已有卡.md").write_text(
        "---\nid: 已有卡\ntitle: 已有卡\ntype: claim\nmaturity: seed\n"
        "lifecycle: active\ndomains: [d1]\norigin: user\nsources: []\nrelations: []\n"
        "created: '2026-08-10'\nupdated: '2026-08-10'\n---\n\n旧正文。\n",
        encoding="utf-8",
    )
    batch = BatchOperation(
        operation_id="op-test-1", source="test", approved_by="user",
        writes=[
            {"id": "新卡一", "title": "新卡一", "type": "claim", "maturity": "seed",
             "domains": ["d1"], "origin": "user", "sources": ["test"],
             "body": "全新内容。"},
            {"id": "已有卡", "title": "已有卡", "type": "claim", "maturity": "seed",
             "domains": ["d1"], "origin": "user", "sources": ["test"],
             "body": "改写后的正文。"},
        ],
    )
    result = execute_batch(tmp_path, batch)
    assert result["created"] == ["新卡一"]
    assert result["enriched"] == ["已有卡"]
    assert result["card_count"] == 2
    assert "改写后的正文" in cards_dir.joinpath("已有卡.md").read_text(encoding="utf-8")


def test_execute_batch_rejects_ghost_link(tmp_path):
    from nexogenesis.commands.init import init_cmd
    from nexogenesis.commands.write import execute_batch
    from nexogenesis.operations import BatchOperation
    from click.testing import CliRunner
    import pytest

    runner = CliRunner()
    runner.invoke(init_cmd, ["--root", str(tmp_path)])
    batch = BatchOperation(
        operation_id="op-test-2", source="test", approved_by="user",
        writes=[
            {"id": "坏卡", "title": "坏卡", "type": "claim", "maturity": "seed",
             "domains": ["d1"], "origin": "user", "sources": ["test"],
             "body": "引用了 [[不存在的卡]]。"},
        ],
    )
    with pytest.raises(RuntimeError, match="幽灵链接"):
        execute_batch(tmp_path, batch)
    assert not (tmp_path / "01-Cards" / "坏卡.md").exists()
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/test_write_command.py -k execute_batch -v
```
预期：FAIL，`ImportError: cannot import name 'execute_batch'`

- [ ] **Step 3: 实现重构**

`nexogenesis/commands/write.py`：把 `write_cmd` 函数体中 `BatchOperation.from_file` 之后的全部逻辑提取为模块级函数，CLI 变薄壳。**逐字移动逻辑，只改三处**：①权限/幽灵链接拒绝由 `click.ClickException` 改抛 `RuntimeError`（消息保留 `"Write rejected:\n"` 前缀）；②尾部校验失败同样抛 `RuntimeError`（保留 `"Write failed (no commit): "` 前缀）；③新增返回值。

在 `_check_wikilinks_in_writes` 之后插入：

```python
def execute_batch(root_path: Path, batch_op: BatchOperation) -> dict:
    """程序化批量写入入口：权限/幽灵链接检查 → staging 校验 → 原子提交 → 索引刷新。

    返回 {"created", "enriched", "warnings", "card_count", "question_count",
    "profile_field_count"}；任何失败抛 RuntimeError 且不落盘（staging 纪律不变）。
    """
    root_path = Path(root_path).resolve()
    cards_dir = root_path / "01-Cards"
    cards_dir.mkdir(parents=True, exist_ok=True)
    profile_path = root_path / "02-Profile" / "问题清单.md"

    card_writes = [w for w in batch_op.writes if w.get("target", "card") == "card"]
    profile_writes = [w for w in batch_op.writes if w.get("target") == "profile_question"]
    profile_field_writes = [w for w in batch_op.writes if w.get("target") == "profile_field"]

    pre_errors = _check_write_permissions(batch_op)
    if pre_errors:
        raise RuntimeError("Write rejected:\n" + "\n".join(pre_errors))

    known_ids = {p.stem for p in cards_dir.glob("*.md") if not p.name.startswith("_")}
    link_errors = _check_wikilinks_in_writes(batch_op, known_ids)
    if link_errors:
        raise RuntimeError("Write rejected:\n" + "\n".join(link_errors))

    staging = root_path / ".nexogenesis" / "tmp" / f"write-{batch_op.operation_id}"
    if staging.exists():
        shutil.rmtree(staging)
    staging_cards = staging / "01-Cards"
    staging_cards.mkdir(parents=True)
    staging_meta = staging_cards / "_meta"
    staging_meta.mkdir(parents=True, exist_ok=True)

    for path in cards_dir.glob("*.md"):
        if path.name.startswith("_"):
            continue
        shutil.copy2(path, staging_cards / path.name)
    src_meta = cards_dir / "_meta"
    if src_meta.exists():
        for path in src_meta.glob("*.md"):
            shutil.copy2(path, staging_meta / path.name)

    for item in card_writes:
        meta = card_meta_from_write(item)
        _preserve_created(cards_dir, item, meta)
        content = merge_frontmatter(meta, item.get("body", ""))
        atomic_write_file(staging_cards / f"{item['id']}.md", content)

    staged_profile: str | None = None
    if profile_writes:
        existing = profile_path.read_text(encoding="utf-8") if profile_path.exists() else None
        staged_profile = existing
        for pw in profile_writes:
            staged_profile = _append_profile_question_content(staged_profile, pw)
        staging_profile = staging / "02-Profile"
        staging_profile.mkdir(parents=True, exist_ok=True)
        atomic_write_file(staging_profile / "问题清单.md", staged_profile)

    staged_profile_fields: dict[str, str] = {}
    if profile_field_writes:
        profile_dir = root_path / "02-Profile"
        profile_dir.mkdir(parents=True, exist_ok=True)
        staging_profile = staging / "02-Profile"
        staging_profile.mkdir(parents=True, exist_ok=True)
        for pfw in profile_field_writes:
            file_name = pfw["file"]
            _validate_profile_field_file(file_name)
            file_path = profile_dir / file_name
            existing = file_path.read_text(encoding="utf-8") if file_path.exists() else None
            staged_profile_fields[file_name] = _append_profile_field_content(
                staged_profile_fields.get(file_name, existing), pfw
            )
        for file_name, content in staged_profile_fields.items():
            atomic_write_file(staging_profile / file_name, content)

    try:
        errors, warnings = run_validate(root_path, cards_dir_override=staging_cards)
        if errors:
            raise RuntimeError("; ".join(errors))

        for item in card_writes:
            src = staging_cards / f"{item['id']}.md"
            atomic_write_file(cards_dir / f"{item['id']}.md", src.read_text(encoding="utf-8"))

        if staged_profile is not None:
            profile_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_file(profile_path, staged_profile)

        for file_name, content in staged_profile_fields.items():
            target_path = profile_path.parent / file_name
            atomic_write_file(target_path, content)

        journal.append(
            root_path,
            batch_op.operation_id,
            "write",
            [w["id"] for w in card_writes],
            batch_op.source,
            batch_op.approved_by,
        )
        generate_indexes(root_path)
        from nexogenesis.indexing import refresh_derived_indexes

        refresh_derived_indexes(
            root_path,
            graph=True,
            rag=True,
            rag_kinds=["card_excerpt", "buffer", "archive", "discussion", "outbox"],
            quiet=True,
        )
    except RuntimeError:
        raise RuntimeError("Write failed (no commit)") from None
    except Exception as exc:
        raise RuntimeError(f"Write failed (no commit): {exc}") from exc
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    return {
        "created": [w["id"] for w in card_writes if w["id"] not in known_ids],
        "enriched": [w["id"] for w in card_writes if w["id"] in known_ids],
        "warnings": warnings,
        "card_count": len(card_writes),
        "question_count": len(profile_writes),
        "profile_field_count": len(profile_field_writes),
    }
```

`write_cmd` 改为：

```python
@click.command()
@click.option("--batch", required=True, type=click.Path(exists=True), help="batch YAML 文件")
@click.option("--root", default=".", help="项目根目录")
def write_cmd(batch: str, root: str):
    batch_op = BatchOperation.from_file(Path(batch))
    try:
        result = execute_batch(Path(root), batch_op)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
    for w in result["warnings"]:
        click.echo(f"WARNING: {w}")
    click.echo(
        f"Wrote {result['card_count']} card(s), {result['question_count']} question(s), "
        f"{result['profile_field_count']} profile field(s)."
    )
```

注意：`write_cmd` 原有第一行 `root_path = Path(root).resolve()` 等已由 execute_batch 承担，CLI 不再重复。原 `except Exception as exc: raise click.ClickException(f"Write failed (no commit): {exc}")` 的语义由 execute_batch 内部两个 except 分支保留（validate errors 走无消息后缀版，其它异常带原始消息）。

- [ ] **Step 4: 跑新测试 + 全量回归**

```bash
python -m pytest tests/test_write_command.py -v
python -m pytest
```
预期：全部 passed（CLI 行为不变，`tests/test_acceptance.py` 等既有用例不回归）

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/commands/write.py tests/test_write_command.py
git commit -m "refactor(write): 提取 execute_batch 程序化入口（返回 created/enriched），CLI 变薄壳"
```

---

### Task 2: 待确认提案存取 `runtime/pending_writes.py`

**Files:**
- Create: `nexogenesis/runtime/pending_writes.py`
- Test: `tests/runtime/test_pending_writes.py`

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/test_pending_writes.py`：

```python
from nexogenesis.runtime.pending_writes import (
    load_proposal, mark_proposal, save_proposal,
)


def test_save_load_mark_proposal(tmp_path):
    p = save_proposal(tmp_path, "conv-1", "新建两张金本位卡",
                      [{"id": "卡a", "title": "卡a"}])
    assert p["status"] == "pending"
    assert p["conversation_id"] == "conv-1"
    assert p["summary"] == "新建两张金本位卡"
    loaded = load_proposal(tmp_path, p["id"])
    assert loaded == p

    marked = mark_proposal(tmp_path, p["id"], "confirmed")
    assert marked["status"] == "confirmed"
    assert load_proposal(tmp_path, p["id"])["status"] == "confirmed"


def test_load_missing_returns_none(tmp_path):
    assert load_proposal(tmp_path, "nope") is None


def test_mark_missing_returns_none(tmp_path):
    assert mark_proposal(tmp_path, "nope", "cancelled") is None


def test_proposal_id_is_filesystem_safe(tmp_path):
    p = save_proposal(tmp_path, "c", "s", [{"id": "x"}])
    assert "/" not in p["id"] and "\\" not in p["id"] and ".." not in p["id"]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_pending_writes.py -v
```
预期：FAIL，模块不存在

- [ ] **Step 3: 实现**

新建 `nexogenesis/runtime/pending_writes.py`：

```python
"""Web agent 写卡提案：propose_write 落盘 → 用户确认/取消 → 标记状态。"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from nexogenesis.yaml_utils import atomic_write_file


def _dir(root: Path) -> Path:
    return root / ".nexogenesis" / "pending-writes"


def save_proposal(root: Path, conversation_id: str, summary: str,
                  operations: list[dict]) -> dict:
    root = root.resolve()
    _dir(root).mkdir(parents=True, exist_ok=True)
    proposal = {
        "id": f"pw-{uuid.uuid4().hex[:12]}",
        "operation_id": f"web-{uuid.uuid4().hex[:10]}",
        "conversation_id": conversation_id,
        "summary": summary,
        "operations": operations,
        "status": "pending",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    atomic_write_file(_dir(root) / f"{proposal['id']}.json",
                      json.dumps(proposal, ensure_ascii=False, indent=2) + "\n")
    return proposal


def load_proposal(root: Path, proposal_id: str) -> dict | None:
    if not proposal_id.startswith("pw-") or "/" in proposal_id or "\\" in proposal_id:
        return None
    path = _dir(root.resolve()) / f"{proposal_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def mark_proposal(root: Path, proposal_id: str, status: str) -> dict | None:
    proposal = load_proposal(root, proposal_id)
    if proposal is None:
        return None
    proposal["status"] = status
    atomic_write_file(_dir(root.resolve()) / f"{proposal_id}.json",
                      json.dumps(proposal, ensure_ascii=False, indent=2) + "\n")
    return proposal
```

- [ ] **Step 4: 跑测试确认通过**

```bash
python -m pytest tests/runtime/test_pending_writes.py -v
```
预期：4 passed

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/pending_writes.py tests/runtime/test_pending_writes.py
git commit -m "feat(runtime): 写卡提案存取（pending-writes）"
```

---

### Task 3: agent 基础件（路由/剧本/流式轮/tool_calls 重组）

**Files:**
- Create: `nexogenesis/runtime/agent.py`
- Test: `tests/runtime/test_agent.py`

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/test_agent.py`：

```python
import json

from nexogenesis.runtime.agent import (
    RoundResult, ToolCallAssembler, build_agent_messages, build_tools,
    load_playbook, parse_sse_chunk, route_skill,
)


def test_route_skill_hard_triggers():
    assert route_skill("帮我深判一下这个张力") == "judge"
    assert route_skill("/judge 这个争论") == "judge"
    assert route_skill("记一下这个想法") == "emerge"
    assert route_skill("/capture 灵感") == "emerge"
    assert route_skill("尝试进行一次涌现") == "emerge"
    assert route_skill("金本位是怎么回事") == "talk"


def test_load_playbook_reads_skill_md(tmp_path):
    d = tmp_path / ".agent" / "skills" / "nexo-talk"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("# talk 剧本", encoding="utf-8")
    assert load_playbook(tmp_path, "talk") == "# talk 剧本"
    assert load_playbook(tmp_path, "judge") is None  # 缺失不抛异常


def test_build_tools_by_skill():
    names = lambda ts: [t["function"]["name"] for t in ts]
    assert names(build_tools("judge")) == ["retrieve", "read_card"]
    assert names(build_tools("emerge")) == ["retrieve", "read_card", "propose_write"]
    assert names(build_tools("talk")) == ["retrieve", "read_card", "propose_write"]


def test_parse_sse_chunk():
    assert parse_sse_chunk('data: {"choices":[{"delta":{"content":"x"}}]}') == \
        {"choices": [{"delta": {"content": "x"}}]}
    assert parse_sse_chunk("data: [DONE]") is None
    assert parse_sse_chunk(": ping") is None
    assert parse_sse_chunk("data:") is None


def test_tool_call_assembler_fragments():
    asm = ToolCallAssembler()
    # OpenAI 流式：首个分片带 id+name，后续只有 arguments 碎片
    asm.feed({"index": 0, "id": "call_1", "type": "function",
              "function": {"name": "retrieve", "arguments": ""}})
    asm.feed({"index": 0, "function": {"arguments": '{"que'}})
    asm.feed({"index": 0, "function": {"arguments": 'ry":"金本位"}'}})
    asm.feed({"index": 1, "id": "call_2", "type": "function",
              "function": {"name": "read_card", "arguments": '{"card_id":"a"}'}})
    calls = asm.finalize()
    assert calls == [
        {"id": "call_1", "name": "retrieve", "arguments": '{"query":"金本位"}'},
        {"id": "call_2", "name": "read_card", "arguments": '{"card_id":"a"}'},
    ]


def test_build_agent_messages_injects_playbook():
    msgs = build_agent_messages(
        [{"role": "user", "content": "旧问题"},
         {"role": "assistant", "content": "旧回答", "sources": [{"id": "x"}]},
         {"role": "system", "content": "本地提示"}],
        "新问题", playbook="# 剧本", skill="talk",
    )
    assert msgs[0]["role"] == "system"
    assert "# 剧本" in msgs[0]["content"]
    assert msgs[1] == {"role": "user", "content": "旧问题"}
    # assistant 历史只带 role/content（剥离 sources 等附加字段）
    assert msgs[2] == {"role": "assistant", "content": "旧回答"}
    assert msgs[-1] == {"role": "user", "content": "新问题"}


def test_round_result_text():
    r = RoundResult()
    r.text_parts.extend(["你", "好"])
    assert r.text == "你好"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_agent.py -v
```
预期：FAIL，模块不存在

- [ ] **Step 3: 实现**

新建 `nexogenesis/runtime/agent.py`：

```python
"""Web agent runtime：技能路由 + DeepSeek function calling 循环。

技能剧本（.agent/skills/nexo-*/SKILL.md）在每次请求时从磁盘热加载——
改剧本即改行为，无需改代码、无需重启。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Callable

import httpx

logger = logging.getLogger(__name__)

HISTORY_LIMIT = 10
MAX_ROUNDS = 6

AGENT_SYSTEM_PROMPT = (
    "你是 Nexogenesis 知识体的思维体助手，运行在本项目的 agent runtime 中，"
    "可通过工具检索知识库、读取卡片全文、提出写入提案。\n"
    "纪律：\n"
    "1. 回答优先基于工具检索到的卡片，引用时注明 [card-id]。\n"
    "2. 一次检索不足时，换角度用不同 query 再次调用 retrieve（多轮检索是正常的）。\n"
    "3. 用户意图为记录/涌现新知时：≤3 个候选、优先丰富已有卡片，"
    "必须调用 propose_write 由用户在界面确认后才写入，禁止口头声称已写入。\n"
    "4. 深判（judge）时：用 2–4 个透镜分别检索分析，定位张力而非裁决真假。\n"
    "5. 摘录不足以回答时，明确说明知识库缺少相关内容，再给出通用见解。\n"
    "技能索引：talk（默认对话）/ emerge（记一下·捕获）/ judge（深判）"
)

SKILL_TRIGGERS = [
    ("judge", ("深判", "/judge")),
    ("emerge", ("记一下", "/capture", "涌现", "记录")),
]
DEFAULT_SKILL = "talk"


def route_skill(message: str) -> str:
    """触发词硬路由：按表序命中首个触发词；否则默认 talk（模型可兜底判断）。"""
    for skill, words in SKILL_TRIGGERS:
        if any(w in message for w in words):
            return skill
    return DEFAULT_SKILL


def load_playbook(root: Path, skill: str) -> str | None:
    """热加载 SKILL.md；缺失返回 None（降级 base prompt，不阻断）。"""
    path = root / ".agent" / "skills" / f"nexo-{skill}" / "SKILL.md"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("技能剧本缺失，降级 base prompt: %s", path)
        return None


# ---------- 工具 schema ----------

_RETRIEVE_TOOL = {
    "type": "function",
    "function": {
        "name": "retrieve",
        "description": "双轨检索知识库（图谱 + RAG）。换角度多次检索可提高召回。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索词"},
                "note": {"type": "string",
                         "description": "本轮检索目的；judge 模式下作为透镜名"},
            },
            "required": ["query"],
        },
    },
}

_READ_CARD_TOOL = {
    "type": "function",
    "function": {
        "name": "read_card",
        "description": "读取卡片全文",
        "parameters": {
            "type": "object",
            "properties": {"card_id": {"type": "string"}},
            "required": ["card_id"],
        },
    },
}

_PROPOSE_WRITE_TOOL = {
    "type": "function",
    "function": {
        "name": "propose_write",
        "description": "提出知识写入提案。经 harness 校验；用户在对话中确认后才执行。",
        "parameters": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "给用户看的提案说明"},
                "operations": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "write --batch 的 writes 数组"
                    "（每项含 id/title/type/maturity/domains/origin/sources/body，"
                    "可选 relations；丰富已有卡片用同一 id）",
                },
            },
            "required": ["summary", "operations"],
        },
    },
}


def build_tools(skill: str) -> list[dict]:
    tools = [_RETRIEVE_TOOL, _READ_CARD_TOOL]
    if skill in ("talk", "emerge"):
        tools.append(_PROPOSE_WRITE_TOOL)
    return tools


# ---------- 流式轮 ----------

def parse_sse_chunk(line: str) -> dict | None:
    """解析单行 SSE 帧为 chunk JSON；非数据帧/[DONE] 返回 None。"""
    if not line.startswith("data:"):
        return None
    data = line[len("data:"):].strip()
    if not data or data == "[DONE]":
        return None
    return json.loads(data)


class ToolCallAssembler:
    """重组流式 delta.tool_calls：id/name/arguments 跨分片拼接。"""

    def __init__(self) -> None:
        self._slots: dict[int, dict] = {}

    def feed(self, tc: dict) -> None:
        idx = tc.get("index", 0)
        slot = self._slots.setdefault(idx, {"id": "", "name": "", "arguments": ""})
        if tc.get("id"):
            slot["id"] = tc["id"]
        fn = tc.get("function") or {}
        if fn.get("name"):
            slot["name"] += fn["name"]
        if fn.get("arguments"):
            slot["arguments"] += fn["arguments"]

    def finalize(self) -> list[dict]:
        return [s for _, s in sorted(self._slots.items())
                if s["id"] or s["name"]]


@dataclass
class RoundResult:
    text_parts: list[str] = field(default_factory=list)
    tool_calls: list[dict] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "".join(self.text_parts)


async def stream_round(settings: dict, messages: list[dict], tools: list[dict],
                       result: RoundResult) -> AsyncIterator[str]:
    """单轮 agent 调用（流式）：逐 delta yield 文本；tool_calls 重组进 result。"""
    url = settings["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings['api_key']}"}
    payload: dict = {"model": settings["model"], "messages": messages,
                     "stream": True}
    if tools:
        payload["tools"] = tools
    assembler = ToolCallAssembler()
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, json=payload,
                                 headers=headers) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                chunk = parse_sse_chunk(line)
                if not chunk:
                    continue
                delta = chunk["choices"][0].get("delta", {})
                content = delta.get("content")
                if content:
                    result.text_parts.append(content)
                    yield content
                for tc in delta.get("tool_calls") or []:
                    assembler.feed(tc)
    result.tool_calls = assembler.finalize()


def build_agent_messages(history: list[dict], message: str,
                         playbook: str | None, skill: str) -> list[dict]:
    """system（base + 剧本）+ 历史（剥离附加字段）+ 当前问题。"""
    system = AGENT_SYSTEM_PROMPT
    if playbook:
        system += f"\n\n---\n当前技能剧本（nexo-{skill}）：\n{playbook}"
    msgs: list[dict] = [{"role": "system", "content": system}]
    for m in history[-HISTORY_LIMIT:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            msgs.append({"role": m["role"], "content": m["content"]})
    msgs.append({"role": "user", "content": message})
    return msgs
```

- [ ] **Step 4: 跑测试确认通过**

```bash
python -m pytest tests/runtime/test_agent.py -v
```
预期：7 passed

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/agent.py tests/runtime/test_agent.py
git commit -m "feat(agent): 技能路由/剧本热加载/流式轮与 tool_calls 重组"
```

---

### Task 4: 工具实现 `runtime/agent_tools.py`

**Files:**
- Create: `nexogenesis/runtime/agent_tools.py`
- Test: `tests/runtime/test_agent_tools.py`

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/test_agent_tools.py`：

```python
import asyncio
import json

from nexogenesis.runtime.agent_tools import SourceTracker, execute_tool_call
from nexogenesis.runtime.chat import select_activation  # noqa: F401（确保可复用）

GRAPH = {
    "nodes": [{"id": n} for n in ("a", "b", "c")],
    "edges": [{"id": "e1", "from": "a", "to": "b"}],
}

HITS = [{"linked_cards": ["a"], "attribution": "user", "excerpt": "卡片 a 摘录"}]


class FakeBus:
    def __init__(self):
        self.events = []

    async def publish(self, type_, payload):
        self.events.append((type_, payload))


def _tc(name, args):
    return {"id": "call_1", "name": name, "arguments": json.dumps(args)}


def test_retrieve_publishes_real_events_talk(monkeypatch, tmp_path):
    monkeypatch.setattr("nexogenesis.runtime.agent_tools.rag_search",
                        lambda root, q, top=8: HITS)
    bus = FakeBus()
    tracker = SourceTracker(tmp_path, "conv-1")
    out, frames = asyncio.run(execute_tool_call(
        bus, tmp_path, GRAPH, "talk", _tc("retrieve", {"query": "金本位"}), tracker))
    result = json.loads(out)
    assert result["seeds"] == ["a"]
    assert result["excerpts"][0]["card_ids"] == ["a"]
    types = [t for t, _ in bus.events]
    assert types[0] == "retrieve.query"
    assert "graph.hit" in types
    assert frames == [{"type": "step", "kind": "retrieve", "label": "检索：金本位"}]
    assert tracker.cards()[0]["id"] == "a"


def test_retrieve_judge_emits_lens_begin(monkeypatch, tmp_path):
    monkeypatch.setattr("nexogenesis.runtime.agent_tools.rag_search",
                        lambda root, q, top=8: HITS)
    bus = FakeBus()
    tracker = SourceTracker(tmp_path, "conv-1")
    asyncio.run(execute_tool_call(
        bus, tmp_path, GRAPH, "judge",
        _tc("retrieve", {"query": "证据强度", "note": "透镜一"}), tracker))
    lens = [p for t, p in bus.events if t == "lens.begin"]
    assert lens and lens[0]["index"] == 1 and lens[0]["name"] == "透镜一"
    assert "a" in lens[0]["node_ids"]
    # judge 不发普通 graph.hit
    assert not [t for t, _ in bus.events if t == "graph.hit"]


def test_read_card_found_and_missing(tmp_path):
    cards = tmp_path / "01-Cards"
    cards.mkdir()
    cards.joinpath("a.md").write_text(
        "---\nid: a\ntitle: 卡片A\ntype: claim\nmaturity: seed\n"
        "lifecycle: active\ndomains: [d1]\norigin: user\nsources: []\nrelations: []\n"
        "created: '2026-08-10'\nupdated: '2026-08-10'\n---\n\n正文内容。\n",
        encoding="utf-8",
    )
    bus = FakeBus()
    tracker = SourceTracker(tmp_path, "conv-1")
    out, _ = asyncio.run(execute_tool_call(
        bus, tmp_path, GRAPH, "talk", _tc("read_card", {"card_id": "a"}), tracker))
    result = json.loads(out)
    assert result["title"] == "卡片A" and "正文内容" in result["body"]
    assert ("card.read", {"card_id": "a"}) in bus.events

    out2, _ = asyncio.run(execute_tool_call(
        bus, tmp_path, GRAPH, "talk", _tc("read_card", {"card_id": "ghost"}), tracker))
    assert "不存在" in json.loads(out2)["error"]


def test_propose_write_validation_error_feeds_back(tmp_path):
    cards = tmp_path / "01-Cards"
    cards.mkdir()
    bus = FakeBus()
    tracker = SourceTracker(tmp_path, "conv-1")
    out, frames = asyncio.run(execute_tool_call(
        bus, tmp_path, GRAPH, "emerge",
        _tc("propose_write", {"summary": "坏提案",
                              "operations": [{"id": "坏卡", "body": "[[幽灵]]"}]}),
        tracker))
    assert "校验失败" in out
    assert "幽灵链接" in out
    assert not any(f["type"] == "confirm_request" for f in frames)


def test_propose_write_success_emits_confirm_request(tmp_path):
    cards = tmp_path / "01-Cards"
    cards.mkdir()
    bus = FakeBus()
    tracker = SourceTracker(tmp_path, "conv-1")
    ops = [{"id": "新卡", "title": "新卡", "type": "claim", "maturity": "seed",
            "domains": ["d1"], "origin": "user", "sources": ["web"],
            "body": "正文。"}]
    out, frames = asyncio.run(execute_tool_call(
        bus, tmp_path, GRAPH, "emerge",
        _tc("propose_write", {"summary": "新建一张卡", "operations": ops}), tracker))
    assert json.loads(out)["status"] == "pending_confirm"
    cr = [f for f in frames if f["type"] == "confirm_request"]
    assert cr and cr[0]["summary"] == "新建一张卡"
    # 提案已落盘
    from nexogenesis.runtime.pending_writes import load_proposal
    assert load_proposal(tmp_path, cr[0]["proposal_id"]) is not None


def test_bad_arguments_json(tmp_path):
    bus = FakeBus()
    tracker = SourceTracker(tmp_path, "c")
    out, _ = asyncio.run(execute_tool_call(
        bus, tmp_path, GRAPH, "talk",
        {"id": "c1", "name": "retrieve", "arguments": "{bad json"}, tracker))
    assert "解析失败" in out
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_agent_tools.py -v
```
预期：FAIL，模块不存在

- [ ] **Step 3: 实现**

新建 `nexogenesis/runtime/agent_tools.py`：

```python
"""agent 工具实现：retrieve / read_card / propose_write。

每次工具调用实时映射为图谱事件——动画是真实工具调用的副产品。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from nexogenesis.commands.write import (
    _check_wikilinks_in_writes, _check_write_permissions,
)
from nexogenesis.operations import BatchOperation
from nexogenesis.rag.search import rag_search
from nexogenesis.runtime.chat import _edge_nodes, select_activation
from nexogenesis.runtime.pending_writes import save_proposal
from nexogenesis.store import Store

logger = logging.getLogger(__name__)

EXCERPT_CAP = 300
BODY_CAP = 4000
SOURCES_CAP = 12


class SourceTracker:
    """本轮 retrieve ∪ read_card 的卡片集合 + judge 透镜计数 + Store 缓存。"""

    def __init__(self, root: Path, conversation_id: str = "") -> None:
        self._root = root
        self.conversation_id = conversation_id
        self._ids: list[str] = []
        self._lens = 0
        self._store: Store | None = None

    @property
    def store(self) -> Store:
        if self._store is None:
            self._store = Store(self._root / "01-Cards").load()
        return self._store

    def add(self, cid: str) -> None:
        if cid and cid not in self._ids:
            self._ids.append(cid)

    def next_lens(self) -> int:
        self._lens += 1
        return self._lens

    def cards(self) -> list[dict]:
        out = []
        for cid in self._ids[:SOURCES_CAP]:
            card = self.store.cards.get(cid)
            out.append({"id": cid, "title": card.title if card else cid})
        return out


async def execute_tool_call(bus, root: Path, graph: dict, skill: str,
                            tc: dict, tracker: SourceTracker):
    """执行一个工具调用，返回 (工具结果文本, 帧列表)。"""
    name = tc["name"]
    try:
        args = json.loads(tc.get("arguments") or "{}")
    except json.JSONDecodeError:
        return (f"工具参数 JSON 解析失败：{(tc.get('arguments') or '')[:200]}",
                [{"type": "step", "kind": name, "label": "参数解析失败"}])
    if name == "retrieve":
        return await _tool_retrieve(bus, root, graph, skill, args, tracker)
    if name == "read_card":
        return await _tool_read_card(bus, root, args, tracker)
    if name == "propose_write":
        return await _tool_propose_write(bus, root, args, tracker)
    return f"未知工具：{name}", []


async def _tool_retrieve(bus, root, graph, skill, args, tracker):
    query = str(args.get("query") or "")
    note = str(args.get("note") or "")
    step = {"type": "step", "kind": "retrieve", "label": f"检索：{query}"}
    await bus.publish("retrieve.query", {"mode": skill, "query": query})
    hits = rag_search(root, query, top=8)
    act = select_activation(graph, hits)
    if act["seeds"]:
        if skill == "judge":
            await bus.publish("lens.begin", {
                "index": tracker.next_lens(),
                "name": note or query,
                "node_ids": sorted(set(act["seeds"]) | set(_edge_nodes(act["hop1"]))),
                "edge_ids": [e["id"] for e in act["hop1"]],
            })
        else:
            await bus.publish("graph.hit", {
                "node_ids": act["seeds"], "edge_ids": [], "role": "seed",
            })
            if act["hop1"]:
                await bus.publish("graph.hit", {
                    "node_ids": _edge_nodes(act["hop1"]),
                    "edge_ids": [e["id"] for e in act["hop1"]],
                    "role": "expand",
                })
    excerpts = []
    for ex in act["excerpts"]:
        for cid in ex["card_ids"]:
            tracker.add(cid)
        excerpts.append({
            "card_ids": ex["card_ids"],
            "attribution": ex["attribution"],
            "excerpt": ex["excerpt"][:EXCERPT_CAP],
        })
    result = {"seeds": act["seeds"], "excerpts": excerpts,
              "hop1_count": len(act["hop1"])}
    if not act["seeds"]:
        result["hint"] = "零命中：换关键词或换角度重试"
    return json.dumps(result, ensure_ascii=False), [step]


async def _tool_read_card(bus, root, args, tracker):
    cid = str(args.get("card_id") or "")
    step = {"type": "step", "kind": "read_card", "label": f"读卡：{cid}"}
    card = tracker.store.cards.get(cid)
    if card is None:
        return json.dumps({"error": f"卡片不存在: {cid}"},
                          ensure_ascii=False), [step]
    tracker.add(cid)
    await bus.publish("card.read", {"card_id": cid})
    result = {
        "id": card.id, "title": card.title, "type": card.type.value,
        "maturity": card.maturity.value, "domains": card.domains,
        "updated": card.updated, "body": card.body[:BODY_CAP],
    }
    return json.dumps(result, ensure_ascii=False), [step]


async def _tool_propose_write(bus, root, args, tracker):
    summary = str(args.get("summary") or "")
    operations = args.get("operations")
    step = {"type": "step", "kind": "propose_write",
            "label": f"提案：{summary[:30]}"}
    if not isinstance(operations, list) or not operations:
        return "operations 必须是非空数组（write --batch 的 writes 结构）", [step]
    batch = BatchOperation(
        operation_id="web-dryrun", source="web-agent",
        approved_by="user", writes=operations,
    )
    errors = _check_write_permissions(batch)
    errors += _check_wikilinks_in_writes(batch, set(tracker.store.cards))
    if errors:
        return ("校验失败，请修正后重新 propose_write：\n" + "\n".join(errors),
                [step])
    proposal = save_proposal(root, tracker.conversation_id, summary, operations)
    frames = [step, {
        "type": "confirm_request",
        "proposal_id": proposal["id"],
        "summary": summary,
        "operations": operations,
    }]
    return json.dumps({"status": "pending_confirm",
                       "proposal_id": proposal["id"]},
                      ensure_ascii=False), frames
```

- [ ] **Step 4: 跑测试确认通过**

```bash
python -m pytest tests/runtime/test_agent_tools.py -v
```
预期：6 passed

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/agent_tools.py tests/runtime/test_agent_tools.py
git commit -m "feat(agent): 三工具实现——事件=真实工具调用，propose_write 校验反馈循环"
```

---

### Task 5: agent 循环 `run_agent_stream`

**Files:**
- Modify: `nexogenesis/runtime/agent.py`
- Test: `tests/runtime/test_agent.py`

- [ ] **Step 1: 写失败测试**

`tests/runtime/test_agent.py` 顶部 import 追加 `asyncio`、`run_agent_stream`；新增 FakeBus 与脚本化假 LLM：

```python
class FakeBus:
    def __init__(self):
        self.events = []

    async def publish(self, type_, payload):
        self.events.append((type_, payload))


def scripted_rounds(script):
    """script: [(text_chunks, tool_calls), ...]，每个元素是一轮。"""
    rounds = iter(script)

    async def gen(settings, messages, tools, result):
        chunks, tcs = next(rounds)
        for c in chunks:
            yield c
        result.tool_calls.extend(tcs)
    return gen


def _collect_frames(gen):
    async def run():
        return [f async for f in gen]
    return asyncio.run(run())


def _tc(name, args):
    import json as _json
    return {"id": f"call_{name}", "name": name, "arguments": _json.dumps(args)}


def test_agent_talk_flow_events_and_sources(monkeypatch, tmp_path):
    from nexogenesis.runtime.agent import run_agent_stream
    monkeypatch.setattr("nexogenesis.runtime.agent_tools.rag_search",
                        lambda root, q, top=8: [
                            {"linked_cards": ["a"], "attribution": "u",
                             "excerpt": "摘录"}])
    (tmp_path / "01-Cards").mkdir()
    graph = {"nodes": [{"id": "a"}], "edges": []}
    bus = FakeBus()
    script = [
        ([], [_tc("retrieve", {"query": "金本位"})]),
        ([], [_tc("read_card", {"card_id": "a"})]),
        (["最终", "回答"], []),
    ]
    frames = _collect_frames(run_agent_stream(
        bus, tmp_path, graph, [], "谈谈金本位",
        settings={"base_url": "x", "model": "m", "api_key": "k"},
        llm_round=scripted_rounds(script), conversation_id="conv-1",
    ))
    types = [f["type"] for f in frames]
    assert types == ["step", "step", "delta", "delta", "sources"]
    deltas = "".join(f["text"] for f in frames if f["type"] == "delta")
    assert deltas == "最终回答"
    assert frames[-1]["cards"] == [{"id": "a", "title": "a"}]
    ev_types = [t for t, _ in bus.events]
    assert ev_types[0] == "skill.trigger"
    assert bus.events[0][1]["skill"] == "nexo-talk"
    assert "graph.hit" in ev_types and "card.read" in ev_types


def test_agent_emerge_confirm_request_frame(monkeypatch, tmp_path):
    from nexogenesis.runtime.agent import run_agent_stream
    (tmp_path / "01-Cards").mkdir()
    bus = FakeBus()
    ops = [{"id": "新卡", "title": "新卡", "type": "claim", "maturity": "seed",
            "domains": ["d"], "origin": "user", "sources": ["web"], "body": "x"}]
    script = [
        ([], [_tc("propose_write", {"summary": "新建一卡", "operations": ops})]),
        (["请确认"], []),
    ]
    frames = _collect_frames(run_agent_stream(
        bus, tmp_path, {"nodes": [], "edges": []}, [], "记一下这个想法",
        settings={"base_url": "x", "model": "m", "api_key": "k"},
        llm_round=scripted_rounds(script), conversation_id="conv-1",
    ))
    assert bus.events[0][1]["skill"] == "nexo-emerge"
    cr = [f for f in frames if f["type"] == "confirm_request"]
    assert cr and cr[0]["summary"] == "新建一卡"


def test_agent_round_cap_forces_final(monkeypatch, tmp_path):
    from nexogenesis.runtime.agent import run_agent_stream
    (tmp_path / "01-Cards").mkdir()
    bus = FakeBus()
    # 6 轮都返回 tool_calls，第 7 次（强制无工具）给文本
    script = [([], [_tc("read_card", {"card_id": "x"})])] * 6 + [(["收尾"], [])]
    frames = _collect_frames(run_agent_stream(
        bus, tmp_path, {"nodes": [], "edges": []}, [], "问题",
        settings={"base_url": "x", "model": "m", "api_key": "k"},
        llm_round=scripted_rounds(script), conversation_id="c",
    ))
    deltas = "".join(f["text"] for f in frames if f["type"] == "delta")
    assert deltas == "收尾"
```

注意：`read_card` 对不存在的 `x` 会返回错误文本作为工具结果——循环照常推进，正好覆盖「工具错误不中断」。

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_agent.py -k "agent_talk_flow or agent_emerge or round_cap" -v
```
预期：FAIL，`ImportError: cannot import name 'run_agent_stream'`

- [ ] **Step 3: 实现**

`nexogenesis/runtime/agent.py`：import 区追加

```python
from nexogenesis.runtime.agent_tools import SourceTracker, execute_tool_call
```

文件末尾追加：

```python
async def run_agent_stream(
    bus,
    root: Path,
    graph: dict,
    history: list[dict],
    message: str,
    *,
    settings: dict,
    conversation_id: str = "",
    llm_round: Callable = stream_round,
    route: Callable[[str], str] = route_skill,
) -> AsyncIterator[dict]:
    """agent 循环：≤MAX_ROUNDS 轮工具调用，最终轮流式文本。逐帧 yield dict。

    帧类型：delta / step / sources / confirm_request（由工具产生）。
    """
    skill = route(message)
    playbook = load_playbook(root, skill)
    await bus.publish("skill.trigger", {"skill": f"nexo-{skill}"})
    tools = build_tools(skill)
    messages = build_agent_messages(history, message, playbook, skill)
    tracker = SourceTracker(root, conversation_id)
    rounds = 0
    while rounds < MAX_ROUNDS:
        rounds += 1
        result = RoundResult()
        async for text in llm_round(settings, messages, tools, result):
            yield {"type": "delta", "text": text}
        if not result.tool_calls:
            break
        messages.append({
            "role": "assistant",
            "content": result.text,
            "tool_calls": [
                {"id": tc["id"], "type": "function",
                 "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                for tc in result.tool_calls
            ],
        })
        for tc in result.tool_calls:
            output, frames = await execute_tool_call(
                bus, root, graph, skill, tc, tracker)
            for fr in frames:
                yield fr
            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "content": output})
    else:
        # 达轮次上限：强制无工具终答
        result = RoundResult()
        async for text in llm_round(settings, messages, [], result):
            yield {"type": "delta", "text": text}
    yield {"type": "sources", "cards": tracker.cards()}
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

```bash
python -m pytest tests/runtime/ -v
```
预期：全部 passed

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/agent.py tests/runtime/test_agent.py
git commit -m "feat(agent): run_agent_stream 循环——≤6 轮工具调用 + 强制终答 + sources 帧"
```

---

### Task 6: 端点接线（/api/chat/stream 换 loop + /api/write/confirm）

**Files:**
- Modify: `nexogenesis/runtime/api.py`
- Test: `tests/runtime/test_chat_api.py`

- [ ] **Step 1: 写失败测试**

`tests/runtime/test_chat_api.py` 追加：

```python
def _agent_client_with_conv(kb_root, monkeypatch, script):
    """agent 端点夹具：patch 剧本化 LLM 轮 + 空检索，返回 (client, conv)。"""
    from nexogenesis.runtime.agent import RoundResult
    rounds = iter(script)

    async def fake_round(settings, messages, tools, result: RoundResult):
        chunks, tcs = next(rounds)
        for c in chunks:
            yield c
        result.tool_calls.extend(tcs)

    monkeypatch.setattr("nexogenesis.runtime.agent.stream_round", fake_round)
    monkeypatch.setattr("nexogenesis.runtime.agent_tools.rag_search",
                        lambda root, q, top=8: [])
    monkeypatch.setattr("nexogenesis.runtime.chat.index_rag",
                        lambda root, incremental=True: {})
    proj = ensure_default_project(kb_root)
    conv = create_conversation(kb_root, proj["id"])
    return TestClient(create_app(kb_root)), conv


def test_chat_stream_agent_talk(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    refreshed = []
    monkeypatch.setattr("nexogenesis.runtime.chat.index_rag",
                        lambda root, incremental=True: refreshed.append(True) or {})
    client, conv = _agent_client_with_conv(kb_root, monkeypatch,
                                           script=[(["你", "好"], [])])
    with client.stream("POST", "/api/chat/stream",
                       json={"conversation_id": conv["id"], "message": "hi"}) as r:
        frames = _read_sse_frames(r)
    assert [f["type"] for f in frames] == ["delta", "delta", "sources", "done"]
    assert refreshed == [True]  # agent loop 启动前触发了索引保鲜
    saved = get_conversation(kb_root, conv["id"])
    assert [m["role"] for m in saved["messages"]] == ["user", "assistant"]
    assert saved["messages"][1]["content"] == "你好"


def test_chat_stream_agent_emerge_and_confirm(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    ops = [{"id": "web新卡", "title": "web新卡", "type": "claim",
            "maturity": "seed", "domains": ["domain-alpha"],
            "origin": "user", "sources": ["web"], "body": "正文。"}]
    script = [
        ([], [{"id": "c1", "name": "propose_write",
               "arguments": json.dumps({"summary": "新建 web新卡",
                                        "operations": ops})}]),
        (["请确认"], []),
    ]
    client, conv = _agent_client_with_conv(kb_root, monkeypatch, script)
    with client.stream("POST", "/api/chat/stream",
                       json={"conversation_id": conv["id"],
                             "message": "记一下这个"} ) as r:
        frames = _read_sse_frames(r)
    cr = [f for f in frames if f["type"] == "confirm_request"]
    assert cr, "应有 confirm_request 帧"
    pid = cr[0]["proposal_id"]
    assert not (kb_root / "01-Cards" / "web新卡.md").exists()

    r = client.post("/api/write/confirm",
                    json={"proposal_id": pid, "decision": "confirm"})
    assert r.status_code == 200 and r.json()["applied"] is True
    assert (kb_root / "01-Cards" / "web新卡.md").exists()
    saved = get_conversation(kb_root, conv["id"])
    assert saved["messages"][-1]["role"] == "system"
    assert "已写入" in saved["messages"][-1]["content"]

    # 重复确认 → 409
    r2 = client.post("/api/write/confirm",
                     json={"proposal_id": pid, "decision": "confirm"})
    assert r2.status_code == 409


def test_write_confirm_cancel_and_404(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    from nexogenesis.runtime.pending_writes import save_proposal
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    client, conv = _agent_client_with_conv(kb_root, monkeypatch, script=[])
    p = save_proposal(kb_root, conv["id"], "提案", [{"id": "x"}])
    r = client.post("/api/write/confirm",
                    json={"proposal_id": p["id"], "decision": "cancel"})
    assert r.status_code == 200 and r.json()["applied"] is False
    r404 = client.post("/api/write/confirm",
                       json={"proposal_id": "pw-000000000000", "decision": "confirm"})
    assert r404.status_code == 404
```

- [ ] **Step 2: 跑测试确认失败**

```bash
python -m pytest tests/runtime/test_chat_api.py -k "agent or write_confirm" -v
```
预期：FAIL（confirm 路由 404；agent 帧序列不符）

- [ ] **Step 3: 实现**

`nexogenesis/runtime/api.py`：

① import 区追加：

```python
from nexogenesis.commands.write import execute_batch
from nexogenesis.operations import BatchOperation
from nexogenesis.runtime import agent as agent_module
from nexogenesis.runtime.pending_writes import (
    load_proposal, mark_proposal,
)
```

② `_chat_router` 的 `chat_stream` 中 `gen()` 改为消费 agent 帧（整段替换 `gen` 与其前的 `frame` 定义之间的逻辑；保留校验与 frame 助手）：

```python
        async def gen():
            parts: list[str] = []
            sources: list[dict] = []
            failure: str | None = None
            # 索引保鲜：agent loop 启动前增量刷新 RAG（防检索静默退化；patch 点 nexogenesis.runtime.chat.index_rag 保持不变）
            try:
                await asyncio.to_thread(chat_module.index_rag, root,
                                        incremental=True)
            except Exception:
                logger.warning("RAG 增量索引刷新失败，沿用现有索引",
                               exc_info=True)
            try:
                async for fr in agent_module.run_agent_stream(
                    bus, root, graph_fn(), conv["messages"], body.message,
                    settings=settings,
                    conversation_id=body.conversation_id,
                    llm_round=agent_module.stream_round,  # 调用时解析，便于测试 monkeypatch
                ):
                    if fr["type"] == "delta":
                        parts.append(fr["text"])
                    elif fr["type"] == "sources":
                        sources = fr["cards"]
                    yield frame(fr)
            except (httpx.HTTPError, KeyError, IndexError, ValueError):
                logger.exception("LLM 流式调用失败")
                failure = "LLM 调用失败，请检查网络与 API Key 配置"
            except asyncio.CancelledError:
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
                assistant: dict = {"role": "assistant", "content": answer}
                if sources:
                    assistant["sources"] = sources
                msgs.append(assistant)
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
```

③ `_chat_router` 内追加确认端点（`return router` 之前）：

```python
    class WriteConfirmIn(BaseModel):
        proposal_id: str
        decision: str

    @router.post("/api/write/confirm")
    async def write_confirm(body: WriteConfirmIn) -> dict:
        proposal = load_proposal(root, body.proposal_id)
        if proposal is None:
            raise HTTPException(status_code=404, detail="提案不存在")
        if proposal["status"] != "pending":
            raise HTTPException(status_code=409, detail="提案已处理")
        if body.decision == "cancel":
            mark_proposal(root, body.proposal_id, "cancelled")
            append_messages(root, proposal["conversation_id"], [
                {"role": "system",
                 "content": f"（已取消写入提案：{proposal['summary'][:40]}）"},
            ])
            return {"applied": False, "detail": "已取消"}
        if body.decision != "confirm":
            raise HTTPException(status_code=400,
                                detail="decision 须为 confirm 或 cancel")
        batch = BatchOperation(
            operation_id=proposal["operation_id"], source="web-agent",
            approved_by="user", writes=proposal["operations"],
        )
        try:
            result = execute_batch(root, batch)
        except RuntimeError as exc:
            mark_proposal(root, body.proposal_id, "failed")
            append_messages(root, proposal["conversation_id"], [
                {"role": "system", "content": f"（写入失败：{exc}）"},
            ])
            return {"applied": False, "detail": str(exc)}
        mark_proposal(root, body.proposal_id, "confirmed")
        await bus.publish("write.applied", {
            "created": result["created"], "enriched": result["enriched"],
        })
        append_messages(root, proposal["conversation_id"], [
            {"role": "system",
             "content": f"（已写入：新建 {len(result['created'])} 卡，"
                        f"丰富 {len(result['enriched'])} 卡）"},
        ])
        return {"applied": True, "created": result["created"],
                "enriched": result["enriched"]}
```

④ 清理：`chat_module` 的 import 若不再被 `/api/chat`（非流式）以外使用则保留——`run_chat` 与 `call_deepseek` 仍被旧端点使用，不要删。旧用例 `test_chat_stream_success` / `test_chat_stream_llm_failure_no_partial` / `test_chat_stream_llm_failure_partial_persisted` 与 `_stream_client_with_conv`（其测试对象 run_chat_stream 路径已被替换）**删除**；`test_chat_stream_requires_key` / `test_chat_stream_unknown_conversation` 保留但夹具换成 `_agent_client_with_conv`（script=[(["x"], [])]）。

⑤ 备注：`execute_batch` 内部跑 `run_validate(root, cards_dir_override=...)`；若 `kb_root` fixture 因目录不全（如缺 `05-Buffer`）导致 validate 报错，在 `test_chat_stream_agent_emerge_and_confirm` 开头补建目录：`(kb_root / "05-Buffer").mkdir(exist_ok=True)`（按实际报错补齐，勿预先乱建）。

- [ ] **Step 4: 跑测试确认通过 + 全量后端回归**

```bash
python -m pytest tests/runtime/test_chat_api.py -v
python -m pytest
```
预期：全部 passed

- [ ] **Step 5: Commit**

```bash
git add nexogenesis/runtime/api.py tests/runtime/test_chat_api.py
git commit -m "feat(api): /api/chat/stream 接入 agent loop + /api/write/confirm 确认端点"
```

---

### Task 7: 前端帧协议扩展 + confirmWrite

**Files:**
- Modify: `web/src/api/client.ts`
- Test: `web/src/api/client.test.ts`

- [ ] **Step 1: 写失败测试**

`web/src/api/client.test.ts`：import 区把 `confirmWrite` 加入 `./client` 导入。`describe("sendChatStream")` 内追加：

```ts
  it("dispatches step/sources/confirm_request frames", async () => {
    mockStreamFetch([
      'data: {"type":"step","kind":"retrieve","label":"检索：金本位"}\n\n',
      'data: {"type":"sources","cards":[{"id":"a","title":"卡片A"}]}\n\n',
      'data: {"type":"confirm_request","proposal_id":"pw-1","summary":"新建一卡","operations":[{"id":"x"}]}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    const steps: string[] = [];
    let sources: { id: string; title: string }[] = [];
    let proposal = "";
    await sendChatStream("c1", "hi", {
      onDelta: noop,
      onDone: noop,
      onError: noop,
      onStep: (kind, label) => steps.push(`${kind}:${label}`),
      onSources: (cards) => { sources = cards; },
      onConfirmRequest: (p) => { proposal = p.proposal_id; },
    });
    expect(steps).toEqual(["retrieve:检索：金本位"]);
    expect(sources).toEqual([{ id: "a", title: "卡片A" }]);
    expect(proposal).toBe("pw-1");
  });
```

`describe` 外追加：

```ts
describe("confirmWrite", () => {
  it("POSTs decision and returns result", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/write/confirm");
      expect(JSON.parse(String(init?.body))).toEqual({
        proposal_id: "pw-1", decision: "confirm",
      });
      return { ok: true, body: { applied: true, created: ["新卡"], enriched: [] } };
    });
    const r = await confirmWrite("pw-1", "confirm");
    expect(r.applied).toBe(true);
    expect(r.created).toEqual(["新卡"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npx vitest run src/api/client.test.ts
```
预期：FAIL（confirmWrite 不存在；新帧未分发）

- [ ] **Step 3: 实现**

`web/src/api/client.ts`：

① `ChatStreamHandlers` 扩展为：

```ts
export interface SourceCard {
  id: string;
  title: string;
}

export interface ConfirmRequestPayload {
  proposal_id: string;
  summary: string;
  operations: unknown[];
}

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (detail: string) => void;
  onStep?: (kind: string, label: string) => void;
  onSources?: (cards: SourceCard[]) => void;
  onConfirmRequest?: (p: ConfirmRequestPayload) => void;
}
```

② `sendChatStream` 帧分发处改为：

```ts
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === "delta") h.onDelta(ev.text);
      else if (ev.type === "done") h.onDone();
      else if (ev.type === "error") h.onError(ev.detail);
      else if (ev.type === "step") h.onStep?.(ev.kind, ev.label);
      else if (ev.type === "sources") h.onSources?.(ev.cards);
      else if (ev.type === "confirm_request") h.onConfirmRequest?.(ev);
```

③ `ChatMessage` 接口扩展（会话落盘的 sources 字段）：

```ts
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts?: string;
  sources?: SourceCard[];
}
```

④ 文件末尾追加：

```ts
// ---------- 写卡确认 ----------

export interface WriteConfirmResult {
  applied: boolean;
  detail?: string;
  created?: string[];
  enriched?: string[];
}

export async function confirmWrite(
  proposalId: string,
  decision: "confirm" | "cancel"
): Promise<WriteConfirmResult> {
  return jsonOrThrow(await fetch("/api/write/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proposal_id: proposalId, decision }),
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd web && npx vitest run
```
预期：全部 passed

- [ ] **Step 5: Commit**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts
git commit -m "feat(web): 帧协议扩展（step/sources/confirm_request）+ confirmWrite API"
```

---

### Task 8: 前端渲染（steps 活动线 / sources 芯片 / 确认卡）+ App 接线

**Files:**
- Create: `web/src/components/ConfirmCard.tsx`
- Modify: `web/src/components/ChatPanel.tsx`
- Modify: `web/src/App.tsx`
- Test: `web/src/components/ChatPanel.test.tsx`

- [ ] **Step 1: 写失败测试**

`web/src/components/ChatPanel.test.tsx` 追加：

```tsx
describe("ChatPanel agent 元素", () => {
  it("renders sources chips for assistant message", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false} onSend={() => undefined}
        messages={[{
          role: "assistant", content: "回答",
          sources: [{ id: "card-a", title: "卡片A" }],
        }]} />
    );
    expect(html).toContain("卡片A");
    expect(html).toContain("来源");
  });

  it("renders confirm card with buttons", () => {
    const html = renderToString(
      <ChatPanel title="t" sending={false} onSend={() => undefined}
        messages={[]}
        pendingConfirm={{
          proposal_id: "pw-1", summary: "新建一张卡",
          operations: [{ id: "新卡", title: "新卡" }], status: "pending",
        }}
        onConfirmAction={() => undefined} />
    );
    expect(html).toContain("新建一张卡");
    expect(html).toContain("确认写入");
    expect(html).toContain("取消");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npx vitest run src/components/ChatPanel.test.tsx
```
预期：FAIL（props 不存在）

- [ ] **Step 3: 实现**

① 新建 `web/src/components/ConfirmCard.tsx`：

```tsx
export interface PendingConfirm {
  proposal_id: string;
  summary: string;
  operations: { id?: string; title?: string }[];
  status: "pending" | "confirmed" | "cancelled" | "failed";
}

interface Props {
  confirm: PendingConfirm;
  onAction: (proposalId: string, decision: "confirm" | "cancel") => void;
}

export function ConfirmCard({ confirm, onAction }: Props) {
  const statusText = {
    confirmed: "已写入",
    cancelled: "已取消",
    failed: "写入失败",
  }[confirm.status as "confirmed" | "cancelled" | "failed"];

  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-3">
      <div className="text-[12px] font-medium text-amber-200">写入提案</div>
      <div className="mt-1 text-[12px] leading-5 text-zinc-300">
        {confirm.summary}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-[11px] text-zinc-500">
        {confirm.operations.map((op, i) => (
          <li key={i}>· {op.title ?? op.id ?? "（未命名操作）"}</li>
        ))}
      </ul>
      {confirm.status === "pending" ? (
        <div className="mt-2.5 flex gap-2">
          <button
            className="rounded-lg bg-teal-400/20 px-3 py-1 text-[12px] text-teal-200 transition hover:bg-teal-400/30"
            onClick={() => onAction(confirm.proposal_id, "confirm")}
          >
            确认写入
          </button>
          <button
            className="rounded-lg border border-white/[0.08] px-3 py-1 text-[12px] text-zinc-400 transition hover:text-zinc-200"
            onClick={() => onAction(confirm.proposal_id, "cancel")}
          >
            取消
          </button>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-zinc-500">{statusText}</div>
      )}
    </div>
  );
}
```

② `web/src/components/ChatPanel.tsx`：

import 区追加：

```tsx
import type { SourceCard } from "../api/client";
import { ConfirmCard, type PendingConfirm } from "./ConfirmCard";
```

Props 接口改为：

```tsx
interface Props {
  title: string | null;
  messages: ChatMessage[];
  sending: boolean;
  onSend: (text: string) => void;
  steps?: { kind: string; label: string }[];
  pendingConfirm?: PendingConfirm | null;
  onConfirmAction?: (proposalId: string, decision: "confirm" | "cancel") => void;
  onOpenCard?: (id: string) => void;
}
```

组件签名改为 `export function ChatPanel({ title, messages, sending, onSend, steps = [], pendingConfirm, onConfirmAction, onOpenCard }: Props) {`。

assistant 消息渲染块内、`ReactMarkdown` 之后追加 sources 芯片（`md-body` div 同级包裹改为 fragment）：

```tsx
          ) : m.role === "assistant" ? (
            <div key={i}>
              <div className="md-body px-1 text-[13px] leading-6 text-zinc-200">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
              {m.sources && m.sources.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1">
                  <span className="text-[11px] text-zinc-600">来源</span>
                  {m.sources.map((c: SourceCard) => (
                    <button
                      key={c.id}
                      className="rounded-full border border-teal-400/25 px-2 py-0.5 text-[11px] text-teal-300/80 transition hover:border-teal-400/50 hover:text-teal-200"
                      onClick={() => onOpenCard?.(c.id)}
                    >
                      {c.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
```

消息列表末尾（`{sending && (...)}` 之前）追加 steps 活动线与确认卡：

```tsx
        {steps.length > 0 && sending && (
          <div className="space-y-0.5 px-1">
            {steps.map((s, i) => (
              <div key={i} className="text-[11px] text-zinc-600">
                ▸ {s.label}
              </div>
            ))}
          </div>
        )}
        {pendingConfirm && onConfirmAction && (
          <ConfirmCard confirm={pendingConfirm} onAction={onConfirmAction} />
        )}
```

③ `web/src/App.tsx`：

import 区追加：

```tsx
import { confirmWrite } from "./api/client";
import type { PendingConfirm } from "./components/ConfirmCard";
```

state 追加（`const [sending, setSending] = useState(false);` 之后）：

```tsx
  const [steps, setSteps] = useState<{ kind: string; label: string }[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
```

`send` 内：`setSending(true);` 之后加 `setSteps([]); setPendingConfirm(null);`；`sendChatStream` 的 handlers 扩展为：

```tsx
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
        onStep: (kind, label) => setSteps((s) => [...s, { kind, label }]),
        onSources: (cards) =>
          setLocalMsgs((list) => {
            const next = [...list];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, sources: cards };
            }
            return next;
          }),
        onConfirmRequest: (p) =>
          setPendingConfirm({
            proposal_id: p.proposal_id,
            summary: p.summary,
            operations: p.operations as { id?: string; title?: string }[],
            status: "pending",
          }),
        onDone: () => undefined,
        onError: () => undefined,
      });
      setSteps([]);
```

注意 `setSteps([])` 放在 `await sendChatStream` 之后、`await alignFromServer()` 之前（活动线在回答完成后清掉）。

确认动作处理器（`send` 之后追加）：

```tsx
  const confirmAction = useCallback(
    async (proposalId: string, decision: "confirm" | "cancel") => {
      try {
        const r = await confirmWrite(proposalId, decision);
        setPendingConfirm((pc) =>
          pc && pc.proposal_id === proposalId
            ? { ...pc, status: decision === "confirm"
                ? (r.applied ? "confirmed" : "failed")
                : "cancelled" }
            : pc
        );
        if (decision === "confirm" && r.applied) {
          // 新卡入图 + 会话对齐（system 落盘消息）
          fetchGraph().then(setData).catch(() => { /* 保持旧图 */ });
          if (convIdRef.current) {
            const fresh = await fetchConversation(convIdRef.current);
            if (convIdRef.current === fresh.id) setConv(fresh);
          }
        }
      } catch (e) {
        pushLocal({ role: "system", content: `确认操作失败：${e}` });
      }
    },
    [pushLocal]
  );
```

`ChatPanel` JSX 改为：

```tsx
        <ChatPanel
          title={conv?.title ?? null}
          messages={messages}
          sending={sending}
          onSend={send}
          steps={steps}
          pendingConfirm={pendingConfirm}
          onConfirmAction={confirmAction}
          onOpenCard={setCardId}
        />
```

`selectConversation` 与 `newConversation` 内 `setLocalMsgs([])` 之后各加一行 `setPendingConfirm(null);`（切换会话时清掉旧确认卡）。

④ `ChatMessage` 的本地扩展：`App.tsx` 中 steps/sources 经由 localMsgs 与组件 props 传递，类型已由 Task 7 的 `ChatMessage.sources` 覆盖，无需新类型。

- [ ] **Step 4: 类型检查 + 测试 + 构建**

```bash
cd web && npx tsc -b && npx vitest run && npm run build
```
预期：无类型错误；测试全 passed；构建成功

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ConfirmCard.tsx web/src/components/ChatPanel.tsx web/src/components/ChatPanel.test.tsx web/src/App.tsx
git commit -m "feat(web): 活动线/sources 芯片/写入确认卡 + App 接线"
```

---

### Task 9: 全量回归 + 实践仓同步 + live 走查

**Files:** 无新增（验证与部署）

- [ ] **Step 1: 开发仓全量回归**

```bash
cd "D:/UESR/Desktop/Nexogenesis智构涌现/Nexogenesis-org"
export PATH="/c/Users/MECHREVO/AppData/Local/Programs/Python/Python313:$PATH"
python -m pytest
cd web && npx vitest run && npm run build
```
预期：后端、前端全 passed；构建成功

- [ ] **Step 2: 实践仓同步 + 构建**

```bash
cd "D:/UESR/Desktop/Nexogenesis智构涌现/NexogenesisV1.6org 金融2"
git fetch dev && git merge dev/main
cd web && npm install && npm run build
```

- [ ] **Step 3: 重启实践仓服务**

停掉后台 serve 任务，重新启动：

```bash
cd "D:/UESR/Desktop/Nexogenesis智构涌现/NexogenesisV1.6org 金融2"
./.venv/Scripts/python.exe -m nexogenesis serve --root . --host 127.0.0.1 --port 8787
```

- [ ] **Step 4: live 走查清单（用户在浏览器验证）**

1. **talk**：发「金本位确立后为什么金币流通反而成为例外」——活动线出现「检索：…」，图谱点亮真实命中卡，回答下方出现可点击的来源芯片
2. **emerge**：发「记一下：金银复本位在 1870 年代的失败其实是国际协调失败」——出现写入提案确认卡；点「确认写入」后图谱 `write.applied` 点亮、新卡入图、会话落盘「已写入」
3. **judge**：发「深判金银本位之争」——图谱出现透镜序列（透镜一/二/三），回答按透镜组织
