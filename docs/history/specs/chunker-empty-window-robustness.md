# Chunker 空阅读窗健壮性补丁

## 问题描述

在编译图书（book）类 Inbox 文档时，`compile` 循环偶尔会在某个章节卡住：

- LLM 返回 `"本窗仅含章节标题与占位图片，无实质论点...产出 0 块"`。
- `compile --check-responses` 把 0 buffer 判为 hard 失败。
- 循环脚本终止，整本书的编译中断。

触发场景：

1. **文首空窗**：章节以大标题 `# Prologue` 开头，紧接着是插图或空行，然后才是第一个 `##` 小标题。chunker 把标题与插图之间的无正文片段单独切成一个阅读窗。
2. **连续标题行**：EPUB 转 Markdown 后，章节可能连续出现 `# Chapter 1` 与 `# Chapter Title` 两行标题，中间几乎没有正文，被切成一个极短的阅读窗。

这些窗没有可供提取的实质内容，LLM 返回 0 buffer 是合理的；但 harness 目前不接受 0 buffer，导致流程失败。

## 根因定位

问题出在 `nexogenesis/ingest/chunker.py` 的 `split_text_by_headings`：

- 文首无标题前缀（`prefix`）只要非空就单独成窗，不判断内容是否充实。
- 选窗后，每个 window body 也直接成窗，不判断除去标题行后的正文是否过短。
- 因此 EPUB 转换产生的标题页、连续标题行会被当作正常阅读窗交给 LLM。

## 修复方案

在 `chunker.py` 中引入两个新机制：

1. **`MIN_LEADING_CHARS = 200`**：文首前缀的等效字符数低于此阈值时，不再单独成窗，而是合并到首个标题窗。
2. **`MIN_BODY_CHARS = 10` + `_section_body_is_empty()`**：判断一个 section 是否除了标题行、图片占位、HTML 锚点外几乎没有正文。如果是，则合并到下一个 section。

合并策略：

- 文首 prefix 为空窗时，附加到 `window_idxs[0]` 对应的第一个 section 正文前。
- 中间 section 为空窗时，将其 text 拼接到下一个 section 的 text 前。
- 合并只在存在下一个 section 时进行；最后一个 section 不会被删除。

这样可以把“章节标题页”“连续标题行”等无实质内容的片段吸收到相邻的正式小节中，避免 LLM 收到空窗后返回 0 buffer。

## 代码改动

- `nexogenesis/ingest/chunker.py`
  - 新增常量 `MIN_LEADING_CHARS`、`MIN_BODY_CHARS`。
  - 新增辅助函数 `_section_body_is_empty()`。
  - 修改 `split_text_by_headings()` 的 prefix 处理与最终合并逻辑。
- `tests/ingest/test_chunker.py`
  - 新增 4 个测试用例覆盖：短文首合并、连续标题行合并、长文首保留、build_compile_units 不产生空窗。

## 验证

在开发仓运行：

```bash
pytest tests/ingest/test_chunker.py tests/ingest/test_batch_runner.py \
  tests/test_compile_command.py tests/ingest/test_compile_windows.py \
  tests/ingest/test_prompts.py -v
```

结果：45 passed。

## 影响与回滚

- 正向影响：图书/长文编译对 EPUB 转 Markdown 产生的标题页更健壮，减少因 0 buffer 导致循环中断。
- 潜在影响：极少数正文确实极短（<10 实际字符）的小节会被合并到下一节；这通常符合“无质料不单独成窗”的原则。
- 回滚方式：将 `MIN_LEADING_CHARS` 调小或把 `_section_body_is_empty()` 的合并逻辑注释掉即可恢复旧行为。
