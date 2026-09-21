---
scheme: "default"
version: "2.0.0"
updated: "2026-09-18"
---

# 当前元结构契约

知识卡分类只有两个现行字段：

- `type`：有序单主类型，严格按 `conflict/entity/case/concept/method/mechanism/model/claim/phenomenon/undetermined` 顺序判定，取第一个满足全部最低条件的类型；
- `domains`：零到三个既有领域 ID，表示跨材料、长期成立的知识问题空间归属。

新卡不得写 `tags/topics`。历史字段只读兼容，不参与新卡写入、筛选、审核或领域成员计算。领域定义位于 `01-Cards/_meta/domains/*.md`；卡片自身 `domains` 是成员归属的唯一事实源，领域记录的 `representative_card_ids` 只是代表入口。

九种实质类型、未定、正文骨架、正反例和审核标准见：

- `docs/design/knowledge-guidance/card-types.md`
- `.agent/reference/card-contracts/body-structure.md`
- `docs/design/book-compile-examples.md`

领域索引不是知识卡类型；旧 `type: domain` 只作历史读取兼容。编译只能从任务冻结的领域目录中选择；没有合适领域时保存 `domains: []` 并进入未组织池，不能在制卡响应中自行发明。领域治理检查点可提出新领域。默认模式下，提案经用户逐项确认后才成为正式知识；本次编译显式采用 `domain_approval_mode: automatic` 时，合规提案可自动批准。两种模式都必须由 `HarnessGateway.applyDomainGovernance` 原子创建领域并挂靠成员。

## 当前可写关系

新编译与新建构只写以下七类关系。完整定义、方向、正反例和边界见 `docs/design/knowledge-guidance/relations.md`。

| 关系 | 方向 | 用途 |
|---|---|---|
| `specialization` 细分 | 一般对象 → 更具体类型 | 表示下位对象确实是上位对象的一种 |
| `supplement` 补充 | 补充内容 → 被补充对象 | 补回条件、过程、维度或必要细节 |
| `contrast` 对照 | 对称，保存一次 | 在明确维度上比较差异，不冒充冲突 |
| `challenge` 质疑 | 质疑内容 → 被质疑对象 | 保存针对同一主张或适用范围的异议、限制或反例 |
| `analogy` 类比 | 对称，保存一次 | 在保留关键差异时提供结构或过程类比 |
| `example` 例证 | 案例 → 被阐释内容 | 记录案例在材料中的说明用途，不自动提供证明力 |
| `application` 应用 | 方法或模型 → 使用情境/案例 | 区分实际使用与作者建议的使用场景 |

每条关系必须有 `note`，说明关系为什么成立、方向如何理解以及必要边界；`basis` 只能是 `source` 或 `navigation`。共同领域、共同词语、同书出现或视觉连通需要都不是关系证据。不确定就不连边，关系为空不是质量问题。

旧卡中的 `supports/based-on/extends/example-of/conflicts-with/involves/part-of/applies-to/influences/precedes/characterizes/attributed-to` 等关系保留原样读取，不因本契约自动改写。它们属于历史知识实例的兼容语义，不能由 v3 编译提示词或当前建构写入。若以后迁移，必须生成预览并逐批审核，不能按名称机械映射。

## 结构涌现

- 聚类：写入或调整 `domains`，领域成员由卡片字段反向生成；
- 区分：需要保存争议时使用 `type: conflict`；具体关系仍从七类中依据两端正文选择；
- 衔接：优先建立有明确阅读价值的关系；关系不足以承载完整新知识时，新建合适 `type` 的普通卡片。

## 领域索引生成规则

从所有卡片的 `domains` 字段反向生成。领域记录只保存定义、边界、父领域和代表卡入口，不维护第二份完整成员清单。

正式领域至少包含 `id/title/summary/core_questions/includes/excludes/parents/representative_card_ids/lifecycle`。可选正文保留深入说明；`relations` 仅使用 adjacent/contrast/bridge，必须注明 note/use_when/limits，basis 固定为 navigation。领域说明、示例与 Gateway 约束见[领域契约](../../../docs/design/knowledge-guidance/domains.md)。未组织项和提案保存在 `.nexogenesis/domain-governance/`，可从 Markdown 重建，不参与检索事实或卡片分类。

## 卡片命名规则

- 新建卡片的 `id` 使用安全、稳定、能表达知识对象的短名；已有卡修订时保持原 id。
- `title` 可以比 `id` 更完整，但二者应表达同一知识对象。
- 不用书名、章节名、作者名或临时工作编号代替知识对象名称。
