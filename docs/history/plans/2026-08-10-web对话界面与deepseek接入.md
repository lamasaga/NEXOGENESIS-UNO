# Web 对话界面改版与 DeepSeek 接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Web 前端改版为 Codex 风格三栏（侧边栏 + 中央图谱 + 全高对话窗），对话经 FastAPI 代理接入 DeepSeek，检索召回与多跳扩散实时驱动图谱神经元闪烁，会话持久化到 `07-Conversations/`。

**Architecture:** 后端新增 settings/conversations/chat/inbox 四个模块与对应 API router，挂载进现有 `create_app`；聊天编排复用 `rag_search` + 图谱边扩散 + 现有 SSE 事件协议（带起搏间隔）。前端新增 Sidebar/SettingsModal，重写 ChatPanel 为真实多会话对话，App 改三栏布局并移除 header 与 EventLog 挂载。

**Tech Stack:** Python 3.13 / FastAPI / httpx / pytest；React 18 + Vite + TypeScript + Tailwind / vitest。

**上游 spec:** `docs/specs/2026-08-10-web对话界面与deepseek接入-design.md`

**环境约定（重要）：**
- Python 解释器用 `C:\Users\MECHREVO\AppData\Local\Programs\Python\Python313\python.exe`（Git Bash 中 `python` 会解析到 Windows Store 占位符）。下文命令统一写作 `"$PY" -m pytest ...`，执行前先 `PY="/c/Users/MECHREVO/AppData/Local/Programs/Python/Python313/python.exe"`。
- fastapi / uvicorn / httpx / python-multipart / pydantic 已确认安装；`requirements.txt` 只补声明。
- 每个 Task 末尾的 commit 步骤需用户确认后执行（项目纪律：不擅自 git commit）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `nexogenesis/runtime/settings.py` | LLM 设置读写、key 掩码、系统用户名 | 新建 |
| `nexogenesis/runtime/conversations.py` | `07-Conversations/` 项目/会话 JSON 存取（原子写） | 新建 |
| `nexogenesis/runtime/chat.py` | 对话编排：检索→起搏事件→DeepSeek→回答 | 新建 |
| `nexogenesis/runtime/simulate.py` | `_edges_touching` 提升为公共 `edges_touching` | 修改 |
| `nexogenesis/runtime/api.py` | 挂载 settings/conversations/chat/inbox 四个 router | 修改 |
| `requirements.txt` | 补 fastapi/uvicorn/httpx/python-multipart 声明 | 修改 |
| `.gitignore` | 加 `07-Conversations/`、`.nexogenesis/web-settings.json` | 修改 |
| `tests/runtime/test_settings_api.py` | settings 模块 + API 测试 | 新建 |
| `tests/runtime/test_conversations.py` | 会话存储 + API 测试 | 新建 |
| `tests/runtime/test_chat_api.py` | 编排 + chat/inbox API 测试 | 新建 |
| `web/src/api/client.ts` | 新增 conversations/projects/settings/chat/inbox API | 修改 |
| `web/src/api/client.test.ts` | client 请求形状 vitest | 新建 |
| `web/src/components/Sidebar.tsx` | 侧边栏（按钮/能力占位/项目对话树/用户+设置） | 新建 |
| `web/src/components/SettingsModal.tsx` | LLM 配置弹窗 | 新建 |
| `web/src/components/ChatPanel.tsx` | 重写为真实对话面板（受控组件） | 重写 |
| `web/src/App.tsx` | 三栏布局，状态提升，移除 header/EventLog | 修改 |

---

## Task 1: settings 模块

**Files:**
- Create: `nexogenesis/runtime/settings.py`
- Test: `tests/runtime/test_settings_api.py`

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/test_settings_api.py`：

```python
from nexogenesis.runtime.settings import (
    DEFAULT_BASE_URL, DEFAULT_MODEL,
    load_settings, mask_key, public_settings, save_settings,
)


def test_defaults_when_missing(tmp_path):
    s = load_settings(tmp_path)
    assert s == {"base_url": DEFAULT_BASE_URL, "model": DEFAULT_MODEL, "api_key": ""}


def test_save_and_load_roundtrip(tmp_path):
    save_settings(tmp_path, base_url="https://api.deepseek.com",
                  model="deepseek-chat", api_key="sk-abcdef123456")
    s = load_settings(tmp_path)
    assert s["api_key"] == "sk-abcdef123456"


def test_empty_key_keeps_existing(tmp_path):
    save_settings(tmp_path, base_url="https://x", model="m", api_key="sk-old12345")
    save_settings(tmp_path, base_url="https://y", model="n", api_key="")
    s = load_settings(tmp_path)
    assert s["api_key"] == "sk-old12345"
    assert s["base_url"] == "https://y"


def test_corrupt_file_falls_back(tmp_path):
    p = tmp_path / ".nexogenesis" / "web-settings.json"
    p.parent.mkdir(parents=True)
    p.write_text("{not json", encoding="utf-8")
    assert load_settings(tmp_path)["base_url"] == DEFAULT_BASE_URL


def test_mask_key():
    assert mask_key("") == ""
    assert mask_key("sk-abcdef123456") == "sk-···3456"
    assert mask_key("ab") == "····"


def test_public_settings_masks(tmp_path):
    save_settings(tmp_path, base_url="https://x", model="m", api_key="sk-abcdef123456")
    pub = public_settings(tmp_path)
    assert pub["api_key_masked"] == "sk-···3456"
    assert pub["has_key"] is True
    assert "sk-abcdef123456" not in str(pub)
    assert isinstance(pub["username"], str) and pub["username"]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
PY="/c/Users/MECHREVO/AppData/Local/Programs/Python/Python313/python.exe"
"$PY" -m pytest tests/runtime/test_settings_api.py -v
```
预期：FAIL（`ModuleNotFoundError: nexogenesis.runtime.settings`）

- [ ] **Step 3: 实现 settings.py**

新建 `nexogenesis/runtime/settings.py`：

```python
from __future__ import annotations

import getpass
import json
from pathlib import Path

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"


def _settings_path(root: Path) -> Path:
    return root / ".nexogenesis" / "web-settings.json"


def load_settings(root: Path) -> dict:
    """读取 LLM 设置；文件不存在或损坏时回落默认值。"""
    settings = {"base_url": DEFAULT_BASE_URL, "model": DEFAULT_MODEL, "api_key": ""}
    path = _settings_path(root)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key in settings:
                    if isinstance(data.get(key), str):
                        settings[key] = data[key]
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            pass
    return settings


def save_settings(root: Path, *, base_url: str, model: str,
                  api_key: str | None = None) -> dict:
    """保存设置（原子写）；api_key 为 None 或空白串时保留已有 key。

    返回值含原始 api_key，勿直接序列化给前端（前端用 public_settings）。"""
    root = root.resolve()
    current = load_settings(root)
    current["base_url"] = base_url.strip() or DEFAULT_BASE_URL
    current["model"] = model.strip() or DEFAULT_MODEL
    stripped = (api_key or "").strip()
    if stripped:
        current["api_key"] = stripped
    path = _settings_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return current


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 7:
        return "····"
    return f"{key[:3]}···{key[-4:]}"


def public_settings(root: Path) -> dict:
    """面向前端的设置视图：key 打码，附带系统用户名。"""
    s = load_settings(root)
    return {
        "base_url": s["base_url"],
        "model": s["model"],
        "api_key_masked": mask_key(s["api_key"]),
        "has_key": bool(s["api_key"]),
        "username": getpass.getuser(),
    }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
"$PY" -m pytest tests/runtime/test_settings_api.py -v
```
预期：6 passed

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add nexogenesis/runtime/settings.py tests/runtime/test_settings_api.py
git commit -m "feat(runtime): LLM 设置读写模块（key 掩码 + 原子写）"
```

---

## Task 2: settings API

**Files:**
- Modify: `nexogenesis/runtime/api.py`
- Test: `tests/runtime/test_settings_api.py`

- [ ] **Step 1: 追加失败测试**

在 `tests/runtime/test_settings_api.py` 末尾追加：

```python
from fastapi.testclient import TestClient

from nexogenesis.runtime.api import create_app


def test_settings_api_get_put(tmp_path):
    client = TestClient(create_app(tmp_path))
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["base_url"] == "https://api.deepseek.com"
    assert body["model"] == "deepseek-chat"
    assert body["has_key"] is False

    r = client.put("/api/settings", json={
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-reasoner",
        "api_key": "sk-testkey00001",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["model"] == "deepseek-reasoner"
    assert body["api_key_masked"] == "sk-···0001"
    assert "sk-testkey00001" not in r.text

    # 空 key 不覆盖
    r = client.put("/api/settings", json={
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-chat",
        "api_key": "",
    })
    assert r.json()["api_key_masked"] == "sk-···0001"
```

注意：`create_app(tmp_path)` 的 root 不含 `01-Cards`，现有 `/api/graph` 不受影响（本测试不调用它）。

- [ ] **Step 2: 跑测试确认失败**

```bash
"$PY" -m pytest tests/runtime/test_settings_api.py::test_settings_api_get_put -v
```
预期：FAIL（404 Not Found）

- [ ] **Step 3: api.py 挂载 settings router**

在 `nexogenesis/runtime/api.py` 顶部 import 区追加：

```python
from nexogenesis.runtime.settings import public_settings, save_settings
```

在 `create_app` 中 `app.include_router(_simulate_router(...))` 之后追加一行：

```python
    app.include_router(_settings_router(root))
```

在文件末尾追加：

```python
def _settings_router(root: Path):
    from fastapi import APIRouter
    from pydantic import BaseModel

    router = APIRouter()

    class SettingsIn(BaseModel):
        base_url: str
        model: str
        api_key: str = ""

    @router.get("/api/settings")
    def get_settings() -> dict:
        return public_settings(root)

    @router.put("/api/settings")
    def put_settings(body: SettingsIn) -> dict:
        save_settings(root, base_url=body.base_url, model=body.model,
                      api_key=body.api_key)
        return public_settings(root)

    return router
```

- [ ] **Step 4: 跑测试确认通过**

```bash
"$PY" -m pytest tests/runtime/test_settings_api.py -v
```
预期：7 passed

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add nexogenesis/runtime/api.py tests/runtime/test_settings_api.py
git commit -m "feat(runtime): settings API（GET/PUT /api/settings，key 打码）"
```

---

## Task 3: conversations 存储模块

**Files:**
- Create: `nexogenesis/runtime/conversations.py`
- Test: `tests/runtime/test_conversations.py`

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/test_conversations.py`：

```python
import json

from nexogenesis.runtime.conversations import (
    append_messages, create_conversation, create_project,
    ensure_default_project, get_conversation, list_projects,
)


def test_default_project_created(tmp_path):
    projects = list_projects(tmp_path)
    assert len(projects) == 1
    assert projects[0]["name"] == "默认项目"
    assert projects[0]["conversations"] == []


def test_create_project_and_conversation(tmp_path):
    default = ensure_default_project(tmp_path)
    proj = create_project(tmp_path, "课题甲")
    conv = create_conversation(tmp_path, proj["id"])
    assert conv["title"] == "新对话"
    assert conv["messages"] == []

    projects = list_projects(tmp_path)
    by_id = {p["id"]: p for p in projects}
    assert by_id[proj["id"]]["conversations"][0]["id"] == conv["id"]
    assert by_id[default["id"]]["conversations"] == []


def test_append_messages_and_title(tmp_path):
    proj = ensure_default_project(tmp_path)
    conv = create_conversation(tmp_path, proj["id"])
    updated = append_messages(tmp_path, conv["id"], [
        {"role": "user", "content": "什么是知识涌现？请详细说说这个问题，它和学习有什么区别？"},
        {"role": "assistant", "content": "知识涌现是……"},
    ])
    assert updated["title"] == "什么是知识涌现？请详细说说这个问题，它和"  # 前 20 字
    assert len(updated["messages"]) == 2
    assert all("ts" in m for m in updated["messages"])

    loaded = get_conversation(tmp_path, conv["id"])
    assert loaded["messages"][1]["content"] == "知识涌现是……"


def test_corrupt_conversation_skipped(tmp_path):
    proj = ensure_default_project(tmp_path)
    conv = create_conversation(tmp_path, proj["id"])
    bad = tmp_path / "07-Conversations" / "bad.json"
    bad.write_text("{broken", encoding="utf-8")
    projects = list_projects(tmp_path)
    ids = [c["id"] for p in projects for c in p["conversations"]]
    assert ids == [conv["id"]]


def test_get_missing_returns_none(tmp_path):
    assert get_conversation(tmp_path, "nope") is None
    assert append_messages(tmp_path, "nope", [{"role": "user", "content": "x"}]) is None


def test_invalid_conv_id_rejected(tmp_path):
    assert get_conversation(tmp_path, "../evil") is None
    assert get_conversation(tmp_path, "x" * 13) is None
    assert append_messages(tmp_path, "../evil", [{"role": "user", "content": "x"}]) is None
```

（评审增补：conv_id 格式校验防路径穿越；测试文件顶部的 `import json` 已删除——未使用。）

- [ ] **Step 2: 跑测试确认失败**

```bash
"$PY" -m pytest tests/runtime/test_conversations.py -v
```
预期：FAIL（`ModuleNotFoundError`）

- [ ] **Step 3: 实现 conversations.py**

新建 `nexogenesis/runtime/conversations.py`：

```python
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

DEFAULT_PROJECT_NAME = "默认项目"

_ID_RE = re.compile(r"[0-9a-f]{12}")


def _valid_id(conv_id: str) -> bool:
    return bool(_ID_RE.fullmatch(conv_id))


def _dir(root: Path) -> Path:
    return root / "07-Conversations"


def _projects_path(root: Path) -> Path:
    return _dir(root) / "_projects.json"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _load_projects(root: Path) -> list[dict]:
    data = _read_json(_projects_path(root))
    if isinstance(data, list):
        return [p for p in data if isinstance(p, dict) and p.get("id")]
    return []


def ensure_default_project(root: Path) -> dict:
    root = root.resolve()
    projects = _load_projects(root)
    if projects:
        return projects[0]
    project = {"id": uuid.uuid4().hex[:12],
               "name": DEFAULT_PROJECT_NAME, "created_at": _now()}
    _write_json(_projects_path(root), [project])
    return project


def _load_all_conversations(root: Path) -> list[dict]:
    d = _dir(root)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        if p.name.startswith("_"):
            continue
        data = _read_json(p)
        if isinstance(data, dict) and data.get("id"):
            out.append(data)
    return out


def list_projects(root: Path) -> list[dict]:
    """项目列表；各项目附带对话摘要（updated_at 倒序）。"""
    root = root.resolve()
    ensure_default_project(root)
    by_project: dict[str, list[dict]] = {}
    for c in _load_all_conversations(root):
        by_project.setdefault(c.get("project_id", ""), []).append(c)
    out = []
    for p in _load_projects(root):
        summaries = [
            {"id": c["id"], "title": c["title"], "updated_at": c["updated_at"]}
            for c in by_project.get(p["id"], [])
            if all(k in c for k in ("id", "title", "updated_at"))
        ]
        summaries.sort(key=lambda s: s["updated_at"], reverse=True)
        out.append({**p, "conversations": summaries})
    return out


def create_project(root: Path, name: str) -> dict:
    root = root.resolve()
    ensure_default_project(root)
    projects = _load_projects(root)
    project = {"id": uuid.uuid4().hex[:12],
               "name": name.strip() or "未命名项目", "created_at": _now()}
    projects.append(project)
    _write_json(_projects_path(root), projects)
    return project


def create_conversation(root: Path, project_id: str) -> dict | None:
    """新建会话；项目不存在返回 None（防孤儿会话——评审增补）。"""
    root = root.resolve()
    ensure_default_project(root)
    if not any(p["id"] == project_id for p in _load_projects(root)):
        return None
    conv = {
        "id": uuid.uuid4().hex[:12],
        "project_id": project_id,
        "title": "新对话",
        "created_at": _now(),
        "updated_at": _now(),
        "messages": [],
    }
    _write_json(_dir(root) / f"{conv['id']}.json", conv)
    return conv


def get_conversation(root: Path, conv_id: str) -> dict | None:
    if not _valid_id(conv_id):
        return None
    data = _read_json(_dir(root) / f"{conv_id}.json")
    if isinstance(data, dict) and data.get("id") == conv_id:
        return data
    return None


def append_messages(root: Path, conv_id: str, messages: list[dict]) -> dict | None:
    """追加消息落盘；首条用户消息生成标题（前 20 字）。会话不存在返回 None。"""
    if not _valid_id(conv_id):
        return None
    root = root.resolve()
    conv = get_conversation(root, conv_id)
    if conv is None:
        return None
    for m in messages:
        conv["messages"].append({**m, "ts": _now()})
    if conv["title"] == "新对话":
        first_user = next((m for m in conv["messages"] if m["role"] == "user"), None)
        if first_user:
            conv["title"] = first_user["content"][:20]
    conv["updated_at"] = _now()
    _write_json(_dir(root) / f"{conv_id}.json", conv)
    return conv
```

- [ ] **Step 4: 跑测试确认通过**

```bash
"$PY" -m pytest tests/runtime/test_conversations.py -v
```
预期：5 passed

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add nexogenesis/runtime/conversations.py tests/runtime/test_conversations.py
git commit -m "feat(runtime): 07-Conversations 项目/会话 JSON 存取模块"
```

---

## Task 4: projects / conversations API

**Files:**
- Modify: `nexogenesis/runtime/api.py`
- Test: `tests/runtime/test_conversations.py`

- [ ] **Step 1: 追加失败测试**

在 `tests/runtime/test_conversations.py` 末尾追加：

```python
from fastapi.testclient import TestClient

from nexogenesis.runtime.api import create_app


def test_projects_conversations_api(tmp_path):
    client = TestClient(create_app(tmp_path))

    r = client.get("/api/projects")
    assert r.status_code == 200
    projects = r.json()["projects"]
    assert len(projects) == 1
    default_id = projects[0]["id"]

    r = client.post("/api/projects", json={"name": "课题乙"})
    assert r.status_code == 200
    new_proj = r.json()
    assert new_proj["name"] == "课题乙"

    r = client.post("/api/conversations", json={"project_id": new_proj["id"]})
    assert r.status_code == 200
    conv = r.json()
    assert conv["project_id"] == new_proj["id"]

    r = client.get(f"/api/conversations/{conv['id']}")
    assert r.status_code == 200
    assert r.json()["messages"] == []

    r = client.get("/api/conversations/nonexistent")
    assert r.status_code == 404

    # 新建项目出现在列表且默认项目仍在
    projects = client.get("/api/projects").json()["projects"]
    assert {p["name"] for p in projects} == {"默认项目", "课题乙"}
    assert default_id in {p["id"] for p in projects}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
"$PY" -m pytest tests/runtime/test_conversations.py::test_projects_conversations_api -v
```
预期：FAIL（404）

- [ ] **Step 3: api.py 挂载 conversations router**

`nexogenesis/runtime/api.py` 顶部 import 区追加：

```python
from nexogenesis.runtime import conversations as conv_store
```

`create_app` 中追加：

```python
    app.include_router(_conversations_router(root))
```

模块级（`SettingsIn` 旁）追加请求模型（**不可定义在 router 闭包内**：api.py 顶部有 `from __future__ import annotations`，FastAPI 解析不到闭包内的注解类，会返回 422——Task 2 已踩过此坑）：

```python
class ProjectIn(BaseModel):
    name: str


class ConversationIn(BaseModel):
    project_id: str
```

文件末尾追加：

```python
def _conversations_router(root: Path):
    from fastapi import APIRouter

    router = APIRouter()

    @router.get("/api/projects")
    def get_projects() -> dict:
        return {"projects": conv_store.list_projects(root)}

    @router.post("/api/projects")
    def post_project(body: ProjectIn) -> dict:
        return conv_store.create_project(root, body.name)

    @router.post("/api/conversations")
    def post_conversation(body: ConversationIn) -> dict:
        conv = conv_store.create_conversation(root, body.project_id)
        if conv is None:
            raise HTTPException(status_code=404,
                                detail=f"项目不存在: {body.project_id}")
        return conv

    @router.get("/api/conversations/{conv_id}")
    def get_conversation(conv_id: str) -> dict:
        conv = conv_store.get_conversation(root, conv_id)
        if conv is None:
            raise HTTPException(status_code=404, detail=f"对话不存在: {conv_id}")
        return conv

    return router
```

- [ ] **Step 4: 跑测试确认通过**

```bash
"$PY" -m pytest tests/runtime/test_conversations.py -v
```
预期：6 passed

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add nexogenesis/runtime/api.py tests/runtime/test_conversations.py
git commit -m "feat(runtime): projects/conversations REST API"
```

---

## Task 5: 提取 `edges_touching` 为公共函数

**Files:**
- Modify: `nexogenesis/runtime/simulate.py`
- Test: `tests/runtime/test_simulate.py`（已有，不新增）

已确认 `_edges_touching` 仅被 `simulate.py` 内部引用（build_judge ×2、build_talk ×1），测试未引用私有名。

- [ ] **Step 1: 改名并更新引用**

`nexogenesis/runtime/simulate.py` 中：

```python
def _edges_touching(graph: dict, node_ids: set[str], cap: int) -> list[dict]:
```
改为：

```python
def edges_touching(graph: dict, node_ids: set[str], cap: int) -> list[dict]:
```

三处调用同步改：`build_judge` 第 34 行、第 62 行，`build_talk` 第 74 行，均改为 `edges_touching(...)`。

- [ ] **Step 2: 跑既有测试确认零回归**

```bash
"$PY" -m pytest tests/runtime/test_simulate.py -v
```
预期：全部 PASS（行为不变，纯改名）

- [ ] **Step 3: Commit（需用户确认）**

```bash
git add nexogenesis/runtime/simulate.py
git commit -m "refactor(runtime): _edges_touching 提升为公共 edges_touching（供聊天编排复用）"
```

---

## Task 6: chat 编排模块

**Files:**
- Create: `nexogenesis/runtime/chat.py`
- Test: `tests/runtime/test_chat_api.py`

设计要点：`select_activation` 为纯函数（graph + hits → 种子/两跳/摘录），单独单测；`run_chat` 通过参数注入 `sleep` 与 `llm` 便于测试；DeepSeek 调用走 httpx。

- [ ] **Step 1: 写失败测试**

新建 `tests/runtime/test_chat_api.py`：

```python
import asyncio

import pytest

from nexogenesis.runtime.chat import (
    build_messages, run_chat, select_activation,
)

GRAPH = {
    "nodes": [{"id": n} for n in ("a", "b", "c", "d", "e", "f")],
    "edges": [
        {"id": "e1", "from": "a", "to": "b"},
        {"id": "e2", "from": "a", "to": "c"},
        {"id": "e3", "from": "b", "to": "d"},
        {"id": "e4", "from": "d", "to": "e"},
        {"id": "e5", "from": "e", "to": "f"},
    ],
}

HITS = [
    {"linked_cards": ["a"], "attribution": "user", "excerpt": "卡片 a 摘录"},
    {"linked_cards": ["b"], "attribution": "user", "excerpt": "卡片 b 摘录"},
]


def test_select_activation_seeds_and_hops():
    act = select_activation(GRAPH, HITS)
    assert act["seeds"] == ["a", "b"]
    hop1_ids = {e["id"] for e in act["hop1"]}
    assert hop1_ids == {"e1", "e2", "e3"}          # 触及 a/b 的边
    hop2_ids = {e["id"] for e in act["hop2"]}
    assert hop2_ids <= {"e4", "e5"}                 # 第二跳不含第一跳的边
    assert not (hop1_ids & hop2_ids)
    assert act["excerpts"][0]["excerpt"] == "卡片 a 摘录"


def test_select_activation_empty_hits():
    act = select_activation(GRAPH, [])
    assert act == {"seeds": [], "hop1": [], "hop2": [], "excerpts": []}


def test_select_activation_seeds_capped():
    hits = [{"linked_cards": [f"c{i}"], "attribution": "u", "excerpt": "x"}
            for i in range(10)]
    act = select_activation(GRAPH, hits)
    assert len(act["seeds"]) == 6


def test_build_messages_with_context():
    msgs = build_messages(
        [{"role": "user", "content": "之前的问题"},
         {"role": "assistant", "content": "之前的回答"}],
        [{"card_ids": ["a"], "attribution": "user", "excerpt": "摘录文本"}],
        "现在的问题",
    )
    assert msgs[0]["role"] == "system"
    assert msgs[1] == {"role": "user", "content": "之前的问题"}
    last = msgs[-1]["content"]
    assert "摘录文本" in last and "[a]" in last and "现在的问题" in last


def test_build_messages_without_context():
    msgs = build_messages([], [], "裸问题")
    assert msgs[-1] == {"role": "user", "content": "裸问题"}


class FakeBus:
    def __init__(self):
        self.events = []

    async def publish(self, type_, payload):
        self.events.append((type_, payload))


def test_run_chat_event_order_and_pacing(monkeypatch, tmp_path):
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: HITS)
    sleeps = []

    async def fake_sleep(d):
        sleeps.append(d)

    async def fake_llm(settings, messages):
        return "这是回答"

    bus = FakeBus()
    answer = asyncio.run(run_chat(
        bus, tmp_path, GRAPH, [], "问题",
        settings={"base_url": "https://x", "model": "m", "api_key": "k"},
        sleep=fake_sleep, llm=fake_llm,
    ))
    assert answer == "这是回答"
    types = [t for t, _ in bus.events]
    assert types[0] == "skill.trigger"
    assert types[1] == "retrieve.query"
    assert types[2] == "graph.hit" and bus.events[2][1]["role"] == "seed"
    assert types[3] == "graph.hit" and bus.events[3][1]["role"] == "expand"
    assert "card.read" in types
    assert types[-1] == "session.idle"
    # 起搏：seed 前 1.0s、hop1 前 1.0s、hop2 前 0.8s、每个 card.read 前 1.2s
    assert sleeps[:3] == [1.0, 1.0, 0.8]
    assert sleeps[3:] == [1.2, 1.2]


def test_run_chat_no_hits_skips_pacing(monkeypatch, tmp_path):
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: [])
    sleeps = []

    async def fake_sleep(d):
        sleeps.append(d)

    async def fake_llm(settings, messages):
        return "无检索回答"

    bus = FakeBus()
    answer = asyncio.run(run_chat(
        bus, tmp_path, GRAPH, [], "问题",
        settings={"base_url": "x", "model": "m", "api_key": "k"},
        sleep=fake_sleep, llm=fake_llm,
    ))
    assert answer == "无检索回答"
    assert sleeps == []
    types = [t for t, _ in bus.events]
    assert "graph.hit" not in types
    assert types[-1] == "session.idle"
```

说明：环境未装 pytest-asyncio，async 测试统一用 `asyncio.run()` 同步包装（不新增测试依赖）。

- [ ] **Step 2: 跑测试确认失败**

```bash
"$PY" -m pytest tests/runtime/test_chat_api.py -v
```
预期：FAIL（`ModuleNotFoundError: nexogenesis.runtime.chat`）

- [ ] **Step 3: 实现 chat.py**

新建 `nexogenesis/runtime/chat.py`：

```python
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from nexogenesis.rag.search import rag_search
from nexogenesis.runtime.simulate import edges_touching

SEED_CAP = 6
HOP1_CAP = 9
HOP2_KEY_NODES = 3
HOP2_CAP = 6
HISTORY_LIMIT = 10

SYSTEM_PROMPT = (
    "你是 Nexogenesis 知识体的对话助手。用户拥有一个结构化的领域知识库，"
    "系统会在每次提问时检索相关卡片并把摘录提供给你。"
    "回答时优先基于提供的卡片摘录，引用时注明卡片 id（形如 [card-id]）；"
    "摘录不足以回答时，明确说明知识库中缺少相关内容，再给出你的通用见解。"
)


def _degree(graph: dict, node_id: str) -> int:
    return sum(1 for e in graph["edges"]
               if e["from"] == node_id or e["to"] == node_id)


def select_activation(graph: dict, hits: list[dict]) -> dict:
    """纯函数：检索命中 → 种子节点 + 两跳扩散边 + 摘录（无命中时全空）。"""
    seeds: list[str] = []
    for h in hits:
        for cid in h.get("linked_cards", []):
            if cid not in seeds:
                seeds.append(cid)
    seeds = seeds[:SEED_CAP]
    node_ids = {n["id"] for n in graph["nodes"]}
    seeds = [cid for cid in seeds if cid in node_ids]  # 过滤非活跃卡（评审增补）
    if not seeds:
        return {"seeds": [], "hop1": [], "hop2": [], "excerpts": []}
    hop1 = edges_touching(graph, set(seeds), cap=HOP1_CAP)
    hop1_nodes = {e["to"] for e in hop1} | {e["from"] for e in hop1}
    key_nodes = sorted(hop1_nodes - set(seeds),
                       key=lambda n: -_degree(graph, n))[:HOP2_KEY_NODES]
    hop2 = [e for e in edges_touching(graph, set(key_nodes), cap=len(graph["edges"]))
            if e not in hop1][:HOP2_CAP]  # 先去重后截断（评审增补）
    excerpts = [
        {"card_ids": h.get("linked_cards", []),
         "attribution": h.get("attribution", ""),
         "excerpt": h.get("excerpt", "")}
        for h in hits[:SEED_CAP]
    ]
    return {"seeds": seeds, "hop1": hop1, "hop2": hop2, "excerpts": excerpts}


def _edge_nodes(edges: list[dict]) -> list[str]:
    return sorted({e["to"] for e in edges} | {e["from"] for e in edges})


def build_messages(history: list[dict], excerpts: list[dict],
                   message: str) -> list[dict]:
    """组装 DeepSeek messages：system + 历史 + （检索上下文 +）当前问题。"""
    msgs: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history[-HISTORY_LIMIT:]:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            msgs.append({"role": m["role"], "content": m["content"]})
    if excerpts:
        blocks = []
        for ex in excerpts:
            cards = ", ".join(f"[{c}]" for c in ex["card_ids"]) or "（未关联卡片）"
            blocks.append(f"【卡片 {cards}｜来源 {ex['attribution']}】\n{ex['excerpt']}")
        context = "以下是本次检索到的知识卡片摘录：\n\n" + "\n\n".join(blocks)
        msgs.append({"role": "user",
                     "content": f"{context}\n\n---\n用户问题：{message}"})
    else:
        msgs.append({"role": "user", "content": message})
    return msgs


async def call_deepseek(settings: dict, messages: list[dict]) -> str:
    """调用 OpenAI 兼容 chat completions（非流式）。"""
    url = settings["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings['api_key']}"}
    payload = {"model": settings["model"], "messages": messages, "stream": False}
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, json=payload, headers=headers)
        r.raise_for_status()
        data = r.json()
    return data["choices"][0]["message"]["content"]


async def run_chat(
    bus,
    root: Path,
    graph: dict,
    history: list[dict],
    message: str,
    *,
    settings: dict,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    llm: Callable[[dict, list[dict]], Awaitable[str]] = call_deepseek,
) -> str:
    """对话编排：起搏发布检索事件（与 build_talk 剧本节奏对齐）→ LLM 生成。

    事件序列：skill.trigger → retrieve.query → graph.hit(seed) →
    graph.hit(expand)×1~2 → card.read×≤2 →（LLM）→ session.idle。
    无检索命中时跳过闪烁与起搏，直接调用 LLM。
    """
    await bus.publish("skill.trigger", {"skill": "nexo-talk"})
    await bus.publish("retrieve.query", {"mode": "talk", "query": message})
    try:
        act = select_activation(graph, rag_search(root, message, top=8))
        if act["seeds"]:
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
        messages = build_messages(history, act["excerpts"], message)
        answer = await llm(settings, messages)
    finally:
        await bus.publish("session.idle", {"reason": "talk-complete"})
    return answer
```

注意 `run_chat` 第三个参数是 `graph: dict`（不是 `graph_fn`）——由 API 层调用 `build_graph_payload(root)` 一次性取图，与 `simulate.py` 的 `graph_fn()` 用法保持一致的数据源。

- [ ] **Step 4: 跑测试确认通过**

```bash
"$PY" -m pytest tests/runtime/test_chat_api.py -v
```
预期：7 passed

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add nexogenesis/runtime/chat.py tests/runtime/test_chat_api.py
git commit -m "feat(runtime): 对话编排模块（检索激活 + 两跳扩散 + 起搏 + DeepSeek）"
```

---

## Task 7: chat API + inbox API

**Files:**
- Modify: `nexogenesis/runtime/api.py`
- Test: `tests/runtime/test_chat_api.py`

- [ ] **Step 1: 追加失败测试**

在 `tests/runtime/test_chat_api.py` 末尾追加：

```python
from fastapi.testclient import TestClient

from nexogenesis.runtime.api import create_app
from nexogenesis.runtime.conversations import (
    create_conversation, ensure_default_project, get_conversation,
)


def _client_with_conv(kb_root, monkeypatch):
    """kb_root fixture（tests/runtime/conftest.py）自带卡片与图谱快照，
    /api/chat 内部会调用 build_graph_payload(root)，必须用真实知识库根。"""
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: HITS)

    async def fake_llm(settings, messages):
        return " mocked 回答 "

    monkeypatch.setattr("nexogenesis.runtime.chat.call_deepseek", fake_llm)
    proj = ensure_default_project(kb_root)
    conv = create_conversation(kb_root, proj["id"])
    return TestClient(create_app(kb_root)), conv


def test_chat_requires_key(kb_root, monkeypatch):
    client, conv = _client_with_conv(kb_root, monkeypatch)
    r = client.post("/api/chat", json={"conversation_id": conv["id"], "message": "hi"})
    assert r.status_code == 400
    assert "API Key" in r.json()["detail"]


def test_chat_unknown_conversation(kb_root, monkeypatch):
    client, _ = _client_with_conv(kb_root, monkeypatch)
    r = client.post("/api/chat", json={"conversation_id": "nope", "message": "hi"})
    assert r.status_code == 404


def test_chat_success_persists(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    client, conv = _client_with_conv(kb_root, monkeypatch)
    r = client.post("/api/chat",
                    json={"conversation_id": conv["id"], "message": "什么是涌现"})
    assert r.status_code == 200
    assert r.json()["answer"] == " mocked 回答 "
    saved = get_conversation(kb_root, conv["id"])
    roles = [m["role"] for m in saved["messages"]]
    assert roles == ["user", "assistant"]
    assert saved["title"] == "什么是涌现"


def test_chat_llm_failure_keeps_user_message(kb_root, monkeypatch):
    from nexogenesis.runtime.settings import save_settings
    save_settings(kb_root, base_url="https://x", model="m", api_key="sk-test")
    monkeypatch.setattr("nexogenesis.runtime.chat.rag_search",
                        lambda root, q, top=8: [])

    async def failing_llm(settings, messages):
        raise httpx.HTTPError("boom")

    monkeypatch.setattr("nexogenesis.runtime.chat.call_deepseek", failing_llm)
    proj = ensure_default_project(kb_root)
    conv = create_conversation(kb_root, proj["id"])
    client = TestClient(create_app(kb_root), raise_server_exceptions=False)
    r = client.post("/api/chat", json={"conversation_id": conv["id"], "message": "hi"})
    assert r.status_code == 502
    saved = get_conversation(kb_root, conv["id"])
    assert [m["role"] for m in saved["messages"]] == ["user", "system"]


def test_inbox_upload(tmp_path):
    import io
    client = TestClient(create_app(tmp_path))
    files = [("files", ("材料.md", io.BytesIO("# 标题".encode()), "text/markdown"))]
    r = client.post("/api/inbox", files=files)
    assert r.status_code == 200
    assert r.json()["saved"] == ["材料.md"]
    assert (tmp_path / "00-Inbox" / "材料.md").read_text(encoding="utf-8") == "# 标题"

    # 重名自动加后缀
    r = client.post("/api/inbox", files=files)
    assert r.json()["saved"] == ["材料-2.md"]

    # 路径穿越防护
    evil = [("files", ("../evil.md", io.BytesIO(b"x"), "text/markdown"))]
    r = client.post("/api/inbox", files=evil)
    assert r.json()["saved"] == ["evil.md"]
    assert (tmp_path / "00-Inbox" / "evil.md").exists()
```

在文件顶部 import 区补充 `import httpx`。

- [ ] **Step 2: 跑测试确认失败**

```bash
"$PY" -m pytest tests/runtime/test_chat_api.py -v
```
预期：新 API 测试 FAIL（404）

- [ ] **Step 3: api.py 挂载 chat 与 inbox router**

`nexogenesis/runtime/api.py` 顶部 import 区追加（用 `load_conversation` 别名，避免与 Task 4 路由内嵌套的 `get_conversation` 函数名混淆）：

```python
from nexogenesis.runtime.chat import run_chat
from nexogenesis.runtime.conversations import (
    append_messages, get_conversation as load_conversation,
)
from nexogenesis.runtime.settings import load_settings
```

`create_app` 中追加：

```python
    app.include_router(_chat_router(root, bus, lambda: build_graph_payload(root)))
    app.include_router(_inbox_router(root))
```

文件末尾追加（`ChatIn` 同样放模块级，理由见 Task 4 的说明）：

```python
class ChatIn(BaseModel):
    conversation_id: str
    message: str


def _chat_router(root: Path, bus, graph_fn):
    from fastapi import APIRouter

    router = APIRouter()

    @router.post("/api/chat")
    async def chat(body: ChatIn) -> dict:
        conv = load_conversation(root, body.conversation_id)
        if conv is None:
            raise HTTPException(status_code=404,
                                detail=f"对话不存在: {body.conversation_id}")
        settings = load_settings(root)
        if not settings["api_key"]:
            raise HTTPException(status_code=400,
                                detail="请先在设置中配置 LLM API Key")
        try:
            answer = await run_chat(
                bus, root, graph_fn(), conv["messages"], body.message,
                settings=settings,
            )
        except Exception as exc:  # LLM/网络失败：用户消息落盘并标记未应答
            append_messages(root, body.conversation_id, [
                {"role": "user", "content": body.message},
                {"role": "system", "content": f"（本轮回答失败：{exc}）"},
            ])
            raise HTTPException(status_code=502,
                                detail=f"LLM 调用失败：{exc}") from exc
        append_messages(root, body.conversation_id, [
            {"role": "user", "content": body.message},
            {"role": "assistant", "content": answer},
        ])
        return {"answer": answer, "conversation_id": body.conversation_id}

    return router


def _inbox_router(root: Path):    from fastapi import APIRouter, File, UploadFile

    router = APIRouter()

    @router.post("/api/inbox")
    async def upload(files: list[UploadFile] = File(...)) -> dict:
        inbox = root / "00-Inbox"
        inbox.mkdir(parents=True, exist_ok=True)
        saved: list[str] = []
        for f in files:
            name = Path(f.filename or "unnamed").name  # 剥掉路径，防穿越
            target = inbox / name
            n = 2
            while target.exists():
                target = inbox / f"{Path(name).stem}-{n}{Path(name).suffix}"
                n += 1
            target.write_bytes(await f.read())
            saved.append(target.name)
        return {"saved": saved}

    return router
```

- [ ] **Step 4: 跑测试确认通过**

```bash
"$PY" -m pytest tests/runtime/test_chat_api.py -v
"$PY" -m pytest tests/runtime/ -v
```
预期：chat_api 全过；runtime 目录全量无回归

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add nexogenesis/runtime/api.py tests/runtime/test_chat_api.py
git commit -m "feat(runtime): /api/chat 与 /api/inbox 端点"
```

---

## Task 8: requirements 与 .gitignore

**Files:**
- Modify: `requirements.txt`
- Modify: `.gitignore`

- [ ] **Step 1: 补依赖声明**

`requirements.txt` 追加：

```text
fastapi>=0.115
uvicorn>=0.30
httpx>=0.27
python-multipart>=0.0.9
```

- [ ] **Step 2: 补 .gitignore**

`.nexogenesis/web-settings.json` 一行已在 Task 1 修复中加入，无需重复。在知识体目录段落（`06-Journal/` 行后）追加：

```text
07-Conversations/
```

- [ ] **Step 3: 验证依赖已装 + 全量测试**

```bash
"$PY" -c "import fastapi, uvicorn, httpx, multipart; print('deps ok')"
"$PY" -m pytest tests/ -x -q
```
预期：deps ok；全量测试 PASS

- [ ] **Step 4: Commit（需用户确认）**

```bash
git add requirements.txt .gitignore
git commit -m "chore: 声明 web 运行时依赖，gitignore 会话目录与 LLM 配置"
```

---

## Task 9: 前端 api/client.ts 扩展

**Files:**
- Modify: `web/src/api/client.ts`
- Test: `web/src/api/client.test.ts`（新建，vitest）

- [ ] **Step 1: 写失败测试**

新建 `web/src/api/client.test.ts`：

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjects, saveSettings, sendChat, uploadInbox } from "./client";

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const out = impl(url, init) as { ok: boolean; status?: number; body: unknown };
    return {
      ok: out.ok,
      status: out.status ?? (out.ok ? 200 : 500),
      json: async () => out.body,
    } as Response;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("client", () => {
  it("sendChat POSTs JSON and returns answer", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/chat");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        conversation_id: "c1", message: "你好",
      });
      return { ok: true, body: { answer: "回答", conversation_id: "c1" } };
    });
    const r = await sendChat("c1", "你好");
    expect(r.answer).toBe("回答");
  });

  it("sendChat throws backend detail on error", async () => {
    mockFetch(() => ({ ok: false, status: 400, body: { detail: "请先在设置中配置 LLM API Key" } }));
    await expect(sendChat("c1", "x")).rejects.toThrow("请先在设置中配置 LLM API Key");
  });

  it("fetchProjects returns projects array", async () => {
    mockFetch((url) => {
      expect(url).toBe("/api/projects");
      return { ok: true, body: { projects: [{ id: "p1", name: "默认项目", conversations: [] }] } };
    });
    const ps = await fetchProjects();
    expect(ps[0].name).toBe("默认项目");
  });

  it("saveSettings PUTs and returns public view", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/settings");
      expect(init?.method).toBe("PUT");
      return { ok: true, body: { base_url: "https://api.deepseek.com", model: "deepseek-chat", api_key_masked: "sk-···0001", has_key: true, username: "u" } };
    });
    const s = await saveSettings({ base_url: "https://api.deepseek.com", model: "deepseek-chat", api_key: "sk-x" });
    expect(s.has_key).toBe(true);
  });

  it("uploadInbox posts multipart FormData", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("/api/inbox");
      expect(init?.body).toBeInstanceOf(FormData);
      return { ok: true, body: { saved: ["a.md"] } };
    });
    const file = new File(["x"], "a.md");
    const list = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;
    const r = await uploadInbox(list);
    expect(r.saved).toEqual(["a.md"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npm test -- client.test.ts
```
预期：FAIL（`sendChat is not a function` 等导出不存在）

- [ ] **Step 3: client.ts 追加新 API**

`web/src/api/client.ts` 末尾追加：

```typescript
// ---------- 设置 ----------

export interface Settings {
  base_url: string;
  model: string;
  api_key_masked: string;
  has_key: boolean;
  username: string;
}

async function jsonOrThrow(r: Response) {
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch { /* 保留 status */ }
    throw new Error(detail);
  }
  return r.json();
}

export async function fetchSettings(): Promise<Settings> {
  return jsonOrThrow(await fetch("/api/settings"));
}

export async function saveSettings(s: {
  base_url: string; model: string; api_key?: string;
}): Promise<Settings> {
  return jsonOrThrow(await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: "", ...s }),
  }));
}

// ---------- 项目与会话 ----------

export interface ConversationSummary {
  id: string; title: string; updated_at: string;
}

export interface Project {
  id: string; name: string; created_at: string;
  conversations: ConversationSummary[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts?: string;
}

export interface Conversation {
  id: string; project_id: string; title: string;
  created_at: string; updated_at: string;
  messages: ChatMessage[];
}

export async function fetchProjects(): Promise<Project[]> {
  return (await jsonOrThrow(await fetch("/api/projects"))).projects;
}

export async function createProject(name: string): Promise<Project> {
  return jsonOrThrow(await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }));
}

export async function createConversation(projectId: string): Promise<Conversation> {
  return jsonOrThrow(await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  }));
}

export async function fetchConversation(id: string): Promise<Conversation> {
  return jsonOrThrow(await fetch(`/api/conversations/${encodeURIComponent(id)}`));
}

export async function sendChat(conversationId: string, message: string):
  Promise<{ answer: string; conversation_id: string }> {
  return jsonOrThrow(await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, message }),
  }));
}

// ---------- Inbox 材料 ----------

export async function uploadInbox(files: FileList): Promise<{ saved: string[] }> {
  const fd = new FormData();
  for (const f of Array.from(files)) fd.append("files", f);
  return jsonOrThrow(await fetch("/api/inbox", { method: "POST", body: fd }));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd web && npm test -- client.test.ts
```
预期：5 passed

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts
git commit -m "feat(web): client 增加 settings/projects/conversations/chat/inbox API"
```

---

## Task 10: Sidebar 与 SettingsModal 组件

**Files:**
- Create: `web/src/components/Sidebar.tsx`
- Create: `web/src/components/SettingsModal.tsx`

纯 UI 组件，验证方式：`npm run build`（tsc 类型检查）+ Task 13 手动走查。

- [ ] **Step 1: 实现 Sidebar.tsx**

新建 `web/src/components/Sidebar.tsx`：

```tsx
import { useRef, useState } from "react";
import type { Project } from "../api/client";

const CAPABILITIES = ["思考", "记忆", "反思"];

interface Props {
  projects: Project[];
  currentConvId: string | null;
  username: string;
  onNewConversation: (projectId: string) => void;
  onNewProject: () => void;
  onSelectConversation: (id: string) => void;
  onCapability: (name: string) => void;
  onUploadFiles: (files: FileList) => void;
  onOpenSettings: () => void;
}

export function Sidebar(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const defaultProjectId = p.projects[0]?.id;

  const btn =
    "flex w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-200 transition hover:border-teal-400/40 hover:text-teal-200";

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-white/[0.06] bg-zinc-950/60">
      {/* 功能按钮 */}
      <div className="space-y-1.5 p-3">
        <button className={btn} onClick={() => defaultProjectId && p.onNewConversation(defaultProjectId)}>
          <span className="text-teal-300">＋</span> 新对话
        </button>
        <button className={btn} onClick={() => fileRef.current?.click()}>
          <span className="text-teal-300">⇪</span> Add 材料
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) p.onUploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* 能力按钮（占位） */}
      <div className="px-3 pb-1">
        <div className="micro-label pb-1.5">能力</div>
        <div className="flex gap-1.5">
          {CAPABILITIES.map((name) => (
            <button
              key={name}
              className="flex-1 rounded-lg border border-white/[0.06] bg-zinc-900/60 px-2 py-1.5 text-[12px] text-zinc-400 transition hover:border-amber-400/30 hover:text-amber-200"
              onClick={() => p.onCapability(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {/* 项目 / 对话列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="micro-label flex items-center justify-between py-1.5">
          项目
          <button
            className="text-zinc-500 transition hover:text-teal-300"
            title="新建项目"
            onClick={p.onNewProject}
          >
            ＋
          </button>
        </div>
        {p.projects.map((proj) => (
          <div key={proj.id} className="mb-1">
            <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-zinc-300">
              <button
                className="text-zinc-600"
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [proj.id]: !c[proj.id] }))
                }
              >
                {collapsed[proj.id] ? "▸" : "▾"}
              </button>
              <span className="min-w-0 flex-1 truncate">{proj.name}</span>
              <button
                className="text-zinc-600 opacity-0 transition hover:text-teal-300 group-hover:opacity-100"
                title="在此项目下新建对话"
                onClick={() => p.onNewConversation(proj.id)}
              >
                ＋
              </button>
            </div>
            {!collapsed[proj.id] &&
              proj.conversations.map((c) => (
                <button
                  key={c.id}
                  className={`block w-full truncate rounded-md px-3 py-1 pl-6 text-left text-[12px] transition ${
                    c.id === p.currentConvId
                      ? "bg-teal-400/10 text-teal-200"
                      : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
                  }`}
                  onClick={() => p.onSelectConversation(c.id)}
                >
                  {c.title}
                </button>
              ))}
          </div>
        ))}
      </div>

      {/* 底部：用户名 + 设置 */}
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-400/15 text-[11px] text-teal-300">
          {p.username.slice(0, 1).toUpperCase() || "?"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-400">
          {p.username}
        </span>
        <button
          className="text-zinc-500 transition hover:text-zinc-200"
          title="设置"
          onClick={p.onOpenSettings}
        >
          ⚙
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: 实现 SettingsModal.tsx**

新建 `web/src/components/SettingsModal.tsx`：

```tsx
import { useEffect, useState } from "react";
import { fetchSettings, saveSettings, type Settings } from "../api/client";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings()
      .then((loaded) => {
        setS(loaded);
        setBaseUrl(loaded.base_url);
        setModel(loaded.model);
      })
      .catch((e) => setStatus(`加载失败：${e}`));
  }, []);

  const save = async () => {
    try {
      const saved = await saveSettings({
        base_url: baseUrl, model, api_key: apiKey,
      });
      setS(saved);
      setApiKey("");
      setStatus("已保存");
      setTimeout(onClose, 400);
    } catch (e) {
      setStatus(`保存失败：${e}`);
    }
  };

  const field =
    "w-full rounded-lg border border-white/[0.08] bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-100 outline-none transition focus:border-teal-400/40";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-96 rounded-xl border border-white/[0.08] bg-zinc-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[13px] font-medium text-zinc-200">设置</span>
          <button className="text-zinc-500 hover:text-zinc-200" onClick={onClose}>✕</button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <span className="micro-label">API Key（DeepSeek）</span>
            <input
              type="password"
              className={field}
              placeholder={s?.has_key ? `已配置 ${s.api_key_masked}，留空不修改` : "sk-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="micro-label">Base URL</span>
            <input className={field} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="block">
            <span className="micro-label">模型</span>
            <input className={field} value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          {status && <p className="text-[11px] text-zinc-500">{status}</p>}
          <button
            className="w-full rounded-lg bg-teal-400/90 py-1.5 text-[12px] font-medium text-zinc-950 transition hover:bg-teal-300"
            onClick={save}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查**

```bash
cd web && npx tsc -b
```
预期：通过（此时组件尚未被引用，无未使用告警；若 tsconfig 开了 noUnusedLocals 且组件未被 import 也不报错，因为文件本身会被编译）

- [ ] **Step 4: Commit（需用户确认）**

```bash
git add web/src/components/Sidebar.tsx web/src/components/SettingsModal.tsx
git commit -m "feat(web): 侧边栏与设置弹窗组件"
```

---

## Task 11: ChatPanel 重写为受控对话面板

**Files:**
- Modify: `web/src/components/ChatPanel.tsx`（整体重写）

消息状态提升到 App（Task 12），ChatPanel 变为纯受控组件。

- [ ] **Step 1: 重写 ChatPanel.tsx**

整体替换 `web/src/components/ChatPanel.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../api/client";

interface Props {
  title: string | null;
  messages: ChatMessage[];
  sending: boolean;
  onSend: (text: string) => void;
}

export function ChatPanel({ title, messages, sending, onSend }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, sending]);

  const submit = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    onSend(text);
  };

  return (
    <div className="flex h-full flex-col">
      {/* 对话标题 */}
      <div className="flex h-10 shrink-0 items-center border-b border-white/[0.06] px-4">
        <span className="truncate text-[12px] text-zinc-400">
          {title ?? "选择或新建一个对话"}
        </span>
      </div>

      {/* 消息区 */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-8 text-center text-xs leading-6 text-zinc-600">
            对知识体提问。
            <br />
            被召回的卡片会在图谱中点亮，并沿关系扩散。
          </p>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-800 px-3.5 py-2 text-[13px] leading-5 text-zinc-100">
                {m.content}
              </div>
            </div>
          ) : m.role === "assistant" ? (
            <div key={i} className="whitespace-pre-wrap px-1 text-[13px] leading-6 text-zinc-200">
              {m.content}
            </div>
          ) : (
            <div key={i} className="border-l-2 border-teal-400/50 pl-3 text-[12px] leading-5 text-zinc-500">
              {m.content}
            </div>
          )
        )}
        {sending && (
          <div className="flex items-center gap-2 px-1 text-[12px] text-zinc-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
            正在检索知识体并生成回答…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="border-t border-white/[0.06] p-3">
        <input
          className="w-full rounded-full border border-white/[0.08] bg-zinc-900 px-4 py-2 text-[13px] text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/40 focus:ring-2 focus:ring-teal-400/20 disabled:opacity-50"
          placeholder={title ? "提问…" : "先在左侧新建对话"}
          value={input}
          disabled={!title || sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
    </div>
  );
}
```

注意：旧的 `onTrigger`/`simulate` 关键词触发逻辑整体移除（真实对话取代）；simulate 演示仍由 App 的 URL 参数 autoplay 保留。

- [ ] **Step 2: 类型检查（预期失败）**

```bash
cd web && npx tsc -b
```
预期：FAIL —— `App.tsx` 仍以旧 props 引用 ChatPanel。这正是下一步 Task 12 要解决的；本步仅确认错误定位在 App.tsx。

- [ ] **Step 3: 暂不 commit**（与 Task 12 合并提交，避免仓库处于编译失败状态）

---

## Task 12: App.tsx 三栏整合

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 重写 App.tsx**

整体替换 `web/src/App.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivationEngine } from "./activation/engine";
import {
  createConversation, createProject, fetchConversation, fetchGraph,
  fetchProjects, fetchReplay, fetchSettings, sendChat, simulate,
  subscribeEvents, uploadInbox,
  type ChatMessage, type Conversation, type Project,
} from "./api/client";
import { CardReader } from "./components/CardReader";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { GraphCanvas } from "./graph/GraphCanvas";
import type { GraphData, SimEvent } from "./graph/types";

export default function App() {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const t0Ref = useRef(performance.now() / 1000);

  const [projects, setProjects] = useState<Project[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [localMsgs, setLocalMsgs] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [username, setUsername] = useState("用户");

  useEffect(() => {
    fetchGraph().then(setData).catch((e) => setError(String(e)));
    refreshProjects();
    fetchSettings()
      .then((s) => setUsername(s.username))
      .catch(() => { /* 设置不可用时保持默认名 */ });
  }, []);

  const refreshProjects = useCallback(() => {
    fetchProjects().then(setProjects).catch(() => { /* 忽略 */ });
  }, []);

  const engine = useMemo(
    () => (data ? new ActivationEngine(new Map(data.edges.map((e) => [e.id, e.bundle]))) : null),
    [data]
  );

  useEffect(() => {
    if (!engine) return;
    // 截图走查模式（replay）不挂 SSE：常驻挂起的 EventSource 会冻结 headless 虚拟时钟
    if (new URLSearchParams(window.location.search).get("nosse") === "1") return;
    return subscribeEvents((ev: SimEvent) => {
      engine.handleEvent(ev, performance.now() / 1000 - t0Ref.current);
      setTick((n) => n + 1);
    });
  }, [engine]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autoplay = params.get("autoplay");
    if (!autoplay || !engine) return;
    if (params.get("replay") === "1") {
      // 截图走查：一次性取剧本事件表，本地按 0.35x 压缩调度（不经 SSE）
      let cancelled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      fetchReplay(autoplay).then((events) => {
        if (cancelled) return;
        for (const ev of events) {
          timers.push(setTimeout(() => {
            const now = performance.now() / 1000 - t0Ref.current;
            engine.handleEvent({ type: ev.type, ts: ev.t, payload: ev.payload }, now);
            setTick((n) => n + 1);
          }, 1500 + ev.t * 350));
        }
      });
      return () => { cancelled = true; timers.forEach(clearTimeout); };
    }
    const batch = params.get("batch") === "1";
    const timer = setTimeout(() => simulate(autoplay, batch), 1500);
    return () => clearTimeout(timer);
  }, [engine]);

  // ---------- 会话操作 ----------

  const convIdRef = useRef<string | null>(null);

  useEffect(() => {
    convIdRef.current = conv?.id ?? null;
  }, [conv?.id]);

  const selectConversation = useCallback(async (id: string) => {
    try {
      const loaded = await fetchConversation(id);
      setConv(loaded);
      setLocalMsgs([]);
    } catch { /* 对话读取失败忽略 */ }
  }, []);

  const newConversation = useCallback(async (projectId: string) => {
    try {
      const created = await createConversation(projectId);
      refreshProjects();
      setConv(created);
      setLocalMsgs([]);
    } catch (e) {
      pushLocal({ role: "system", content: `新建对话失败：${e}` });
    }
  }, [refreshProjects, pushLocal]);

  const newProject = useCallback(async () => {
    const name = window.prompt("项目名称：");
    if (!name?.trim()) return;
    try {
      await createProject(name.trim());
      refreshProjects();
    } catch (e) {
      pushLocal({ role: "system", content: `新建项目失败：${e}` });
    }
  }, [refreshProjects, pushLocal]);

  const pushLocal = useCallback((m: ChatMessage) => {
    setLocalMsgs((list) => [...list, m]);
  }, []);

  const send = useCallback(async (text: string) => {
    if (!conv || sending) return;
    const convId = conv.id;
    const startCount = conv.messages.length;
    setSending(true);
    setLocalMsgs((list) => [...list, { role: "user", content: text }]);
    try {
      await sendChat(convId, text);
      const fresh = await fetchConversation(convId);
      if (convIdRef.current === convId) {
        setConv(fresh);
        // 保留本地系统提示（能力占位/上传回执）；乐观 user 消息已由服务端落盘
        setLocalMsgs((list) => list.filter((m) => m.role === "system"));
      }
      refreshProjects();
    } catch (e) {
      try {
        const fresh = await fetchConversation(convId);
        if (fresh.messages.length > startCount) {
          // 502：服务端已落盘 user+system 失败标记——以服务器状态为准
          if (convIdRef.current === convId) {
            setConv(fresh);
            setLocalMsgs((list) => list.filter((m) => m.role === "system"));
          }
        } else if (convIdRef.current === convId) {
          pushLocal({ role: "system", content: `发送失败：${e}` });
        }
      } catch {
        if (convIdRef.current === convId) {
          pushLocal({ role: "system", content: `发送失败：${e}` });
        }
      }
    } finally {
      setSending(false);
    }
  }, [conv, sending, pushLocal, refreshProjects]);

  const capability = useCallback((name: string) => {
    pushLocal({ role: "system", content: `「${name}」能力开发中，敬请期待` });
  }, [pushLocal]);

  const upload = useCallback(async (files: FileList) => {
    try {
      const r = await uploadInbox(files);
      pushLocal({ role: "system", content: `已放入 Inbox：${r.saved.join("、")}，可用 /compile 编译` });
    } catch (e) {
      pushLocal({ role: "system", content: `上传失败：${e}` });
    }
  }, [pushLocal]);

  if (error) return <div className="p-8 text-red-400">加载失败：{error}</div>;
  if (!data || !engine) return <div className="p-8 text-zinc-500">加载中…</div>;
  if (data.nodes.length === 0)
    return <div className="p-8 text-zinc-500">知识库为空：01-Cards/ 中没有卡片。</div>;

  const messages = conv ? [...conv.messages, ...localMsgs] : localMsgs;

  return (
    <div className="flex h-full w-full">
      <Sidebar
        projects={projects}
        currentConvId={conv?.id ?? null}
        username={username}
        onNewConversation={newConversation}
        onNewProject={newProject}
        onSelectConversation={selectConversation}
        onCapability={capability}
        onUploadFiles={upload}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="graph-vignette relative min-w-0 flex-1">
        <GraphCanvas data={data} engine={engine} onNodeClick={setCardId} />
      </div>
      <aside className="flex w-96 shrink-0 flex-col border-l border-white/[0.06]">
        <ChatPanel
          title={conv?.title ?? null}
          messages={messages}
          sending={sending}
          onSend={send}
        />
      </aside>
      <CardReader cardId={cardId} onClose={() => setCardId(null)} />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
```

- [ ] **Step 2: 构建验证**

```bash
cd web && npm run build
```
预期：`tsc -b && vite build` 全部通过

- [ ] **Step 3: 前端全量测试**

```bash
cd web && npm test
```
预期：既有测试（activation/graph 等）+ client.test.ts 全部 PASS

- [ ] **Step 4: Commit Task 11+12（需用户确认）**

```bash
git add web/src/components/ChatPanel.tsx web/src/App.tsx
git commit -m "feat(web): 三栏布局整合，ChatPanel 重写为真实多会话对话"
```

---

## Task 13: 端到端验证与手动走查

- [ ] **Step 1: 后端全量测试**

```bash
"$PY" -m pytest tests/ -q
```
预期：全部 PASS

- [ ] **Step 2: 启动服务走查**

```bash
"$PY" -m nexogenesis serve
```

浏览器打开后逐项走查：

1. 三栏布局：左侧边栏 / 中央图谱 / 右侧全高对话；无顶栏、无事件流面板
2. 侧边栏：新对话、Add 材料按钮；思考/记忆/反思点击后对话区出现「能力开发中」提示；项目可折叠、项目内新建对话；底部显示系统用户名与 ⚙
3. ⚙ 打开设置：填入真实 DeepSeek API Key 保存；重开设置可见掩码且 key 不出现在响应里
4. 新建对话 → 发送问题 → 图谱依次出现 seed 闪烁 → 边扩散（两跳）→ card.read → 回答到达；节奏与 `?autoplay=talk` 模拟观感一致
5. 未配 key 时发送 → 对话区显示「请先在设置中配置 LLM API Key」
6. 刷新页面 → 对话历史仍在；`07-Conversations/` 下出现会话 JSON
7. Add 材料上传文件 → `00-Inbox/` 出现该文件，对话区出现提示
8. `?autoplay=talk` 模拟演示仍正常

- [ ] **Step 3: 发现问题就回到对应 Task 修复；全部通过后由用户决定是否提交/收尾**
