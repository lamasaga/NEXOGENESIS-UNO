# Nexogenesis AGENTS.md 与 Skill 体系重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 546 行的 `AGENTS.md` 拆分为宪法层 + `.agent/reference/` 活契约 + `.agent/skills/` PI agent 风格技能，终结大模型行为控制文档体积过大、技能太薄的问题。

**Architecture:** 保持 `AGENTS.md` 为宪法层（核心原则、目录结构、权限分层、索引）；把卡片规范、CLI 参考、摄入纪律、检索设计等活契约迁入 `.agent/reference/`；把 6 个编排技能按 Grounding/Workflows/Invariants/Anti-patterns 模板重写；设计决策与迭代记录归入 `docs/specs/`。

**Tech Stack:** Markdown、Git、Python 3.13、Nexogenesis CLI（`python -m nexogenesis validate`）

---

## 文件映射

| 新文件 | 职责 | 来源 |
|---|---|---|
| `AGENTS.md` | 宪法层 + `.agent/` 索引 | 重写 |
| `README.md` | 项目说明 + 新目录索引 | 修改 |
| `.agent/reference/card-contracts/body-structure.md` | Buffer/Card 正文结构契约 | `01-Cards/_meta/body-structure.md` |
| `.agent/reference/card-contracts/ontology.md` | 卡片类型与关系类型契约 | `01-Cards/_meta/ontology.md` |
| `.agent/reference/card-contracts/card-exemplars/` | 七型写法正例 | `01-Cards/_meta/card-exemplars/` |
| `.agent/reference/harness-cli.md` | CLI 命令速查表与参数详解 | 提取自 `AGENTS.md` §5 |
| `.agent/reference/write-transaction.md` | `write --batch` 事务规则 | 提取自 `AGENTS.md` §5.1–5.3 |
| `.agent/reference/ingest-pipeline.md` | compile → digest → construct 纪律 | 提取自 `AGENTS.md` §8 |
| `.agent/reference/retrieval-design.md` | 图 + RAG 双轨检索设计 | `.agent/reference/retrieval-design.md` |
| `.agent/reference/thinking-body.md` | 思维体注意力设计 | `.agent/reference/thinking-body.md` |
| `.agent/reference/constraint-layers.md` | 约束分层说明 | `.agent/reference/constraint-layers.md` |
| `docs/specs/p0-p1-remaining.md` | P0/P1 剩余项 | `docs/specs/p0-p1-remaining.md` |
| `.agent/skills/nexo-talk/SKILL.md` | 思维体默认对话 | 重写 |
| `.agent/skills/nexo-emerge/SKILL.md` | 捕获/涌现 | 重写 |
| `.agent/skills/nexo-judge/SKILL.md` | 深判 | 重写 |
| `.agent/skills/nexo-compile/SKILL.md` | 编译 → Buffer | 重写 |
| `.agent/skills/nexo-digest/SKILL.md` | 消化 → Card | 重写 |
| `.agent/skills/nexo-construct/SKILL.md` | 建构 → 结构优化 | 重写 |

---

## Task 1: 创建目录骨架

**Files:**
- Create: `.agent/reference/card-contracts/`
- Create: `.agent/reference/card-contracts/card-exemplars/`
- Create: `docs/specs/`

- [ ] **Step 1: 创建目录**

```bash
mkdir -p .agent/reference/card-contracts/card-exemplars
mkdir -p .agent/specs
```

- [ ] **Step 2: 验证目录存在**

```bash
ls -la .agent/reference/ docs/specs/
```

Expected: 显示 `card-contracts` 和 `specs` 目录。

- [ ] **Step 3: Commit**

```bash
git add .agent/reference .agent/specs
git commit -m "chore(agent): create .agent/reference and .agent/specs directories"
```

---

## Task 2: 迁移卡片契约到 `.agent/reference/card-contracts/`

**Files:**
- Create: `.agent/reference/card-contracts/body-structure.md`
- Create: `.agent/reference/card-contracts/ontology.md`
- Create: `.agent/reference/card-contracts/card-exemplars/*`
- Delete: `01-Cards/_meta/body-structure.md`
- Delete: `01-Cards/_meta/ontology.md`
- Delete: `01-Cards/_meta/card-exemplars/`

- [ ] **Step 1: 复制 body-structure.md**

```bash
cp 01-Cards/_meta/body-structure.md .agent/reference/card-contracts/body-structure.md
```

- [ ] **Step 2: 复制 ontology.md**

```bash
cp 01-Cards/_meta/ontology.md .agent/reference/card-contracts/ontology.md
```

- [ ] **Step 3: 复制 card-exemplars 目录**

```bash
cp -r 01-Cards/_meta/card-exemplars/* .agent/reference/card-contracts/card-exemplars/
```

- [ ] **Step 4: 删除旧位置文件**

```bash
rm 01-Cards/_meta/body-structure.md
rm 01-Cards/_meta/ontology.md
rm -rf 01-Cards/_meta/card-exemplars
```

- [ ] **Step 5: 运行 validate 检查无幽灵链接**

```bash
.venv/Scripts/python -m nexogenesis validate --root .
```

Expected: `Validation passed.`

- [ ] **Step 6: Commit**

```bash
git add .agent/reference/card-contracts 01-Cards/_meta
git commit -m "refactor(agent): move card contracts from 01-Cards/_meta to .agent/reference/card-contracts"
```

---

## Task 3: 迁移 docs/ 中活契约到 `.agent/reference/`

**Files:**
- Create: `.agent/reference/retrieval-design.md`
- Create: `.agent/reference/thinking-body.md`
- Create: `.agent/reference/constraint-layers.md`
- Create: `docs/specs/p0-p1-remaining.md`

- [ ] **Step 1: 复制检索设计文档**

```bash
cp ".agent/reference/retrieval-design.md" .agent/reference/retrieval-design.md
```

- [ ] **Step 2: 复制思维体设计文档**

```bash
cp ".agent/reference/thinking-body.md" .agent/reference/thinking-body.md
```

- [ ] **Step 3: 复制约束分层文档**

```bash
cp ".agent/reference/constraint-layers.md" .agent/reference/constraint-layers.md
```

- [ ] **Step 4: 复制 P0/P1 剩余项到 specs**

```bash
cp "docs/specs/p0-p1-remaining.md" docs/specs/p0-p1-remaining.md
```

- [ ] **Step 5: Commit**

```bash
git add .agent/reference/retrieval-design.md .agent/reference/thinking-body.md .agent/reference/constraint-layers.md docs/specs/p0-p1-remaining.md
git commit -m "refactor(agent): migrate active design docs from docs/ to .agent/reference and .agent/specs"
```

---

## Task 4: 创建 `.agent/reference/harness-cli.md`

**Files:**
- Create: `.agent/reference/harness-cli.md`

- [ ] **Step 1: 写入 CLI 参考文档**

```markdown
---
scheme: "default"
version: "0.4.0"
updated: "2026-07-30"
---

# Harness CLI 参考

　　本文档是 `AGENTS.md` 的操作参考层，记录所有 `python -m nexogenesis` 命令。修订须经用户确认。

## 底座维护

| 命令 | 常用选项 | 作用 |
|---|---|---|
| `init` | `--root` | 初始化目录结构、复制 scheme 模板、安装 git pre-commit hook |
| `validate` | `--root` | 校验全部卡片 frontmatter、链接、orphan（pre-commit 亦调用） |
| `index` | `--root` | 生成 `01-Cards/_meta/` 下领域/冲突/理论视图 |
| `write` | `--batch <file>` `--root` | **统一原子写入入口**（卡片、问题清单、Profile 字段、Journal）；成功后自动 `index` + `graph rebuild` + `rag index` |
| `doctor` | `--root` | 目录/契约/hook 检查 + `validate` + 图/RAG 索引陈旧 WARNING |
| `migrate` | `--to <scheme>` `--dry-run` `--root` | scheme 迁移预演 |

## 文档摄入：`compile` → `digest` → `construct`

| 命令 | 常用选项 | 作用 |
|---|---|---|
| `compile` | `--plan` | 预览 Inbox 分波计划（不写 prompt） |
| | `--root` | 生成本波 compile prompt（默认自动分波） |
| | `--check-responses` | 检查 `batch-*-response.*` 格式（不写盘） |
| | `--apply` | 将 response 落盘为 `05-Buffer/`（按文件部分成功） |
| | `--response <file>` | 只检查/apply 指定 response |
| | `--all` `--recursive`/`--no-recursive` `--deep` | 关闭分波 / 是否递归扫 Inbox（默认递归）/ 深度模式（每波 1 篇） |
| | `--max-chars` `--wave-prompts` `--wave-docs` | 分波规模控制 |
| | `--genres "a.md=paper,..."` | 体裁覆盖 |
| | `--strict-body` | 语义槽缺失升为错误 |
| `digest` | `--plan` | 预览本波 Buffer 选择与字符预算 |
| | `--root` | 生成本波 digest prompt（默认 `status=scratch`，分波） |
| | `--apply` | 应用 `.nexogenesis/tmp/digest/batch.yaml` 写入卡片 |
| | `--auto` | 无 batch → prompt+规程；有 batch → 自检通过后 apply |
| | `--wave-buffers N` `--deep-cards N` | 本波 Buffer 数 / 深读卡数 |
| | `--status scratch` `--all-scratch` | Buffer 状态过滤 / 调试全量 |
| `construct` | （默认） | 结构诊断：`lenses-report.md` + graph analyze + 可执行 `structure-ops-draft.md` |
| | `--diagnose` | 显式只诊断（同默认） |
| | `--apply-seed-links` | 应用确定性补边：空 `relations` → `applies-to` 所属 domain |
| | `--lens cluster\|distinguish\|articulate\|cross_source` | 单镜头 prompt（禁止 `all`） |
| | `--plan` | 预览本镜头深读对象 |
| | `--apply` | 应用 `.nexogenesis/tmp/construct/batch.yaml` |
| | `--auto` | 无 lens → 诊断+自动 seed-links+suggested-lenses；有 lens+batch → 自检 apply |
| | `--deep-cards N` `--wave-buffers N` | 镜头模式深读规模 |

**典型顺序：**

```bash
python -m nexogenesis compile --plan --root .
python -m nexogenesis compile --root .
# LLM → batch-XXX-response.md → compile --check-responses → compile --apply

python -m nexogenesis digest --plan --root .
python -m nexogenesis digest --root .
# → batch.yaml → digest --apply 或 digest --auto

python -m nexogenesis construct --root .
# → lenses-report / suggested-lenses → construct --lens <name> → batch.yaml → construct --auto --lens <name>
```

## 双轨检索：结构图 + 质料 RAG

| 命令 | 常用选项 | 作用 |
|---|---|---|
| `graph rebuild` | `--root` | 从卡片重建结构图索引 |
| `graph stats` | `--root` | 节点/边统计 |
| `graph analyze` | `--rebuild` `--root` | orphan、conflict 缺口、桥接点 → `structure_ops.json` + 报告 |
| `graph retrieve` | `--query` `--seed` `--hops` `--max-nodes` `--out` | 结构子图检索，写入 Context Package |
| `graph export` | `--center <id>` `--hops` `--out` `--rebuild` | 导出 GraphML |
| `rag index` | `--full` `--kinds` `--root` | 建/增量更新 FTS 索引 |
| `rag stats` | `--root` | 语料块数与索引时间 |
| `rag search` | `--query` `--kinds` `--top` `--root` | 质料检索 |
| `retrieve` | `--query` `--mode talk\|answer\|digest\|construct\|judge` | 统一双轨入口：结构子图 + RAG 质料 |
| `memory start\|status\|update\|override\|end` | `--focus` `--cite` `--tension` | 短期记忆会话卷 |
| `attention show\|validate` | `--profile` `--print-yaml` | 注意力配置 |
| `signal` | `--text` `--bump-turn` | 强信号评估（只建议，不写卡） |

**检索典型用法：**

```bash
python -m nexogenesis graph rebuild
python -m nexogenesis rag index
python -m nexogenesis memory start --title "今日对话"
python -m nexogenesis retrieve --query "…" --mode talk --root .
python -m nexogenesis signal --text "记一下"
```

## 速记（一行版）

```bash
python -m nexogenesis init | validate | index | doctor
python -m nexogenesis write --batch <file>
python -m nexogenesis compile [--plan|--check-responses|--apply]
python -m nexogenesis digest [--plan|--apply|--auto]
python -m nexogenesis construct [--lens|--apply|--auto]
python -m nexogenesis graph rebuild|stats|analyze|retrieve|export
python -m nexogenesis rag index|stats|search
python -m nexogenesis retrieve --query "…" --mode talk
python -m nexogenesis memory start|status|update|override|end
python -m nexogenesis attention show|validate
python -m nexogenesis signal --text "…"
```
```

- [ ] **Step 2: 验证文件可读**

```bash
.venv/Scripts/python -c "open('.agent/reference/harness-cli.md',encoding='utf-8').read()"
```

- [ ] **Step 3: Commit**

```bash
git add .agent/reference/harness-cli.md
git commit -m "docs(agent): extract harness CLI reference from AGENTS.md"
```

---

## Task 5: 创建 `.agent/reference/write-transaction.md`

**Files:**
- Create: `.agent/reference/write-transaction.md`

- [ ] **Step 1: 写入写入事务文档**

```markdown
---
scheme: "default"
version: "0.4.0"
updated: "2026-07-30"
---

# write --batch 事务规则

　　`write` 是 P0 核心，所有对底座的实质写入（新建/修改卡片、追加问题清单、追加 Profile 字段、追加 Journal）必须通过 `python -m nexogenesis write --batch <file>` 完成。

## 执行顺序

1. 读取 batch YAML；
2. 校验 batch 自身格式；
3. 把每个写入项写到临时文件；
4. 运行完整校验（schema、幽灵链接、orphan、theory 失效边界等）；
5. 校验通过：原子移动临时文件到正式位置 → 追加 Journal → 重新生成索引；
6. 校验失败：删除临时文件，不追加 Journal，不更新索引，返回可读错误。

## batch 文件示例

```yaml
operation:
  id: "2026-07-24-143052-capture"
  source: "对话 2026-07-24"
  approved_by: "user"

writes:
  - target: "card"
    id: "feedback-gap-actionable"
    type: "claim"
    title: "教学反馈应优先指出可操作差距"
    domains: ["teaching"]
    origin: "user"
    maturity: "growing"
    lifecycle: "active"
    body: |
      教师在给出反馈时，应明确指出学生当前表现与目标之间的差距，并提供可操作的建议。
    sources:
      - "2026-07-24 用户对话"
    created: "2026-07-24"
    updated: "2026-07-24"

  - target: "profile_question"
    question: "怎样区分有效反思与自我感动？"
    added_at: "2026-07-24"

  - target: "profile_field"
    file: "领域理念.md"
    section: "核心立场"
    content: "市场化转型国家的制度摩擦常被低估"
    sources:
      - "《某书》第 4 章"
```

## 写入安全

- 所有 YAML 用 `yaml.safe_load` 解析；
- ID 与路径穿越检查（id 允许汉字、字母、数字、连字符 `-`，禁止路径分隔符与危险字符）；
- 先写入 staging 并完整校验，通过后才提交到正式位置；失败不留下半成卡片、问题清单或 Profile 条目；
- `origin: system` 进入 `mature` / `theory_status: active` 须 `approved_by: user` 且 `operation.allow_system_promotion: true`；
- 同一次 batch 对应一个 `operation_id`；digest/construct 用 `operation.consumed_buffers` 声明实际消费的 Buffer 路径。

## 数量上限规则

- `sources` 数量、单卡 `relations` 数量不设 schema 错误；
- 超过建议值 12 时输出 warning；
- 是否真的限制，由真实图结构和使用数据决定。
```

- [ ] **Step 2: Commit**

```bash
git add .agent/reference/write-transaction.md
git commit -m "docs(agent): extract write transaction rules from AGENTS.md"
```

---

## Task 6: 创建 `.agent/reference/ingest-pipeline.md`

**Files:**
- Create: `.agent/reference/ingest-pipeline.md`

- [ ] **Step 1: 写入摄入流水线文档**

```markdown
---
scheme: "default"
version: "0.4.0"
updated: "2026-07-30"
---

# 文档摄入流水线

　　CLI 完整参数见 `.agent/reference/harness-cli.md`。本文档记录编排纪律与机制说明。

## 典型顺序

```bash
python -m nexogenesis compile --plan --root .    # 预览分波计划
python -m nexogenesis compile --root .           # 生成本波 prompt
# Agent 串行调用 LLM，保存 response 到 .nexogenesis/tmp/compile/batch-XXX-response.md
python -m nexogenesis compile --check-responses  # 落盘前检查
python -m nexogenesis compile --apply --root .   # 按文件部分成功写入 Buffer

python -m nexogenesis digest --plan --root .     # 预览本波 Buffer
python -m nexogenesis digest --root .            # 生成本波 digest prompt
# Agent 调用 LLM，保存 batch 到 .nexogenesis/tmp/digest/batch.yaml
python -m nexogenesis digest --apply --root .    # 写入 01-Cards/，标记 Buffer 为 digested
# 或：digest --auto

python -m nexogenesis construct --root .         # 默认：结构诊断
python -m nexogenesis construct --lens distinguish --root .
# Agent 保存 batch 到 .nexogenesis/tmp/construct/batch.yaml
python -m nexogenesis construct --apply --root . # 结构优化
# 或：construct --auto --lens <name>
```

## /compile

- 扫描 `00-Inbox/`（默认递归；`--no-recursive` 仅顶层）；源键为相对路径，归档保留子目录；
- 体裁预判：`book` / `paper` / `essay` / `dialogue` / `scrap` / `generic`；
- **阅读窗（Harness）+ 窗内切块（LLM）**：
  - 图书/长文：优先 PDF 目录小节或 Markdown `##`/`###` 开窗；有子节时跳过粗章；跳过封面/版权/目录等扉页书签；若 TOC 仅有前页，则从正文起始页起按页开窗；
  - 论文：有小标题则按节，否则少窗；
  - 对话：按话轮；scrap：段落堆叠；
  - 窗内产出 1～6 个有命名、含质料的 Buffer，块数由模型按内容定；
- 书默认一窗一 prompt，减少赶工薄片；
- LLM 输出极简 frontmatter（`title`/`role`/`source`）+ 自由充实正文；不强制四级槽；
- response 命名 `batch-XXX-response.md`；串行生成；`--strict-body` 拦过短/空正文。

## /digest

- 编排见 skill `nexo-digest`；语义见 `schemes/default/prompts/digest.txt`；
- 先消化、后建构；默认一波 `scratch`；
- 主职：骨架滋养 + 建立领域对象；enrich 优先，但遇到真正新、重要且可独立复用的质料时应果断新建 Card；
- 空库须先 domain；写法对齐 exemplars；
- 同步从 Buffer 中提取领域级立场、价值取向、推理模式与反模式，追加到 `02-Profile/`。

## /construct

- 编排见 skill `nexo-construct`；语义见 `schemes/default/prompts/construct.txt`；
- 主职：通盘考虑、合并、调整、升枢纽与张力——不是第二次消化，也不是继续大量新建 Card；
- 原则上不新建 Card；digest 阶段建立的对象由 construct 组织成更干净的结构；只有在通盘考虑后确实缺少枢纽时才允许新建，并须在 operation 中解释原因；
- 默认 diagnose；`--lens` 一次一镜；`--apply-seed-links` 勿当完成态；
- 若涌现出新的领域级理念或思维模型，使用 `target: profile_field` 更新 `02-Profile/`。

## 人机协作边界

- 默认命令只生成 prompt/batch，不自动写入卡片（须 `--apply` 或 `--auto` 二次通过自检）；
- 逐步模式：Agent 在 `--apply` 前检查产物，`operation.approved_by` 记 `user`；
- 自主模式：用户说「开始消化/建构」或显式 `--auto` = 本轮写入授权；Agent 自审中间产物并循环至自检通过；`approved_by` 通常为 `agent`；tmp 下 prompt/batch/报告一律保留供事后分析；
- 未经用户批准，不得把 `origin: system` 的产出直接标为 `mature` 或 `theory_status: active`。
```

- [ ] **Step 2: Commit**

```bash
git add .agent/reference/ingest-pipeline.md
git commit -m "docs(agent): extract ingest pipeline rules from AGENTS.md"
```

---

## Task 7: 重写思维体技能

**Files:**
- Modify: `.agent/skills/nexo-talk/SKILL.md`
- Modify: `.agent/skills/nexo-emerge/SKILL.md`
- Modify: `.agent/skills/nexo-judge/SKILL.md`

统一模板：
- frontmatter: `name`, `description`, `compatibility`
- `# Grounding`：按顺序必读文件
- `# Workflows`：具体步骤
- `# Invariants`：不可违背的纪律
- `# Anti-patterns`：禁止行为

- [ ] **Step 1: 重写 `nexo-talk/SKILL.md`**

```markdown
---
name: nexo-talk
description: |
  Nexogenesis 思维体默认对话：检索 + 短期记忆，区分 user/document/system/nascent 归因，
  把分析留在对话中，禁止自动写卡。当用户闲聊、要求分析/思考、说「聊聊」「想想」，
  或没有明确捕获/消化/建构意图时触发。
compatibility: Nexogenesis 项目，已初始化 .agent/reference/ 与 02-Profile/
---

# Grounding（按顺序必读）

1. `.agent/reference/constraint-layers.md` — 约束分层：宪法 / skill / reference / prompt。
2. `.agent/reference/thinking-body.md` — 思维体注意力设计。
3. `.agent/reference/retrieval-design.md` — 双轨检索与 Context Package 结构。
4. `02-Profile/领域理念.md` — 领域级立场与价值取向。
5. `02-Profile/领域思维范式.md` — 领域级推理模式与反模式。

# Workflows

1. 若无活跃 memory session：
   ```bash
   python -m nexogenesis memory start --title "<当前主题>" --root .
   ```
   或先 `python -m nexogenesis memory status --root .` 复用当前卷。
2. 根据用户问题执行双轨检索：
   ```bash
   python -m nexogenesis retrieve --query "<当前问题>" --mode talk --root .
   ```
3. 读取 Context Package：
   - 区分 `structure`（图子图）与 `material`（RAG 质料）；
   - 区分归因：`user` / `document` / `system` / `nascent`；
   - 把 `02-Profile/` 中的理念与思维模型作为透镜。
4. 回答用户：直接、有据；仅当存在 `theory_status: active` 的卡片时，方可声明「从 X 视角」。
5. 可选：若对话中出现值得追踪的焦点/张力/引用，追加到短期记忆：
   ```bash
   python -m nexogenesis memory update --focus "…" --cite "<card-id>" --tension "…" --root .
   ```
6. 强信号时（用户明显在表达一个值得沉淀的主张）可跑：
   ```bash
   python -m nexogenesis signal --text "<摘要>" --root .
   ```
   若 signal 建议捕获 → 轻问用户「是否记一下？」→ 用户同意则转 `nexo-emerge`。

# Invariants

- 分析默认留在对话；写入知识体必须另走 `nexo-emerge`。
- 对话路径禁止直接修改 `01-Cards/` 或以 `approved_by: agent` 写卡。
- 未标注 perspective 时，文档观点标 `document`，用户立场标 `user`，系统推断标 `system`，讨论质料标 `nascent`。
- 不扫全库卡片；依赖 `retrieve` + 索引视图。
- 用户说「先别记」→ 记入 STM `user_directives`，本会话关闭主动捕获。

# Anti-patterns

- 把对话中的临时分析自动写成 Card。
- 把 RAG 命中当成成熟主张直接复述为用户立场。
- 在不存在 `theory_status: active` 卡片时声称「从理论 X 视角」。
- 不读 Context Package 就空泛回答。
```

- [ ] **Step 2: 重写 `nexo-emerge/SKILL.md`**

```markdown
---
name: nexo-emerge
description: |
  Nexogenesis 捕获/涌现：从对话或 Buffer 中识别值得沉淀的思想，生成 ≤3 个候选，
  经用户确认后通过 write --batch 写入。当用户说「记一下」「/capture」「涌现」
  「这个值得记」时触发。
compatibility: Nexogenesis 项目，已初始化 .agent/reference/card-contracts/ 与 schemes/default/prompts/
---

# Grounding（按顺序必读）

1. `.agent/reference/constraint-layers.md` — 约束分层与写入权限。
2. `.agent/reference/card-contracts/body-structure.md` — 七型正文结构。
3. `.agent/reference/card-contracts/ontology.md` — 卡片类型与关系。
4. `.agent/reference/card-contracts/card-exemplars/` — 写法正例。
5. `.agent/reference/write-transaction.md` — `write --batch` 事务规则。
6. `schemes/default/prompts/digest.txt` — 当候选来自 Buffer 时参考消化语义。

# Workflows

1. 判断来源：
   - 来自用户对话 → `origin: user`；
   - 来自文档/Buffer → `origin: document` 或 `external`；
   - 来自系统推断 → `origin: system`。
2. 生成 ≤3 个候选卡片或 Profile 字段：
   - 明确 `id`、`title`、`type`、`domains`、`maturity`、`lifecycle`；
   - 一句话主张/核心思想不可复读标题；
   - 依据须有机制或事实。
3. 向用户展示候选，等待确认。禁止 `approved_by: agent` 直接落盘。
4. 用户确认后，写 `.nexogenesis/tmp/emerge/batch.yaml`：
   - `operation.approved_by: user`；
   - `operation.source` 注明对话/文档来源；
   - 列出 `writes`。
5. 自检：YAML 格式、无幽灵链接、必填字段齐全。
6. 执行：
   ```bash
   python -m nexogenesis write --batch .nexogenesis/tmp/emerge/batch.yaml --root .
   ```
7. 报告：写入几张卡、是否更新 Profile、是否有 conflict 待后续 construct 处理。

# Invariants

- 捕获永远用户确认；对话路径禁止自动写卡。
- 所有写入必须经 `write --batch`。
- `origin: system` 候选不得标 `mature` 或 `theory_status: active`。
- 新建卡片必须满足对应类型的必需语义槽。
- 若候选与已有 Card 近义，优先 enrich 而非新建。

# Anti-patterns

- 不确认就批量写卡。
- 把一句话碎片包装成多张卡。
- 把文档观点标为用户立场。
- 用「原文未提及」凑格式。
```

- [ ] **Step 3: 重写 `nexo-judge/SKILL.md`**

```markdown
---
name: nexo-judge
description: |
  Nexogenesis 深判：对复杂问题、冲突或决策进行多透镜分析，定位而非裁决。
  当用户说「深判」「/judge」「怎么判断」「评估一下」或要求多视角分析时触发。
compatibility: Nexogenesis 项目，已初始化 .agent/reference/ 与 02-Profile/
---

# Grounding（按顺序必读）

1. `.agent/reference/constraint-layers.md` — 约束分层与权限。
2. `.agent/reference/retrieval-design.md` — 双轨检索，尤其 judge 模式。
3. `.agent/reference/thinking-body.md` — 思维体注意力与会话纪律。
4. `02-Profile/领域理念.md` — 价值取向与反模式。
5. `02-Profile/领域思维范式.md` — 决策启发式与透镜。

# Workflows

1. 明确判断对象与用户关心的维度。
2. 执行检索：
   ```bash
   python -m nexogenesis retrieve --query "<判断对象>" --mode judge --root .
   ```
3. 选择 2–4 个透镜（如：证据强度、适用边界、学派立场、反事实、长期后果）。
4. 对每个透镜：
   - 说明该透镜关注什么；
   - 从 Context Package 中提取相关卡片/质料；
   - 给出定位：哪些证据支持、哪些削弱、哪些仍不确定。
5. 综合：不替用户裁决，而是给出「若接受 A，则需承担 X；若接受 B，则需解释 Y」的结构性结论。
6. 若涌现值得追踪的问题，追加到 `02-Profile/问题清单.md`（经用户确认后通过 write --batch）。

# Invariants

- 深判是「定位」不是「裁决」；最终判断权留给用户。
- 必须显式区分事实、推断与价值判断。
- 使用 `conflict` 卡和 `relations` 显化对立，而非模糊调和。
- 所有引用必须可追溯到 Card id 或 Buffer 路径。

# Anti-patterns

- 用平均化结论回避张力。
- 不读 Context 就给出判断。
- 把推断包装成事实。
- 自动把判断结论写成 `claim` 卡。
```

- [ ] **Step 4: Commit**

```bash
git add .agent/skills/nexo-talk/SKILL.md .agent/skills/nexo-emerge/SKILL.md .agent/skills/nexo-judge/SKILL.md
git commit -m "refactor(skills): rewrite thinking-body skills in PI-agent style"
```

---

## Task 8: 重写记忆体技能

**Files:**
- Modify: `.agent/skills/nexo-compile/SKILL.md`
- Modify: `.agent/skills/nexo-digest/SKILL.md`
- Modify: `.agent/skills/nexo-construct/SKILL.md`

- [ ] **Step 1: 重写 `nexo-compile/SKILL.md`**

```markdown
---
name: nexo-compile
description: |
  Nexogenesis 编译：把 00-Inbox/ 原始文档按体裁开窗切块，产出 05-Buffer/ 质料。
  当用户说「编译」「/compile」「处理 Inbox」或 00-Inbox/ 有新文档时触发。
compatibility: Nexogenesis 项目，已初始化 .agent/reference/ 与 schemes/default/prompts/
---

# Grounding（按顺序必读）

1. `.agent/reference/constraint-layers.md` — 约束分层。
2. `.agent/reference/ingest-pipeline.md` §compile — 编译纪律。
3. `.agent/reference/card-contracts/body-structure.md` §2 — Buffer 规范。
4. `schemes/default/prompts/compile-*.txt` — 各体裁编译 prompt。

# Workflows

1. 预览分波：
   ```bash
   python -m nexogenesis compile --plan --root .
   ```
2. 生成本波 prompt：
   ```bash
   python -m nexogenesis compile --root .
   ```
3. 串行调用 LLM，保存 response 到 `.nexogenesis/tmp/compile/batch-XXX-response.md`。
4. 检查 response 格式：
   ```bash
   python -m nexogenesis compile --check-responses --root .
   ```
5. 落盘到 Buffer：
   ```bash
   python -m nexogenesis compile --apply --root .
   ```
6. 报告：本波处理文档数、产出 Buffer 数、是否还需下一波。

# Invariants

- 职责：Harness 开窗与闸门；切几块、叫什么、保哪些机制与事实——属 LLM。
- 产出只到 Buffer，不创建/修改 Card 或 Profile。
- 跳过封面/版权/目录等扉页书签。
- 书默认一窗一 prompt，减少赶工薄片。
- `--strict-body` 必须拦截过短/空正文。

# Anti-patterns

- 把 compile 做成逐段转卡的批处理器。
- 手写脚本大修 response 格式。
- 在 compile 阶段就让 LLM 写 Card。
- 产出无命名、无质料的 Buffer。
```

- [ ] **Step 2: 重写 `nexo-digest/SKILL.md`**

```markdown
---
name: nexo-digest
description: |
  Nexogenesis 消化：读取 05-Buffer/ 中 scratch Buffer，enrich 已有卡片，
  并在真正新、重要且可独立复用时新建领域对象。当用户说「消化」「/digest」
  「开始消化」或 05-Buffer/ 中有 scratch 文件时触发。
compatibility: Nexogenesis 项目，已初始化 .agent/reference/ 与 schemes/default/prompts/
---

# Grounding（按顺序必读）

1. `.agent/reference/constraint-layers.md` — 约束分层与写入权限。
2. `.agent/reference/card-contracts/body-structure.md` — 七型正文结构。
3. `.agent/reference/card-contracts/ontology.md` — 卡片类型与关系。
4. `.agent/reference/card-contracts/card-exemplars/` — 写法正例。
5. `.agent/reference/ingest-pipeline.md` §digest — 消化纪律。
6. `.agent/reference/write-transaction.md` — `write --batch` 规则。
7. `schemes/default/prompts/digest.txt` — 消化语义 prompt。

# Workflows

1. 预览本波 Buffer：
   ```bash
   python -m nexogenesis digest --plan --root .
   ```
2. 生成本波 prompt：
   ```bash
   python -m nexogenesis digest --root .
   ```
3. 读取 `.nexogenesis/tmp/digest/prompt.md` 与必选参考文档。
4. 按 prompt 写 `.nexogenesis/tmp/digest/batch.yaml`：
   - `operation.approved_by: user`（除非用户已授权 `--auto`）；
   - `operation.consumed_buffers` 列出实际消费的 Buffer 路径；
   - 空库必须先写至少一张 `domain` 卡。
5. 自检：YAML 格式、必填字段、无幽灵链接、类型必需槽存在。
6. 应用：
   ```bash
   python -m nexogenesis digest --apply --root .
   ```
   或用户授权后：
   ```bash
   python -m nexogenesis digest --auto --root .
   ```
7. 报告：enrich / 新建 / skip / conflict / Profile 更新 各几条。

# Invariants

- 必须先有 domain 骨架，再挂实例卡。
- 所有写入必须经 `write --batch`。
- `origin: system` 未经用户批准不得标 `mature` 或 `theory_status: active`。
- enrich 优先；真正新、重要且可独立复用才新建。
- 消化阶段只做 enrich 与新建，大规模合并/升枢纽留给 `nexo-construct`。
- 从 Buffer 中提取领域级立场/价值取向/推理模式时，追加到 `02-Profile/`。

# Anti-patterns

- 把 ingest 做成切书批处理器。
- 用「原文未提及」/标题回声凑格式。
- 在消化阶段绕过 `write --batch` 直接改卡。
- 把 RAG/discussion 命中直接写入 relations 或新建 Card。
- 为每片 Buffer 强制建一张卡。
```

- [ ] **Step 3: 重写 `nexo-construct/SKILL.md`**

```markdown
---
name: nexo-construct
description: |
  Nexogenesis 建构：通盘诊断卡片网络，发现冗余/分裂/张力，通过单镜头操作优化结构。
  当用户说「建构」「/construct」「结构校准」或 digest 后图结构需要清理时触发。
compatibility: Nexogenesis 项目，已初始化 .agent/reference/ 与 schemes/default/prompts/
---

# Grounding（按顺序必读）

1. `.agent/reference/constraint-layers.md` — 约束分层。
2. `.agent/reference/card-contracts/ontology.md` — 卡片类型与关系。
3. `.agent/reference/card-contracts/body-structure.md` — 正文结构。
4. `.agent/reference/ingest-pipeline.md` §construct — 建构纪律。
5. `.agent/reference/write-transaction.md` — `write --batch` 规则。
6. `schemes/default/prompts/construct.txt` — 建构语义 prompt。
7. `schemes/default/prompts/construct-diagnose.txt` — 诊断 prompt。

# Workflows

1. 默认诊断：
   ```bash
   python -m nexogenesis construct --root .
   ```
   生成 `lenses-report.md`、`suggested-lenses.txt`、`structure-ops-draft.md`。
2. 与用户确认镜头（或用户已授权则按 suggested 逐镜处理）。
3. 单镜头执行，禁止 `all`：
   ```bash
   python -m nexogenesis construct --lens cluster --root .
   # 或 distinguish / articulate / cross_source
   ```
4. 写 `.nexogenesis/tmp/construct/batch.yaml`。
5. 自检后 apply：
   ```bash
   python -m nexogenesis construct --apply --root .
   ```
   或：
   ```bash
   python -m nexogenesis construct --auto --lens <name> --root .
   ```
6. 需要空边挂 domain 时：
   ```bash
   python -m nexogenesis construct --apply-seed-links --root .
   ```
   勿把挂靠边当完成态。
7. 报告：合并 / 升格枢纽 / 补 conflict / 补语义边 / Profile 更新 各几条。

# Invariants

- 主职：通盘考虑、合并、调整、升枢纽与张力。
- 原则上不新建 Card；确实缺少枢纽时须在 operation 中解释原因。
- 禁止物理删除卡片，只用 `lifecycle: superseded`/`archived`。
- 禁止读完全库 Buffer 重建目录。
- 涌现新的领域级理念/思维模型时，追加到 `02-Profile/`。

# Anti-patterns

- 把建构当第二次消化继续大量新建 Card。
- 不做诊断直接 apply。
- 一次使用多个 lens（`--lens all`）。
- 把 seed-links 当成完整关系网。
- 删除卡片而不是标记 superseded。
```

- [ ] **Step 4: Commit**

```bash
git add .agent/skills/nexo-compile/SKILL.md .agent/skills/nexo-digest/SKILL.md .agent/skills/nexo-construct/SKILL.md
git commit -m "refactor(skills): rewrite memory-body skills in PI-agent style"
```

---

## Task 9: 重写 `AGENTS.md` 为宪法层

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 写入新的 AGENTS.md**

```markdown
# AGENTS.md — Nexogenesis P0 运行时契约

> 版本：P0（2026-07-30 约束分层）
> 作用：宪法层——底座主权、权限分层、类型一览、.agent/ 索引。修订须经用户确认。
> 约束分层：`.agent/reference/constraint-layers.md`

---

## 一、核心原则

1. **底座主权不变量**：约定目录下的 markdown 是唯一语义事实之源。删除全部代码与可重建索引，只留 markdown，知识内容零损失。
2. **社科领域思想结构化**：用大模型做社科领域思想的意义聚合与知识结构涌现，沉淀可支撑推理、分析、判断的领域知识体；不是切书批处理器，也不是读书笔记系统。
3. **双层结构：知识体 + 思维体**：`01-Cards/` 与 `05-Buffer/` 构成知识体；`nexo-talk|emerge|judge` 等思维体利用该结构进行推理、分析与判断。
4. **Harness 负责过程，LLM 负责语义**：卡片校验、原子写入、索引生成、孤儿检测由 Harness 强制执行；内容好坏、冲突识别、新建/丰富/skip 由 LLM 负责。
5. **统一写入入口**：任何实质写入必须通过 `python -m nexogenesis write --batch <file>`。
6. **写路径优先**：优先降低高质量内容进入底座的摩擦，而非美化检索界面。
7. **复杂度必须有证据**：新增类型、关系、视图、自动化必须说明真实摩擦、最小改动、判断标准和撤回方式。
8. **P0 不是完整 Harness**：P0 实现结构约束层与最小原子写入事务；完整编排层延至 P1/P2。

## 二、目录结构

```text
AGENTS.md                              # 本手册（宪法）
README.md                              # 项目说明
.agent/
├── skills/                            # 编排技能（思维体 + 记忆体）
├── reference/                         # 活契约
│   ├── card-contracts/                # 卡片规范与正例
│   ├── harness-cli.md                 # CLI 参考
│   ├── write-transaction.md           # 写入事务规则
│   ├── ingest-pipeline.md             # 摄入流水线纪律
│   ├── retrieval-design.md            # 双轨检索设计
│   ├── thinking-body.md               # 思维体注意力设计
│   └── constraint-layers.md           # 约束分层说明
└── specs/                             # 设计决策与迭代记录
01-Cards/                              # 知识卡片
02-Profile/                            # 领域级思考特质档案
03-Archive/                            # 已处理原始材料
04-OutBox/                             # 分析产物
05-Buffer/<role>/                      # compile 产出的质料
06-Journal/                            # 操作大事记
nexogenesis/                           # Python 包
schemes/default/                       # 默认沉淀方案
```

## 三、权限分层

- 宪法：`AGENTS.md`
- 编排技能：`.agent/skills/`
- 活契约：`.agent/reference/`
- 设计决策：`docs/specs/`
- 提示语义：`schemes/default/prompts/`

统一写入入口：`python -m nexogenesis write --batch <file>`。
`origin: system` 的卡片未经用户批准不能进入 `mature` 或 `theory_status: active`。

## 四、Skill 索引

| Skill | 触发条件 | 主职 |
|---|---|---|
| `nexo-talk` | 日常对话、分析、思考 | 检索 + STM，归因，分析留对话，不自动写卡 |
| `nexo-emerge` | 「记一下」「/capture」「涌现」 | ≤3 候选 → 用户确认 → write --batch |
| `nexo-judge` | 「深判」「/judge」 | 2–4 透镜，定位而非裁决 |
| `nexo-compile` | 「编译」「/compile」 | Inbox → Buffer |
| `nexo-digest` | 「消化」「/digest」 | Buffer → Card（enrich + 新建） |
| `nexo-construct` | 「建构」「/construct」 | 结构诊断、合并、升枢纽、张力 |

## 五、Reference 索引

| 文档 | 职责 |
|---|---|
| `.agent/reference/card-contracts/body-structure.md` | Buffer / Card 正文结构契约 |
| `.agent/reference/card-contracts/ontology.md` | 卡片类型与关系类型契约 |
| `.agent/reference/card-contracts/card-exemplars/` | 七型写法正例 |
| `.agent/reference/harness-cli.md` | CLI 命令速查表与参数详解 |
| `.agent/reference/write-transaction.md` | `write --batch` 事务规则 |
| `.agent/reference/ingest-pipeline.md` | compile → digest → construct 纪律 |
| `.agent/reference/retrieval-design.md` | 图 + RAG 双轨检索设计 |
| `.agent/reference/thinking-body.md` | 思维体注意力设计 |
| `.agent/reference/constraint-layers.md` | 约束分层说明 |

## 六、Spec 索引

| 文档 | 职责 |
|---|---|
| `docs/specs/2026-07-30-agents-refactor-design.md` | 本次重构设计 |
| `docs/specs/p0-p1-remaining.md` | P0/P1 剩余项 |

## 七、P0 验收标准

1. 用户能完成 10–20 次真实对话；
2. 重复 `/capture` 不产生重复卡片；
3. 被驳回候选不进入知识库；
4. 修改卡片内容不改变其 ID；
5. 删除全部生成索引后可一致重建；
6. `origin: system` 未经批准不进入 `mature`/`theory_status: active`；
7. git hook 已安装并在提交时运行。

## 八、AI 禁止与必须

### 禁止

- 把 ingest 做成「切书批处理器」。
- 用空心「原文未提及」/标题回声凑格式。
- 绕过 `write --batch` 直接改卡片文件。
- 创建信息稀薄的空卡片。
- 为每篇文档都创建新卡片。
- 在 Inbox 中堆积已处理原始文档。
- 未经用户确认改写 `02-Profile/` 已有条目。
- 删除任何卡片（只能标记 `lifecycle: superseded`/`archived`）。
- 创建幽灵链接。
- 让卡片因无限引用而膨胀。

### 必须

- 以聚合涌现为目标：少而厚的质料 → 可独立阅读的卡片结构。
- 优先丰富已有卡片，而非新建卡片。
- 检测并记录冲突。
- 维护领域卡片的完整性。
- 主动沉淀领域级理念与思维模型到 `02-Profile/`，并标注来源。
- 处理完后归档原始文档。
- 所有 AI 生成的内容标注来源。
- 任何写入须经授权：逐步确认，或用户一句「开始消化/建构」/`--auto` 视为本轮授权。
```

- [ ] **Step 2: 检查行数**

```bash
wc -l AGENTS.md
```

Expected: ≤ 200 行。

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "refactor(agent): rewrite AGENTS.md as constitution layer with indexes"
```

---

## Task 10: 更新 `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新目录索引**

把 README.md 中指向 `01-Cards/_meta/` 的卡片契约链接改为 `.agent/reference/card-contracts/`；
把指向 `docs/` 的设计文档链接改为 `.agent/reference/` 或 `docs/specs/`。

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README.md to reflect new .agent/ structure"
```

---

## Task 11: 最终验证与清理

**Files:**
- Delete: `docs/` 中已迁移的文档（可选，建议保留到下一次提交作为备份）

- [ ] **Step 1: 运行 validate**

```bash
.venv/Scripts/python -m nexogenesis validate --root .
```

Expected: `Validation passed.`

- [ ] **Step 2: 检查 01-Cards/_meta/ 只保留自动生成索引**

```bash
ls 01-Cards/_meta/
```

Expected: 仅 `domain-index.md`、`conflict-index.md`、`theory-index.md`。

- [ ] **Step 3: 检查 .agent/ 结构**

```bash
find .agent -maxdepth 3 -type f | sort
```

Expected: 显示 `.agent/reference/...`、`.agent/skills/.../SKILL.md`、`docs/specs/...`。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(agent): final validation and cleanup for agent architecture refactor"
```

---

## 验证清单

- [ ] `AGENTS.md` ≤ 200 行。
- [ ] 6 个 skill 都包含 Grounding、Workflows、Invariants、Anti-patterns 四段。
- [ ] `01-Cards/_meta/` 不再包含 `body-structure.md`、`ontology.md`、`card-exemplars/`。
- [ ] `.agent/reference/` 包含所有活契约。
- [ ] `docs/specs/` 包含本次设计与 `p0-p1-remaining.md`。
- [ ] `python -m nexogenesis validate --root .` 通过。
- [ ] `README.md` 索引已更新。
