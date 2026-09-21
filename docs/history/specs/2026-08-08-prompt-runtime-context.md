# Nexogenesis Prompt 运行时与 Context 逻辑全图

> 状态：v1.0（针对当前 clean-init 状态撰写）  
> 目标：说明 DeepSeek / 任意 LLM API 接入时，提示词由哪些文件拼接、上下文如何组装、任务如何保证按预期执行。

---

## 1. 架构总览：Harness 负责过程，LLM 负责语义

当前仓库是**纯确定性 harness**：

- 所有 prompt 模板、共享约束、卡片契约、写入校验都在仓库里以 markdown / txt / yaml 形式存在。
- 没有任何 LLM 调用代码；LLM 由外部 code agent（Kimi Code / Claude Code / Codex）或未来 DeepSeek API 扮演。
- Harness 的职责是：**选择输入 → 组装 prompt → 调用 LLM → 校验并原子写入 → 更新索引**。

因此，所谓“prompt 生成逻辑” = **harness 在什么时机、从哪些源文件、按什么顺序拼接出一段 markdown，交给 LLM**。

---

## 2. 约束分层（决定 LLM 看到什么优先级）

| 层级 | 文件/目录 | 作用 |
|---|---|---|
| 宪法 | `AGENTS.md` | 最高规则：单向镜像纪律、统一写入入口、禁止删除卡片等 |
| 编排技能 | `.agent/skills/nexo-*/SKILL.md` | 触发条件、工作流、Invariants、Anti-patterns |
| 活契约 | `.agent/reference/card-contracts/` | 卡片正文结构、类型与关系、写法正例 |
| 提示语义 | `schemes/default/prompts/` | 各环节具体 prompt 模板与共享约束片段 |
| 注意力配置 | `schemes/default/attention.yaml` | 双账户席位、预算、图/RAG 参数、强信号 |

LLM 实际收到的内容，通常按以下顺序出现：

1. **Skill 指令**（高层行为约束）
2. **Reference 契约**（卡片怎么写、关系怎么用）
3. **Prompt 模板**（本环节具体任务）
4. **共享约束片段**（质量、写入纪律、Profile 规则）
5. **上下文数据**（Buffer / 卡片目录 / 深读卡片 / RAG 摘录 / STM）
6. **输出格式要求**（`write --batch` YAML 等）

---

## 3. Prompt 源文件地图

### 3.1 模板主目录：`schemes/default/prompts/`

| 文件 | 用途 | 渲染入口 |
|---|---|---|
| `compile-generic.txt` | 通用/未知体裁编译 | `render_compile_prompt` |
| `compile-book.txt` | 书籍编译 | `render_compile_prompt` |
| `compile-paper.txt` | 论文编译 | `render_compile_prompt` |
| `compile-essay.txt` | 散文编译 | `render_compile_prompt` |
| `compile-dialogue.txt` | 对话编译 | `render_compile_prompt` |
| `compile-scrap.txt` | 碎片编译 | `render_compile_prompt` |
| `digest.txt` | Buffer → Card 消化 | `render_digest_prompt` |
| `construct.txt` | 单镜头建构 | `render_construct_prompt` |
| `construct-diagnose.txt` | 结构诊断（只诊断不输出 batch） | `render_construct_prompt(diagnose_mode=True)` |

### 3.2 共享约束片段：`schemes/default/prompts/shared/`

| 文件 | 注入函数 | 说明 |
|---|---|---|
| `card-cheatsheet.txt` | `card_cheatsheet()` | 七型卡片开篇纪律 |
| `quality-contract.txt` | `quality_contract()` | 质料密度与反模式 |
| `write-discipline.txt` | `write_discipline()` | 写入权限、YAML 陷阱、合并规则 |
| `profile-update-rule.txt` | `profile_update_rule()` | 何时更新 `02-Profile/` |

这四个片段被注入到 **digest / construct / emerge** 的 prompt 中。

### 3.3 技能文件：`.agent/skills/nexo-*/SKILL.md`

| Skill | 触发条件 | 核心作用 |
|---|---|---|
| `nexo-talk` | 日常对话、分析、思考 | 读取 Context Package + STM，禁止自动写卡 |
| `nexo-emerge` | 「记一下」「/capture」「涌现」 | 生成 ≤3 候选，用户确认后 `write --batch` |
| `nexo-judge` | 「深判」「/judge」 | 2–4 透镜定位，不裁决 |
| `nexo-compile` | 「编译」「/compile」 | Inbox → Buffer |
| `nexo-digest` | 「消化」「/digest」 | Buffer → Card |
| `nexo-construct` | 「建构」「/construct」 | 结构诊断、合并、升枢纽、张力 |

### 3.4 活契约参考

- `.agent/reference/card-contracts/body-structure.md`
- `.agent/reference/card-contracts/ontology.md`
- `.agent/reference/card-contracts/card-exemplars/`

这些不是直接注入 prompt，而是由 Skill 文件要求 LLM “必读”。

---

## 4. Prompt 渲染机制

所有 prompt 模板使用 **Jinja2** 渲染。

核心代码：`nexogenesis/ingest/prompts.py`

```python
DEFAULT_PROMPTS_DIR = Path(__file__).resolve().parent.parent.parent / "schemes" / "default" / "prompts"

def _load_template(name: str, scheme_dir: Path | None = None) -> Template:
    dirs = []
    if scheme_dir:
        dirs.append(scheme_dir / "prompts")
    dirs.append(DEFAULT_PROMPTS_DIR)
    for d in dirs:
        path = d / f"{name}.txt"
        if path.exists():
            return Template(path.read_text(encoding="utf-8"))
    raise FileNotFoundError(f"Prompt template not found: {name}")
```

扩展机制：未来可以在项目根目录放 `schemes/default/prompts/` 覆盖默认模板；harness 会先找项目级模板，找不到再回退到仓库自带模板。

共享片段加载：

```python
def _load_shared_fragment(name: str) -> str:
    path = DEFAULT_PROMPTS_DIR / "shared" / f"{name}.txt"
    return path.read_text(encoding="utf-8")
```

---

## 5. 各环节 Prompt 拼接细节

### 5.1 Compile：Inbox → Buffer

**入口命令**：`python -m nexogenesis compile --root .`

**代码路径**：

```
nexogenesis/commands/compile.py
  → build_compile_plan / select_wave
  → _write_prompts
    → format_batch_prompt(batch, genre=genre, deep=deep)
      → render_compile_prompt(units, genre=genre, deep=deep)
        → _load_template(f"compile-{genre}")
```

**输入数据**：

- `units`：由 `nexogenesis/ingest/chunker.py` 把原始文档切成的“阅读窗”。每个 unit 包含：
  - `text`：窗内正文
  - `char_count`：字数
  - `source_path` / `title` / `section` / `page_range`：来源信息
  - `genre`：体裁（book / paper / essay / dialogue / scrap / generic）

**Prompt 结构**（以 `compile-generic.txt` 为例）：

```markdown
你是知识库编译助手。体裁【通用/未知】。
Harness 已给出阅读窗。你只做一件事：把每个窗压成 1～6 个有命名、含质料的 Buffer。

【通用提取维度】mechanism / claim / condition / number / boundary / quote ...

{{ format_rules }}

======== 阅读窗 1/N | 1234 字 ========
source: xxx
section: xxx

<窗内正文>

======== 阅读窗 2/N ...
```

- `format_rules()` 是内联 Python 函数，返回 Buffer 的块格式、role、质料标准、禁止事项、示例。
- 每个体裁模板可覆盖通用提取维度，但都会注入 `{{ format_rules }}`。

**Deep 模式**：`--deep` 时 `deep=True`，模板末尾追加“深度=机制与数字更完整，≠更多碎片”。

**输出要求**：LLM 生成 `batch-XXX-<genre>-response.md`，里面是一系列 Buffer 块；harness 用 `check_response_file` 校验后写入 `05-Buffer/`。

---

### 5.2 Digest：Buffer → Card

**入口命令**：`python -m nexogenesis digest --root .`

**代码路径**：

```
nexogenesis/commands/digest.py
  → load_buffer_paths_by_status(scratch)
  → select_digest_buffer_wave(...)        # 选本波 Buffer
  → select_deep_cards(...)                # 选相关卡片深读正文
  → _parse_questions(...)                 # 读 02-Profile/问题清单.md
  → build_context_package(mode=digest)    # RAG 质料摘录
  → render_digest_prompt(...)
```

**Prompt 模板**：`schemes/default/prompts/digest.txt`

**注入变量**：

| 变量 | 来源 | 说明 |
|---|---|---|
| `buffers` | `select_digest_buffer_wave` | 本波要消化的 Buffer 记录 |
| `catalog` | `card_catalog(store)` | 全库卡片一行摘要 |
| `domain_catalog` / `instance_catalog` | catalog 按 type 拆分 | 骨架 vs 实例 |
| `deep_cards` | `select_deep_cards(...)` | 含正文的相关卡片 |
| `domain_deep` / `instance_deep` | deep_cards 按 type 拆分 | |
| `questions` | `02-Profile/问题清单.md` | 现有问题 |
| `bootstrap` | 空库检测 | 是否还没有 domain 卡 |
| `deferred_count` | 本波剩余 Buffer | |
| `index_excerpts` | `01-Cards/_meta/domain-index.md` + `conflict-index.md` | 索引摘录 |
| `material_excerpts` | `build_context_package(mode=digest)` | RAG 工具书摘录 |
| `card_cheatsheet` | `card_cheatsheet()` | 七型卡片结构 |
| `quality_contract` | `quality_contract()` | 质料密度约束 |
| `write_discipline` | `write_discipline()` | 写入纪律 |
| `profile_update_rule` | `profile_update_rule()` | Profile 更新规则 |

**Prompt 大致结构**：

```markdown
你是一位知识库消化助手（骨架滋养）。

{{ quality_contract }}
{{ card_cheatsheet }}

【对每一簇质料的决策树】
1. 是否已有同主题 Card？ → enrich
2. 是否真正新、重要且可独立复用？ → 新建 / skip
3. 是否直接对立？ → conflict

{{ profile_update_rule }}

【Domain 粒度：分裂判定与 enrich 边界】...

{% if bootstrap %}【空库 / 无 domain】...{% endif %}
{% if deferred_count %}本波之后仍有约 N 片 scratch 留待下一波...{% endif %}

索引摘录：...
质料检索摘录（RAG，非 Card）：...

## 领域卡片目录（骨架入口）
...
## 实例卡片目录（无正文）
...
## 领域骨架（深读正文）
...
## 相关实例（深读正文）
...
现有问题：...
本波 Buffer 一览：...
本波 Buffer 全文：...

{{ write_discipline }}

请输出标准 write --batch YAML...
```

**Buffer 选择逻辑**（`select_digest_buffer_wave`）：

- 默认每波最多 8 片（`DEFAULT_WAVE_BUFFERS`）。
- 按 `ROLE_PRIORITY` 排序：`tension > meaning-unit > link-hypothesis > artifact-table > artifact-figure > evidence > detail > profile-seed`。
- Bootstrap（空库）时把 `meaning-unit` 提前，`tension` 降权，避免先抽张力却无 claim 可挂。
- 尽量让同 source 的 Buffer 成波。

**深读卡片选择逻辑**（`select_deep_cards`）：

- 优先用图检索：`deep_cards_from_graph(root, buffers, max_deep=6)`。
- 图检索失败时回退启发式：从 Buffer 标题、粗体、proposed_domains 提取 token，给卡片打分。
- 始终调用 `pin_domain_skeleton`：先保证相关 `domain` 卡进入深读集，再填实例。

---

### 5.3 Construct：结构整理

**入口命令**：`python -m nexogenesis construct --root .`

**代码路径**：

```
nexogenesis/commands/construct.py
  → collect_structure_signals(store, buffer_records)
  → analyze_graph(root, rebuild=True)
  → build_structure_action_plan(store)
  → _run_diagnose
    → render_construct_prompt(diagnose_mode=True)
  → 或 --lens <name>
    → suggest_ids_for_lens(...)        # 为本镜头选卡和 Buffer
    → build_context_package(mode=construct)
    → render_construct_prompt(diagnose_mode=False)
```

**Prompt 模板**：

- 诊断模式：`schemes/default/prompts/construct-diagnose.txt`
- 单镜头模式：`schemes/default/prompts/construct.txt`

**镜头（lens）**：`cluster / distinguish / articulate / cross_source / cross_domain`

**注入变量**（单镜头）：

| 变量 | 说明 |
|---|---|
| `lens` | 当前镜头名 |
| `catalog` | 全库卡片目录 |
| `deep_cards` | 本镜头深读卡片（含正文） |
| `buffers` | 本镜头相关 Buffer 全文 |
| `questions` | 现有问题清单 |
| `signals` | 本镜头确定性信号 |
| `card_cheatsheet` / `quality_contract` / `write_discipline` / `profile_update_rule` | 共享约束 |

**信号来源**（`collect_structure_signals` + `structure_ops`）：

- 孤儿卡、空壳 domain、近义卡、domains 漂移、微型卡
- 互斥 claim、未升格 tension、conflict 缺 involves
- 高频术语未建 hub、关系团未抽 model
- 跨源互补/对立、重复证据缺口

**深读候选构造**：

- `suggest_ids_for_lens` 根据镜头信号挑卡。
- 再把 STM 本会话已引卡前置。
- 最后调用 `build_context_package(mode=construct, seeds=card_ids, rag_top=2)` 补充图邻居和少量 RAG。

---

### 5.4 Retrieve / Talk / Answer / Judge：双轨检索 + Skill 指令

**入口命令**：`python -m nexogenesis retrieve --query "..." --mode talk --root .`

**代码路径**：

```
nexogenesis/commands/retrieve.py
  → build_context_package(...)
    → 若 use_attention: assemble_working_set(...)
    → 否则旧式 graph + RAG 组装
  → save_context_package(...)  → .nexogenesis/tmp/retrieve/context.yaml
```

**双账户注意力组装**（`nexogenesis/thinking/assemble.py`）：

```
load_attention_config(root)            # 三层合并：scheme 默认 / 项目 scheme / .nexogenesis/attention.yaml
  → resolve_effective_config(profile=mode)
    → slots: core / expansion / conflict
    → budget: chars / card_slots / rag_chunks
    → weights / type_priors / graph / rag
  → STMStore.attention_context()
  → pick_seeds(...)                    # query + explicit seeds + buffer tokens + type_priors
  → expand_subgraph(...)               # 图遍历 2 跳
  → _dual_account_select(...)          # core / conflict / expansion 三账户排序
  → rag_search(...) + rag_search_for_cards(...)
```

**Context Package 结构**：

```yaml
query: "用户问题"
mode: "talk"       # talk / answer / judge / digest / construct
status: "ok"
structure:
  seeds: [card-id-1, ...]
  nodes:
    - id: card-id
      title: "..."
      type: "model"
      domains: [...]
      origin: "user"
      hop: 0
      via: card-id-2
      account: "core"       # core / expansion / conflict
      excerpt: "卡片正文摘录（默认 800 字）"
  edges:
    - from: card-a
      to: card-b
      kind: "relation"
      type: "supports"
  accounts:
    core: [card-id, ...]
    expansion: [...]
    conflict: [...]
material:             # RAG 工具书
  - chunk_id: "..."
    kind: "discussion"
    attribution: "..."
    anchor: "..."
    excerpt: "..."
    linked_cards: [...]
stm:
  session_id: "..."
  focus: "..."
  tensions: [...]
  cited_cards: [...]
  user_directives: [...]
  recent_sessions: [...]
attention:
  profile: "talk"
  slots: {core: 3, expansion: 6, conflict: 2}
  session_overrides: {}
blind_spots: [...]
budget:
  chars: 12345
  structure_nodes: 8
  rag_chunks: 6
```

**LLM 看到的完整 prompt** 不是由单一模板生成，而是由 **Skill 文件 + Context Package YAML** 共同组成：

```markdown
# System / Skill 层（由 .agent/skills/nexo-talk/SKILL.md 等提供）

你是一位社科领域知识库助手。当前任务是 talk 模式。
必读：
1. .agent/reference/constraint-layers.md
2. .agent/reference/thinking-body.md
3. .agent/reference/retrieval-design.md
4. 02-Profile/领域理念.md
5. 02-Profile/领域思维范式.md

工作流：
1. 读取 Context Package ...
2. 区分 structure / material / stm ...
3. ...

Invariants：
- 分析默认留在对话；写入必须另走 nexo-emerge。
- 未标注 perspective 时，文档观点标 document，用户立场标 user，系统推断标 system。
- ...

# Context Package（由 retrieve 命令生成）

{{ 上面的 YAML }}

# 用户问题

{{ query }}
```

**不同 mode 的差异**：

| mode | 图节点预算 | RAG 类型 | 冲突席位 | 典型用途 |
|---|---|---|---|---|
| talk | 默认 | discussion / archive / outbox / card_excerpt | 2 | 日常对话 |
| answer | 默认 | 同上 | 2 | 长回答 |
| judge | 冲突席 3 | discussion / archive / card_excerpt | 3 | 深判 |
| digest | 扩展 4 / 冲突 1 | buffer / archive / discussion | 1 | 消化 |
| construct | 图种子 + 少量 RAG | card_excerpt / discussion | - | 建构 |

---

### 5.5 Memory / Signal：短期记忆与强信号

**入口命令**：

```bash
python -m nexogenesis memory start --title "xxx"
python -m nexogenesis memory update --focus "..." --cite card-id --tension "..."
python -m nexogenesis signal --text "用户本轮文本"
```

**代码路径**：

```
nexogenesis/commands/memory.py
  → STMStore.start_session / update_slots / attention_context
  → evaluate_strong_signals(text, stm_slots, config)
```

**STM 数据结构**（`.nexogenesis/memory/stm/index.yaml`）：

```yaml
sessions:
  - id: uuid
    title: "..."
    start: "2026-08-08T..."
    slots:
      turn: 5
      focus: "..."
      cited_cards: [card-id]
      tensions: ["..."]
      user_directives: ["..."]
      bridge_hints: [card-id]
      session_overrides: {}
      signals_disabled_capture: false
      capture_prompts: 0
      last_signal_turn: 3
```

**signal 评估规则**（`nexogenesis/thinking/signals.py`）：

| 触发条件 | 信号类型 | 行为 |
|---|---|---|
| 用户说“记一下 / capture” | `capture` | 立即建议捕获，不受冷却限制 |
| 检测到“但是 / 对立 / 冲突”等 | `conflict_draft` | 建议立冲突草稿 |
| 提到 Inbox / compile | `suggest_compile` | 建议把材料放进 compile |
| 决策/风险/争议词 | `deepen_judge` | 建议加深判 |
| 焦点/张力再次出现 | `profile_question` | 建议写进问题清单 |
| 文本像可复用主张 | `capture` | 建议留下候选 |
| 用户说“先别记 / 别捕获” | `directive_ack` | 关闭本会话主动捕获 |

**这些信号本身不会自动写卡**，它们只是“门铃”。最终是否写入仍须经用户确认并通过 `write --batch`。

---

### 5.6 Emerge / Capture：从对话到卡片

**入口**：用户说「记一下」「/capture」「涌现」。

**没有独立 CLI 命令**，由 `nexo-emerge` Skill 驱动：

1. 判断来源：用户对话 → `origin: user`；文档/Buffer → `origin: document`。
2. 生成 ≤3 个候选卡片或 Profile 字段。
3. 候选内容必须符合：
   - `.agent/reference/card-contracts/body-structure.md`
   - `.agent/reference/card-contracts/ontology.md`
   - `schemes/default/prompts/shared/card-cheatsheet.txt`
   - `schemes/default/prompts/shared/quality-contract.txt`
4. 用户确认后写 `.nexogenesis/tmp/emerge/batch.yaml`。
5. 执行 `python -m nexogenesis write --batch ...`。

**LLM 看到的 prompt 组成**：

- `nexo-emerge SKILL.md` 的工作流与约束
- 共享片段 `card-cheatsheet` + `quality-contract` + `write-discipline`
- 当前 Context Package（若候选来自对话）或 Buffer 全文（若候选来自 Buffer）

---

## 6. Write 事务：从 LLM 输出到落盘

**入口命令**：`python -m nexogenesis write --batch <file> --root .`

**代码路径**：`nexogenesis/commands/write.py`

**做的事情**：

1. 解析 batch YAML。
2. 权限检查：`origin: system` 不能标 `mature` 或 `theory_status: active`。
3. 幽灵链接检查：batch 里引用的 `[[card-id]]` 必须是已知 id。
4. 写入 staging（`.nexogenesis/tmp/write-<uuid>/`）。
5. 成功后提交到 `01-Cards/` / `02-Profile/`。
6. 自动触发 `index` + `graph rebuild` + `rag index`。

**batch YAML 关键字段**：

```yaml
operation:
  id: "uuid"
  approved_by: "user" | "agent"
  source: "digest / construct / emerge / ..."
  consumed_buffers: []        # digest/construct 必填
writes:
  - target: "card" | "profile_question" | "profile_field"
    id: "中文关键词"
    title: "..."
    type: "claim"
    maturity: "growing"
    lifecycle: "active"
    domains: ["domain-id"]
    origin: "document"
    sources: ["..."]
    relations:
      - target: "other-id"
        type: "supports"
        note: "..."
    body: |
      ## 一句话主张
      ...
```

---

## 7. 注意力配置详解

**默认配置**：`schemes/default/attention.yaml`

**三层合并**（`nexogenesis/thinking/config.py`）：

1. 仓库自带 `schemes/default/attention.yaml`
2. 项目级 `schemes/default/attention.yaml`（若存在）
3. 运行时 `.nexogenesis/attention.yaml`（若存在）

**关键字段**：

| 字段 | 含义 |
|---|---|
| `active_profile` | 默认激活哪个模式预设 |
| `budget.chars` | 总字符预算（默认 16000） |
| `budget.card_slots` | 最大卡片槽位数 |
| `budget.rag_chunks` | RAG 块数上限 |
| `slots.core` | 核心席：种子 + 本会话已引用 |
| `slots.expansion` | 扩展席：相关但新颖的旧卡 |
| `slots.conflict` | 冲突席：保底对立面 |
| `weights.expansion` | 相关性 / 新颖性 / 已引用惩罚权重 |
| `weights.conflict` | 相关性 / tension 匹配 / 冲突边权重 |
| `type_priors` | 按卡片类型加分：model > conflict > entity > method > claim > phenomenon |
| `graph.hops` | 图遍历跳数（默认 2） |
| `graph.prefer_bridge_nodes` | 优先桥接节点 |
| `rag.enabled` / `rag.max_chunks` | RAG 开关与上限 |
| `profiles.talk/answer/judge/digest` | 各模式覆盖项 |
| `strong_signals` | 主动捕获门铃配置 |
| `session_overrides` | 本会话临时覆盖 |

**双账户选择流程**（`_dual_account_select`）：

1. **core**：先占 `seed_ids` + `cited` 卡片，直到 `n_core` 满。
2. **conflict**：在已遍历节点中，给 `CONFLICT` 类型、`conflicts-with`/`involves` 边、tension 匹配加分，取前 `n_conflict`。
3. **expansion**：在剩余节点中，按相关性 + 新颖性（未引用、二跳弱连接、桥接）排序，取前 `n_expansion`。
4. 按预算字符截断。

---

## 8. 接入 DeepSeek API 的改造点

当前架构下，harness 生成 prompt 文件后**不直接调用 LLM**，而是交给外部 agent。要接入 DeepSeek API，需要把“外部 agent 读 prompt 文件”替换为“harness 直接发 HTTP 请求”。

### 8.1 最小改造路径

1. **新增 API 客户端模块**（例如 `nexogenesis/llm/deepseek.py`）：
   - 读取 `DEEPSEEK_API_KEY` 等环境变量。
   - 提供 `chat_completion(system, user, temperature=0.3)` 接口。

2. **在命令层增加 `--api` / `--auto` 模式**：
   - `compile --api`：生成 prompt 后直接调用 API，解析 response，写入 `batch-XXX-response.md`，再走现有 `--apply` 流程。
   - `digest --api`：生成 prompt → API → 解析 batch YAML → `write --batch`。
   - `construct --api`：同理。

3. **Prompt 组装不变**：
   - `render_compile_prompt` / `render_digest_prompt` / `render_construct_prompt` 返回的 markdown 直接作为 `user` 消息。
   - `retrieve` 模式下的 Context Package YAML 可作为 `user` 消息附件；Skill 指令作为 `system` 消息。

4. **System 消息设计**：
   - 对于 digest / construct / compile：可把对应 `SKILL.md` 的 Grounding、Workflows、Invariants、Anti-patterns 作为 system 消息；prompt 模板作为 user 消息。
   - 对于 talk / answer / judge：把 `nexo-talk` / `nexo-judge` SKILL.md 作为 system 消息；Context Package YAML + 用户问题作为 user 消息。

5. **输出解析**：
   - compile：解析 markdown 中的 Buffer 块（现有 `check_response_file` 可直接复用）。
   - digest / construct / emerge：解析 YAML（现有 `BatchOperation.from_file` 可直接复用）。
   - talk / answer / judge：直接返回文本。

6. **校验与回滚**：
   - 复用 `nexogenesis/commands/write.py` 的 staging + 校验机制。
   - API 失败或输出不合格时，不写入正式目录。

### 8.2 推荐调用参数

| 环节 | temperature | 说明 |
|---|---|---|
| compile | 0.2–0.3 | 稳定提取，少幻觉 |
| digest | 0.3–0.5 | 需要一定综合，但须严格遵守卡片类型 |
| construct | 0.2–0.4 | 结构动作必须准确 |
| talk / answer | 0.5–0.7 | 分析性回答需要一定弹性 |
| judge | 0.3–0.5 | 多透镜定位，避免过度收敛 |
| emerge | 0.4–0.6 | 候选生成需要创造性 |

### 8.3 上下文长度管理

- `schemes/default/attention.yaml` 的 `budget.chars` 默认 16000 字（约 8k–10k token）。
- 中文场景可按 1 token ≈ 1.5 中文字估算；建议把 budget 控制在模型上下文窗口的 50% 以内，留出 system 消息和输出空间。
- 可通过 `--excerpt-chars` 或修改 `attention.yaml` 调整摘录长度。

---

## 9. 关键文件速查表

| 功能 | 文件 |
|---|---|
| Prompt 模板加载 | `nexogenesis/ingest/prompts.py` |
| Compile prompt 组织 | `nexogenesis/commands/compile.py` |
| Digest prompt 组织 | `nexogenesis/commands/digest.py` |
| Construct prompt 组织 | `nexogenesis/commands/construct.py` |
| Retrieve / Context Package | `nexogenesis/retrieve/context_package.py` |
| 双账户注意力组装 | `nexogenesis/thinking/assemble.py` |
| 注意力配置 | `nexogenesis/thinking/config.py` |
| STM 与信号 | `nexogenesis/thinking/stm.py` / `nexogenesis/thinking/signals.py` |
| Buffer / 卡片选择 | `nexogenesis/ingest/context_pack.py` |
| 写入事务 | `nexogenesis/commands/write.py` |
| 图检索 | `nexogenesis/graph/retrieve.py` |
| RAG 检索 | `nexogenesis/rag/search.py` |
| 编译分波 | `nexogenesis/ingest/compile_planner.py` |
| 结构信号 | `nexogenesis/ingest/structure_signals.py` |
| 结构动作 | `nexogenesis/ingest/construct_ops.py` |

---

## 10. 一句话总结

Nexogenesis 的 prompt 不是一块静态模板，而是**分层约束 + 任务模板 + 共享片段 + 动态上下文**的组装体：

- **分层约束**决定 LLM 能做什么、不能做什么；
- **任务模板**决定当前环节的目标和输出格式；
- **共享片段**把七型卡片纪律、写入纪律、Profile 规则注入每个写卡环节；
- **动态上下文**由图检索、RAG、短期记忆、注意力配置共同决定，确保 LLM 只看到最相关、最有张力的材料；
- **最终输出**通过 `write --batch` 事务原子落盘，失败自动回滚。

接入 DeepSeek API 时，只需把“外部 agent 读 prompt 文件”替换为“harness 直接调用 API 并解析返回”，其余拼接逻辑可完整复用。

---

## 11. 短期记忆（STM）现状与边界

当前仓库的记忆模块不是一个通用 Agent 记忆系统，而是**为“对话连贯 + 捕获门铃”服务的工作记忆层**。理解它的边界，是后续扩展的前提。

### 11.1 已实现的数据结构

存储路径：`.nexogenesis/memory/stm/index.yaml`（可重建，不是语义事实之源）。

核心由 `nexogenesis/thinking/stm.py` 维护：

```yaml
sessions:
  - id: "<uuid>"
    title: "会话标题"
    start: "2026-08-08T..."
    slots:
      turn: 5                       # 回合数
      focus: "..."                  # 当前焦点问题
      cited_cards: [card-id]        # 本会话已引用卡片
      tensions: ["..."]             # 未决张力
      claims_user: ["..."]          # 用户主张
      claims_system: ["..."]        # 系统主张
      user_directives: ["..."]      # 用户禁令，如“先别记”
      bridge_hints: [card-id]       # 意外连上的旧卡
      session_overrides: {}         # 本会话注意力覆盖
      signals_disabled_capture: false
      capture_prompts: 0            # 本会话主动捕获提问次数
      last_signal_turn: 3           # 上次强信号回合
```

`STMStore` 提供的能力：

- `start_session / end_session / current_session`
- `update_slots`：更新任意槽
- `attention_context()`：把当前会话槽转成 `assemble_working_set` 能消费的格式
- `get_session_overrides / set_session_overrides / clear_session_overrides`

### 11.2 与注意力、信号的集成

```text
用户发言
  → 读 attention.yaml
  → 读/更新 STM 当前卷
  → assemble_working_set：focus / cited_cards / bridge_hints 成为图种子
  → 双账户选卡（core / expansion / conflict）
  → RAG 补充工具书
  → LLM 回复
  → 更新 STM
  → evaluate_strong_signals：决定是否轻问用户
```

### 11.3 当前设计的“简陋”之处

| 维度 | 当前实现 | 通用 Agent 期望 |
|---|---|---|
| 生命周期 | 需外部 agent 手动 `memory start` | 自动检测对话开始/结束 |
| 存储介质 | YAML 文件 | 可选项：向量库、SQLite、分块索引 |
| 检索方式 | 只读当前会话 + 最近 10 次会话标题 | 按语义相似度、时间、重要性检索 |
| 自动摘要 | 无 | 每 N 轮自动生成回合摘要 |
| 记忆淘汰 | 固定 10 卷后丢弃或化石 | 基于重要性/使用频率/时间衰减 |
| 记忆升格 | 无 | 自动把反复出现的焦点/张力建议写入 Card / Profile |
| 跨会话联想 | 弱 | 基于 embedding 的 episodic 回忆 |

### 11.4 为什么现在这样设计

`thinking-body.md` 明确说：

> 短期记忆是可重建物；丢了只影响连贯，不影响知识主权。

项目把**语义事实之源**押在 `01-Cards/` 和 `02-Profile/` 上。STM 只是让对话不要每轮从零开始，并负责“轻问用户要不要捕获”。

---

## 12. 未来独立 Agent Runtime 的完整记忆实施方案

如果你要脱离外部 code agent，建立一个长期运行、直接调用 DeepSeek API 的独立 agent，建议把记忆扩展为**四层记忆架构**。

### 12.1 记忆分层

```text
┌─────────────────────────────────────────┐
│  L4 程序记忆（Procedural Memory）         │  已存在：SKILL.md / prompt 模板 / 写入事务
├─────────────────────────────────────────┤
│  L3 语义记忆（Semantic Memory）           │  已存在：01-Cards/ + 02-Profile/ + relations
├─────────────────────────────────────────┤
│  L2 情景记忆（Episodic Memory）           │  待建：对话回合/摘要的向量存储
├─────────────────────────────────────────┤
│  L1 工作记忆（Working Memory）            │  已存在：STM 当前会话槽；待增强自动生命周期
└─────────────────────────────────────────┘
```

### 12.2 L1 工作记忆增强

目标：让 agent 感知“当前对话上下文”，无需用户手动管理。

**自动会话生命周期**：

- 检测到新的用户任务 / 主题漂移（focus 变化 > 阈值）→ 自动 `start_session`
- 检测到长时间无交互或用户明确结束 → `end_session`
- 会话标题可由 LLM 根据前几句自动生成

**新增槽位**：

| 槽 | 作用 |
|---|---|
| `recent_turns` | 最近 4–8 轮对话原文摘要 |
| `pending_questions` | 用户未明确回答的追问 |
| `commitment_queue` | 用户承诺要做的事（如“我回头查一下”） |
| `emotion_tone` | 用户语气标签（可选，用于表达适配） |

**实现**：扩展 `nexogenesis/thinking/stm.py`，保持 YAML 可读，但增加自动检测逻辑。

### 12.3 L2 情景记忆（Episodic Memory）

目标：让 agent 能回忆“我们之前聊过什么”，而不仅是当前会话。

**存储**：

```text
.nexogenesis/memory/episodic/
  episodes.db          # SQLite + sqlite-vss 或 chromadb
  embeddings/          # 可选本地缓存
```

**记录内容**：

```yaml
episode:
  id: uuid
  session_id: uuid
  turn_range: [3, 12]
  summary: "用户在讨论税收归宿时质疑了弹性假设，系统建议看 1990 奢侈税案例"
  focus: "税收归宿与弹性"
  cited_cards: ["税负更多落在缺乏弹性的一侧", "1990奢侈税"]
  tensions: ["弹性假设是否普遍成立"]
  created: "2026-08-08T..."
  importance: 0.72      # 由 LLM 或启发式打分
```

**生成策略**：

- 每 4–6 轮或主题切换时，调用一次轻量 LLM 生成 episode 摘要。
- 摘要模型可用便宜的小模型（如 deepseek-chat-lite），降低主模型成本。

**检索策略**：

```text
query_embedding = embed(当前问题)
recall_candidates = vector_search(query_embedding, top_k=10)
  + filter(time_decay > threshold)
  + boost(同一 session / 同一 domain / 同一 focus)
selected_episodes = rerank_by_relevance_and_importance(recall_candidates)
```

**集成到 Context Package**：

在 `assemble_working_set` 中新增 `episodic` 段：

```yaml
episodic:
  - episode_id: "..."
    summary: "..."
    cited_cards: [...]
```

LLM system 消息增加：

> 以下是本项目历史上相关对话的摘要，仅作连贯参考，不构成事实依据。

### 12.4 L3 语义记忆的主动维护

当前语义记忆已经很强（卡片图）。未来可以增强的是**自动维护**。

**记忆升格（Consolidation）**：

- 当 episodic memory 中同一焦点出现 ≥3 次，且与现有 Card 不完全重合时，agent 主动向用户提议：
  - 新建 Card
  - 更新 `02-Profile/领域理念.md` 或 `领域思维范式.md`
  - 追加 `02-Profile/问题清单.md`
- 提议格式沿用 `write --batch` YAML，须经用户确认。

**重复检测**：

- 用 embedding 比较新 episode 与已有卡片/Profile，避免重复提问。

### 12.5 L4 程序记忆不变

SKILL.md 和 prompt 模板本身就是程序记忆。未来只需：

- 把 SKILL.md 作为 system 消息注入。
- 根据当前任务动态选择加载哪个 SKILL.md（talk / digest / construct / judge / emerge）。

### 12.6 统一的 MemoryStore 接口

建议新增 `nexogenesis/thinking/memory_store.py`，对外统一暴露：

```python
class MemoryStore:
    def start_session(self, title: str = "") -> dict: ...
    def end_session(self) -> str | None: ...
    def current_session(self) -> dict | None: ...
    def update_working(self, **slots) -> dict: ...
    def add_episode(self, summary: str, cited_cards: list, importance: float) -> str: ...
    def recall_episodes(self, query: str, top_k: int = 5) -> list[dict]: ...
    def suggest_consolidation(self) -> list[dict]: ...
    def attention_context(self) -> dict: ...
```

底层由 `STMStore` + `EpisodicStore` + `SemanticStore(Store)` 组合而成。

### 12.7 与 DeepSeek API 的集成点

```text
用户发言
  → MemoryStore.start_session（若需要）
  → MemoryStore.update_working(focus=..., cited_cards=...)
  → MemoryStore.recall_episodes(query)     # 新增：情景记忆
  → SemanticStore.graph_retrieve(...)      # 已存在
  → RAG.search(...)                        # 已存在
  → assemble_working_set(...)              # 已存在，但新增 episodic 段
  → 拼接 system(SKILL.md) + user(context.yaml + query)
  → DeepSeek API
  → 解析回复
  → MemoryStore.add_episode(...)           # 生成 episode
  → evaluate_strong_signals(...)           # 门铃
  → 可选：write --batch（须经用户确认）
```

### 12.8 遗忘策略

避免 episodic memory 无限膨胀：

| 策略 | 说明 |
|---|---|
| 时间衰减 | 旧 episode 重要性按指数衰减 |
| 使用频率 | 被 recall 过的 episode 加分 |
| 用户显式标记 | “这条不重要” → 立即归档 |
| 自动归档 | 重要性 < 阈值且超过 N 天的 episode 移入 cold storage |
| 语义去重 | 高相似 episode 合并 |

### 12.9 实现优先级建议

| 阶段 | 任务 | 收益 |
|---|---|---|
| P0 | 自动 session 生命周期 + recent_turns 槽 | 让对话自然连续 |
| P0 | episodic 摘要 + 向量检索 | 跨会话回忆 |
| P1 | 重要性打分 + 遗忘策略 | 控制存储成本 |
| P1 | consolidation 提议 | 自动维护知识库 |
| P2 | 多模态记忆（图片、表格） | 视需求 |

### 12.10 向后兼容

- 保留 `.nexogenesis/memory/stm/index.yaml` 作为当前会话状态。
- episodic memory 是新增目录，不破坏现有 `retrieve` / `digest` / `construct` 流程。
- 所有自动写入仍走 `write --batch`，保持“用户确认”不变量。

---

## 13. 记忆模块关键文件速查

| 功能 | 文件/目录 |
|---|---|
| 当前 STM 实现 | `nexogenesis/thinking/stm.py` |
| 强信号评估 | `nexogenesis/thinking/signals.py` |
| 注意力配置 | `nexogenesis/thinking/config.py` |
| 注意力组装 | `nexogenesis/thinking/assemble.py` |
| STM 设计契约 | `.agent/reference/thinking-body.md` |
| 注意力 YAML 模板 | `schemes/default/attention.yaml` |
| 当前 STM 存储 | `.nexogenesis/memory/stm/index.yaml` |
| 建议未来 episodic 存储 | `.nexogenesis/memory/episodic/` |

---

## 14. 最终总结

Nexogenesis 当前的 prompt 与记忆设计是** intentionally lightweight（故意轻量）**：

- Prompt 是分层约束 + 任务模板 + 共享片段 + 动态上下文的组装体；
- 记忆把工作记忆交给 STM，把长期语义记忆交给卡片图；
- 这种设计让项目保持“文件即契约”和“可重建索引”的干净底座。

如果未来要接入 DeepSeek API 并做长期运行的独立 agent，核心改造不是推翻现有结构，而是：

1. 在现有 harness 上增加 API 调用层；
2. 把 STM 扩展为自动生命周期 + 向量化的 episodic memory；
3. 让 episodic memory 能自动提议升格到卡片 / Profile；
4. 保持所有实质写入仍经 `write --batch` 与用户确认。

这样既能保留项目底座主权的优势，又能让 agent 拥有真正可用的长期记忆能力。
