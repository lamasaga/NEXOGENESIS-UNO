---
name: nexo-refine
description: |
  Nexogenesis 卡片精修：围绕一张既有知识卡讨论、澄清和润色，展示修改意图，经用户确认后原子写入。
  当用户说「精修卡片」「润色这张卡」「修订知识卡」「/refine」时触发。
compatibility: Nexogenesis DSH，已初始化卡片契约与 HarnessGateway
---

# Grounding

1. `.agent/reference/card-contracts/body-structure.md` — 目标卡类型的正文结构。
2. `.agent/reference/write-transaction.md` — 单层事务与修订冲突。
3. `.agent/reference/thinking-output-contract.md` — 证据等级、差异说明与确认状态。

# Workflow

1. 确认目标卡片 id；必须调用 `read_card` 读取当前全文。
2. 从用户要求判断本轮是语言澄清、结构整理、证据补充还是语义修订。目标和改法已经明确就直接准备差异与提案，不重复请求同一授权；只有影响原意的信息不足时先讨论。若语义变动涉及外部事实或其他卡，先检索、精读或追溯来源。当前只读分析 Run 先完成或说明停止，再进入精修；不改其预算绕过边界。
3. 修改时保持卡片身份、类型、来源归因与创建时间；新增事实必须有可追溯来源，不得把系统推断伪装成原文。
4. 精修前读取并保留已有 `<!-- unit: ... -->` 地址；只有地址所指语义被删除、拆分或彻底改写时才调整，并在差异清单中明确说明。对新形成且会被 OPS 反复精读的核心判断、机制、条件、证据或边界，可以补充稳定地址，但不要给普通段落机械编号。
5. 在自然语言中用差异清单说明保留、澄清、新增与删除；每项语义变化说明依据。再调用 `propose_write(layer="content")`，优先使用 `mode:"enrich" + replace_sections/append_sections`，避免重传未修改的长正文。关系变更必须先用 `inspect_argument` 或 `compare_cards` 核对，并改走独立的 `propose_relation_patch`；领域变更改走 membership 操作。只有用户要修正知识对象类型，且已核对新类型语义槽与双向关系时，才使用 `propose_card_reclassification`；这些变化均不得夹带在 content 精修中。
6. 等待用户在界面确认；取消后不得自动重提同一版本。

# Invariants

- 只能精修已存在且本轮已读的单张卡；新建卡应转 `nexo-emerge`。
- 纯语言润色不得偷偷改变主张、成熟度、来源或关系。
- 不删除卡片；需要退出使用时只能提出 lifecycle 变更并说明理由。
- 确认卡是唯一的写入等待入口；如果界面没有实际生成确认卡，不得在文字中宣称“等待点击确认”。
