# Nexogenesis AGENTS.md 与 Skill 体系重构设计

> 版本：2026-07-30  
> 状态：待实现  
> 关联：AGENTS.md、.agent/、01-Cards/_meta/、docs/

---

## 一、背景与问题

当前 `AGENTS.md` 已膨胀至 546 行，同时承担「宪法层」与「操作手册」两种角色：

- 宪法层内容：核心原则、目录结构、权限分层、P0 验收标准、AI 禁止与必须。
- 操作手册内容：CLI 完整参数表、`write --batch` 事务细节、compile/digest/construct 详细纪律、双轨检索细节、卡片规范全文。

这导致：

1. 每次加载 `AGENTS.md` 都带入大量本回合用不到的细节，token 效率低。
2. 操作纪律重复出现在 `AGENTS.md` 与 `.agent/skills/*` 中，修订时容易遗漏。
3. `.agent/skills/` 中每个 skill 只有 40–50 行步骤清单，缺少 PI agent 风格的 Grounding、Workflows、Invariants、Anti-patterns，难以约束模型行为。
4. `docs/` 目录被用作临时设计文档堆叠，`01-Cards/_meta/` 同时承载卡片契约与自动生成索引，职责混杂。

参考 [romiluz13/pi-agent-skills](https://github.com/romiluz13/pi-agent-skills) 的 `pi-cli-workspace` skill：每个 skill 是一份自包含的手册，frontmatter 描述触发条件，正文分 Grounding、Invariants、Workflows、Anti-patterns，引用具体源文件路径。

---

## 二、目标

1. 把 `AGENTS.md` 压缩为真正的宪法层（约 150 行）。
2. 建立 `.agent/` 内部三级结构：
   - `.agent/skills/`：PI agent 风格的编排技能。
   - `.agent/reference/`：活契约（卡片规范、CLI 参考、摄入纪律、检索设计）。
   - `docs/specs/`：设计决策与迭代记录。
3. 把 `01-Cards/_meta/` 中的卡片契约迁入 `.agent/reference/card-contracts/`，`01-Cards/_meta/` 只保留自动生成的索引。
4. 把 `docs/` 中仍有效的活契约迁入 `.agent/reference/`，把版本迭代记录迁入 `docs/specs/`。
5. 重写 6 个 skill，使其足够厚实，能独立指导模型完成对应任务。

---

## 三、新目录结构

```text
AGENTS.md                              # 宪法层 + .agent/ 索引
README.md                              # 项目说明（同步更新索引）
.agent/
├── skills/                            # 编排技能
│   ├── nexo-talk/SKILL.md
│   ├── nexo-emerge/SKILL.md
│   ├── nexo-judge/SKILL.md
│   ├── nexo-compile/SKILL.md
│   ├── nexo-digest/SKILL.md
│   └── nexo-construct/SKILL.md
├── reference/                         # 活契约
│   ├── card-contracts/
│   │   ├── body-structure.md
│   │   ├── ontology.md
│   │   └── card-exemplars/
│   │       ├── README.md
│   │       └── ...
│   ├── harness-cli.md                 # CLI 速查表 + 参数详解
│   ├── write-transaction.md           # write --batch 事务规则
│   ├── ingest-pipeline.md             # compile → digest → construct 纪律
│   ├── retrieval-design.md            # 图 + RAG 双轨设计
│   ├── thinking-body.md               # 思维体注意力设计
│   └── constraint-layers.md           # 约束分层说明
└── specs/                             # 设计决策与迭代记录
    ├── 2026-07-30-agents-refactor-design.md
    └── p0-p1-remaining.md
01-Cards/_meta/                        # 只保留自动生成索引
├── domain-index.md
├── conflict-index.md
└── theory-index.md
```

`docs/` 目录在本次重构后仅保留尚未处理的临时草案，后续逐步清理或迁移到 `docs/specs/`。

---

## 四、AGENTS.md 新结构

1. **版本与作用**：一句话说明这是宪法层，修订须经用户确认。
2. **核心原则**：保留现有 8 条。
3. **目录结构**：新结构图。
4. **权限分层**：统一写入入口、`origin: system` 限制、`write --batch` 事务一句话说明。
5. **Skill 索引**：6 个 skill 名称 + 一句话描述 + 触发条件。
6. **Reference 索引**：活契约列表 + 每份文档一句话职责。
7. **Spec 索引**：设计决策列表。
8. **P0 验收标准**：精简为 5–7 条核心指标。
9. **AI 禁止与必须**：保留现有清单。

所有需要展开的细节都通过链接指向 `.agent/reference/` 或 `.agent/skills/`。

---

## 五、Skill 统一模板

每个 skill 采用 PI agent 风格，结构如下：

```markdown
---
name: nexo-digest
description: |
  当用户说「消化」「/digest」「开始消化」，或 05-Buffer/ 中存在 status: scratch 的 Buffer 时触发。
  负责读取本波 scratch Buffer， enrich 已有卡片，并在真正新、重要且可独立复用时新建领域对象。
compatibility: Nexogenesis 项目，已初始化 .agent/reference/ 与 schemes/default/prompts/
---

# Grounding（按顺序必读）

1. `.agent/reference/card-contracts/body-structure.md` — 正文结构契约。
2. `.agent/reference/card-contracts/card-exemplars/` — 七型写法正例。
3. `.agent/reference/ingest-pipeline.md` §digest — 消化阶段纪律。
4. `schemes/default/prompts/digest.txt` — 消化语义提示。

# Workflows

1. `python -m nexogenesis digest --plan --root .` 预览本波 Buffer。
2. `python -m nexogenesis digest --root .` 生成本波 prompt。
3. 按 prompt 写 `.nexogenesis/tmp/digest/batch.yaml`。
4. 自检：YAML 格式、必需字段、consumed_buffers、无幽灵链接。
5. `python -m nexogenesis digest --apply --root .` 落盘。
6. 简短报告 enrich / 新建 / skip / Profile 更新数量。

# Invariants

- 必须先有 domain 骨架，再挂实例卡。
- 所有写入必须经 `write --batch`。
- `origin: system` 未经用户批准不得标 `mature` 或 `theory_status: active`。
- 消化阶段只做 enrich 与新建，大规模合并/升枢纽留给 `nexo-construct`。

# Anti-patterns

- 把 ingest 做成切书批处理器。
- 用「原文未提及」/标题回声凑格式。
- 在消化阶段绕过 `write --batch` 直接改卡。
- 把 RAG/discussion 命中直接写入 relations。
```

6 个 skill 都按此模板重写，其中 `nexo-talk`、`nexo-emerge`、`nexo-judge` 归入「思维体」，强调归因与不自动写卡；`nexo-compile`、`nexo-digest`、`nexo-construct` 归入「记忆体」，强调摄入流水线纪律。

---

## 六、Reference 文档清单

| 文档 | 来源 | 职责 |
|---|---|---|
| `.agent/reference/card-contracts/body-structure.md` | `01-Cards/_meta/body-structure.md` | Buffer / Card 正文结构活契约。 |
| `.agent/reference/card-contracts/ontology.md` | `01-Cards/_meta/ontology.md` | 卡片类型与关系类型契约。 |
| `.agent/reference/card-contracts/card-exemplars/` | `01-Cards/_meta/card-exemplars/` | 七型写法正例。 |
| `.agent/reference/harness-cli.md` | 提取自 `AGENTS.md` §5 | CLI 命令速查表与参数详解。 |
| `.agent/reference/write-transaction.md` | 提取自 `AGENTS.md` §5.1–5.3 | `write --batch` 事务流程、写入安全、数量上限规则。 |
| `.agent/reference/ingest-pipeline.md` | 提取自 `AGENTS.md` §8 | compile / digest / construct 编排纪律与人机协作边界。 |
| `.agent/reference/retrieval-design.md` | `.agent/reference/retrieval-design.md` | 图 + RAG 双轨检索设计。 |
| `.agent/reference/thinking-body.md` | `.agent/reference/thinking-body.md` | 思维体注意力与会话设计。 |
| `.agent/reference/constraint-layers.md` | `.agent/reference/constraint-layers.md` | 约束分层：宪法 / skill / reference / prompt。 |

---

## 七、Spec 文档清单

| 文档 | 来源 | 职责 |
|---|---|---|
| `docs/specs/2026-07-30-agents-refactor-design.md` | 本次新建 | 本重构设计。 |
| `docs/specs/p0-p1-remaining.md` | `docs/specs/p0-p1-remaining.md` | P0/P1 剩余项与进度。 |

后续新设计 spec 都写入 `docs/specs/YYYY-MM-DD-<topic>-design.md`。

---

## 八、迁移动作

1. 在 `.agent/` 下新建 `reference/`、`reference/card-contracts/`、`specs/`。
2. 迁移 `01-Cards/_meta/` 中的卡片契约：
   - `body-structure.md` → `.agent/reference/card-contracts/body-structure.md`
   - `ontology.md` → `.agent/reference/card-contracts/ontology.md`
   - `card-exemplars/` → `.agent/reference/card-contracts/card-exemplars/`
3. 迁移 `docs/` 中活契约：
   - `2026-07-27-retrieval-graph-rag-design.md` → `.agent/reference/retrieval-design.md`
   - `2026-07-28-thinking-body-attention-design.md` → `.agent/reference/thinking-body.md`
   - `2026-07-30-constraint-layers.md` → `.agent/reference/constraint-layers.md`
4. 迁移 `docs/` 中迭代记录：
   - `2026-07-29-p0-p1-remaining.md` → `docs/specs/p0-p1-remaining.md`
5. 从 `AGENTS.md` 提取并新建：
   - `.agent/reference/harness-cli.md`
   - `.agent/reference/write-transaction.md`
   - `.agent/reference/ingest-pipeline.md`
6. 重写 6 个 skill：`nexo-talk`、`nexo-emerge`、`nexo-judge`、`nexo-compile`、`nexo-digest`、`nexo-construct`。
7. 重写 `AGENTS.md` 为宪法层 + 索引。
8. 更新 `README.md` 中的目录索引。
9. 更新 `01-Cards/_meta/` 中所有指向旧路径的链接。
10. 运行 `python -m nexogenesis validate --root .` 确保无幽灵链接。

---

## 九、验证方式

1. `AGENTS.md` 行数降至 200 行以内。
2. `.agent/skills/*.md` 每个 skill 都包含 Grounding、Workflows、Invariants、Anti-patterns 四段。
3. `python -m nexogenesis validate --root .` 通过。
4. 所有迁移后的 reference/spec 文档路径在 `AGENTS.md` 中有索引。
5. `01-Cards/_meta/` 不再包含 `body-structure.md`、`ontology.md`、`card-exemplars/`。

---

## 十、后续步骤

1. 用户审阅本 spec。
2. 调用 `writing-plans` skill 生成实现计划。
3. 按实现计划分步迁移、重写、验证。
4. 保留旧文件直到验证通过，再删除 `docs/` 中已迁移的文档（本次不立即删除 `docs/`，仅迁移并保留原文件作为备份）。
