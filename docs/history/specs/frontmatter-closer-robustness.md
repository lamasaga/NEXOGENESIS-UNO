# Compile Buffer 解析：frontmatter 闭合 --- 的健壮性补丁

> 状态：已实施（代码 + 测试）  
> 关联文件：`nexogenesis/ingest/batch_runner.py`、`tests/ingest/test_batch_runner.py`  
> 触发场景：长文编译循环中 LLM 偶发漏写 frontmatter 闭合 `---`

---

## 1. 问题描述

在 `compile` 阶段，LLM 需要为每个阅读窗产出 1～N 个 Buffer，格式为：

```markdown
---
title: "..."
role: meaning-unit
source: "..."
---

## 核心表达

  正文 ...
```

`parse_llm_buffers()` 原本使用单独成行的 `---` 作为 frontmatter 边界。一旦 LLM 漏写第二个 `---`：

```markdown
---
title: "..."
role: meaning-unit
source: "..."

## 核心表达

  正文 ...
```

解析器会把从第一个 `---` 到下一个 `---` 之间的全部内容（frontmatter + 正文）当成 YAML 解析，导致 `yaml.parser.ParserError`，本轮编译 hard 失败。

### 1.1 为什么这是系统性问题

- **LLM 格式漂移**：即使 prompt 和 `compile-exemplars/book.md` 正例都明确写了闭合 `---`，长上下文或多轮输出时仍会偶发漏写。
- **任务越长概率越高**：本次 Antifragile + Dalio CWO 编译在 Prompt 144（总计约 2.5 小时后）触发；随着编译轮次增加，命中概率趋向 1。
- **后果严重**：单个格式符号错误导致整轮编译中断，必须人工/脚本介入后重跑。

---

## 2. 修复方案

### 2.1 设计原则

1. **向后兼容**：严格格式（含闭合 `---`）的行为和输出不变。
2. **自动修复而非报错**：识别到 frontmatter key-value 块后未正常闭合时，自动补 `---`，并记录 warning。
3. **不误伤正文水平线**：正文中的 `---` 因后面没有 `key: value` 行，不会被误判为 frontmatter 开始。

### 2.2 实现

在 `nexogenesis/ingest/batch_runner.py` 新增 `_repair_missing_frontmatter_closers()`：

- 按行扫描文本；
- 遇到 `---` 后，若后续紧跟若干 `key: value` 行，则判定为 frontmatter 开始；
- 跳过 frontmatter 后的空行；
- 若下一个非空行不是 `---`，则在 frontmatter 结束处补上 `---`；
- 返回修复后的文本及是否发生过修复的标志。

`parse_llm_buffers()` 在解析前调用该修复函数，并将修复事件写入 `parse_notes`，最终通过 `logger.warning` 输出。

### 2.3 关键代码

```python
_FM_KEY_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*:\s*")


def _repair_missing_frontmatter_closers(text: str) -> tuple[str, bool]:
    """修复 LLM 偶尔漏写的 frontmatter 闭合 ``---``。"""
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    repaired = False
    while i < n:
        line = lines[i]
        if line.strip() != "---":
            out.append(line)
            i += 1
            continue

        out.append(line)
        i += 1

        fm_lines: list[str] = []
        while i < n and _FM_KEY_RE.match(lines[i]):
            fm_lines.append(lines[i])
            i += 1

        if not fm_lines:
            continue

        out.extend(fm_lines)

        blanks: list[str] = []
        while i < n and lines[i].strip() == "":
            blanks.append(lines[i])
            i += 1

        if i < n and lines[i].strip() == "---":
            out.extend(blanks)
            continue

        out.extend(blanks)
        out.append("---")
        out.append("")
        repaired = True

    return "\n".join(out), repaired
```

---

## 3. 测试

新增 `tests/ingest/test_batch_runner.py::test_parse_llm_buffers_missing_frontmatter_closer`：

- 输入两个 Buffer，frontmatter 均缺少闭合 `---`；
- 断言仍能解析出 2 个 Buffer；
- 断言 title、role 正确，且正文包含 `## 核心表达`。

运行结果：

```bash
pytest tests/ingest/test_batch_runner.py tests/test_compile_command.py tests/ingest/test_compile_windows.py tests/ingest/test_prompts.py -v
# 38 passed
```

---

## 4. 影响与撤回

### 4.1 影响面

- `parse_llm_buffers()` 所有调用路径（compile check-responses、测试、未来其他 LLM 输出解析）均自动受益。
- 不改变正常格式输出；仅在检测到缺失闭合时插入 `---` 并记 warning。

### 4.2 撤回方式

若后续发现该修复导致误判，可：

1. 在 `_repair_missing_frontmatter_closers()` 开头增加更严格的启发式（例如要求 `title` 字段必须存在）；
2. 或将其从 `parse_llm_buffers()` 中移除，恢复严格模式。

---

## 5. 相关记录

- 本次修复源于实践仓编译 Antifragile + Dalio CWO 时 Prompt 144 的 `batch-001-book-response.md` 解析失败。
- 临时 workaround：在实践仓的 `tmp/compile_loop_antifragile.py` 中先以正则后处理补 `---`；本补丁将其下沉到核心解析器，根除同类问题。
