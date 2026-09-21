---
scheme: "default"
version: "2.0.0"
updated: "2026-09-17"
---

# HarnessGateway 事务规则

> 当前图书编译、建构与普通知识写入共享 HarnessGateway 写入权威，使用各自的任务契约。下文的单层 proposal 适用于普通知识写入；图书编译与 Web 建构使用对应 UNO 方法，不经过旧消化结算。

  `HarnessGateway` 是 DSH 的唯一知识体写入权威。Web handler、Skill、Thinking Model、GraphOp 和模型工具只能提交候选，不能直接调用文件写入原语。ORG 的 `python -m nexogenesis write --batch` 是迁移来源契约，不是当前 DSH 的运行时依赖。

## 写入阶段

1. 模型提交一个明确 `layer` 的 1–3 个原子操作；
2. Gateway 展开允许的正文补丁，并校验卡片字段；
3. 校验唯一主类型、零到三个既有领域、关系类型、源/目标类型签名与新关系就绪度；Creation 同时校验九种实质类型或未定的语义槽、来源、占位与枚举；
4. 比较现有卡与候选，拒绝跨层夹带字段；Content 不能新增质量缺口；
5. 保存每张目标卡的修订指纹，生成待确认 proposal；
6. 用户确认时重新预检并检查修订冲突；
7. 整批写入成功后追加 Journal 与写入收据；任何卡提交失败则恢复整批原文件；
8. 把提交、拒绝、冲突或取消 Receipt 及受影响卡的质量观察回送原 CognitiveRun / DSH session。

## 变更层闭集

| layer | 已有卡允许变化 | 用途 |
|---|---|---|
| `content` | `title`、`body` | 正文语义槽丰富或改写 |
| `relation` | `relations` | 关系专用操作 |
| `membership` | `domains` | 领域成员迁移 |
| `lifecycle` | `lifecycle` | 退役或归档 |
| `sources` | `sources` | 来源专用修订 |
| `origin` | `origin` | 来源类型专用修订；用于把历史书名、材料名等错误值迁回 `document` / `external` / `user` / `system` |
| `maturity` | `maturity` | 成熟度专用修订 |
| `reclassification` | `type`、与新类型匹配的 `body`，可选 `title` 与实体专属元数据 | 已有卡知识对象类型校准；只能由专用工具生成 |
| `creation` | 完整新对象 | 新建卡；不得与已有卡 enrich 混批 |

  `updated` 是提交元数据，不计作语义层变化。新卡必须使用 `creation`；已有卡若修改了当前 layer 之外的字段，Gateway 返回 `cross_layer_mutation`，并给出两个以内合法替代动作。


  `relation` 层优先由 `propose_relation_patch` 生成：模型只提交来源 id、目标 id、关系类型、动作与 note，工具读取磁盘中的最新完整 Card 并生成单层候选。当前新写关系只能是 `specialization/supplement/contrast/challenge/analogy/example/application`，并必须说明成立理由、方向和必要边界；`basis` 区分来源明示与整理导航。存量旧关系不会阻断未触及它的正文或来源修改，但不能由新任务继续复制或新建。

  `reclassification` 只由 `propose_card_reclassification` 生成。工具保留领域、来源、关系、成熟度、生命周期与通用元数据，要求模型按新类型提交完整语义槽；转入实体时必须给出 `entity_kind`，离开实体时自动移除实体专属标注。Gateway 同时校验本卡出边和其他卡指向本卡的入边，因此不能用改类型绕过关系签名。普通 `propose_write` 不接受此 layer。

## 授权与微变更

- 一次 proposal 最多三个紧密相关操作；同一 CognitiveRun 可以连续提出多个 proposal。
- 读取、索引和模拟可以自动进行；知识体写入必须有本轮授权并经过确认界面。
- 用户确认不是任务结束。提交收据回流后，Agent 应重新观察影响范围，再决定继续或停止。
- 用户拒绝不是流程错误。Agent 应吸收方向、修订候选、继续只读或有证据地停止。

## 图书编译与建构

图书编译使用 `book_save_cards` 提交候选。来源引用绑定已实际读取的授权单元；修改已有卡需提供读回的修订号。一次提交校验整批内容和关系，成功操作号原样重试返回原收据，改变内容须使用新号。原文、阅读状态与失败收据不等于正式知识卡。

新建编译卡必须使用单一 `type` 与 `domains`；`domains` 只引用当前任务冻结的领域目录，最多三个，空数组可保存为组织待办。`tags/topics` 会被新版编译拒绝。领域目录变化时拒绝旧快照写入，要求重新选择；领域成员以卡片自身字段为准。

领域治理使用 `HarnessGateway.applyDomainGovernance`。一次确认把正式领域记录与全部首批成员的 `domains` 作为同一 revision-checked 幂等事务；任一卡片或相关领域版本变化时整批拒绝，不允许出现“领域已建但成员未挂靠”的中间状态。该事务只修改领域记录和成员归属，不夹带正文、关系、来源或主类型变更。

Web 建构继续采用当前草稿、独立审核与发布契约。发布前检查目标当前版本、退役保护与关系依赖，部分提交保留明确收据和未完成内容，不以重复重放替代恢复。

旧 Buffer 写入、来源归档、主题矩阵和消化贡献结算已退役。历史知识文件与记录保留可读；不能通过旧提案确认、恢复或普通会话再次执行。

## 失败收据

  Harness Receipt 必须包含稳定 `reason_code`、简短原因、影响范围、修订信息和最多两个合法替代动作。不得把失败的完整卡片正文、整批上下文或重复提示重新灌回模型。
