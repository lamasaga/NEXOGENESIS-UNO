# AGENTS.md — Nexogenesis DSH 运行规则

> 核对日期：2026-08-25
> 作用：宪法层——底座主权、权限分层、.agent/ 索引。修订须经用户确认。
> 约束分层：`.agent/reference/constraint-layers.md`

---

## 一、核心原则

1. **底座主权不变量**：约定目录下的 **markdown 是唯一语义事实之源**。删除全部代码与可重建索引，只留 markdown，知识内容零损失。
2. **学科领域思想结构化**：用大模型做**社科领域思想的意义聚合与知识结构涌现**，沉淀可支撑推理、分析、判断的领域知识体；不是自动化拆分书籍/报告的批处理器，也不是个人日记或读书笔记系统。
3. **双层结构：知识体 + 思维体**：`01-Cards/` 与 `05-Buffer/` 构成**知识体**；`nexo-talk|deep-think|emerge|assess|refine|report` 等思维体利用该结构进行推理、分析、修订与产出。
4. **Harness 负责过程，LLM 负责语义**：卡片校验、原子写入、索引生成、孤儿检测由 Harness 强制执行；内容好坏、冲突识别、新建/丰富/skip 由 LLM 负责。
5. **统一写入权威**：任何知识体实质写入必须通过 DSH 的 `HarnessGateway`；Web handler、Skill、Thinking Model 与 GraphOp 均不得直接写卡。`python -m nexogenesis write --batch <file>` 是 ORG 迁移来源的参考契约，不再是 DSH 独立运行的硬依赖。
6. **复杂度必须有证据**：新增类型、关系、视图、自动化必须说明真实摩擦、最小改动、判断标准和撤回方式。

## 二、目录结构

```text
AGENTS.md                              # 本手册（宪法）
README.md                              # 项目说明
.agent/
├── skills/                            # 编排技能
│   ├── nexo-talk/SKILL.md
│   ├── nexo-deep-think/SKILL.md
│   ├── nexo-emerge/SKILL.md
│   ├── nexo-assess/SKILL.md
│   ├── nexo-refine/SKILL.md
│   ├── nexo-report/SKILL.md
│   ├── nexo-compile/SKILL.md
│   ├── nexo-theme-compile/SKILL.md
│   ├── nexo-digest/SKILL.md
│   └── nexo-construct/SKILL.md
├── reference/                         # 活契约
│   ├── card-contracts/                # 卡片规范与正例
│   ├── harness-cli.md                 # DSH Harness 与认知工具参考（兼容旧文件名）
│   ├── write-transaction.md           # 写入事务规则
│   ├── ingest-pipeline.md             # 摄入与建构 Agent Loop 纪律
│   ├── retrieval-design.md            # 双轨检索设计
│   ├── thinking-body.md               # 思维体注意力设计
│   ├── thinking-output-contract.md     # 证据、输出与沉淀契约
│   └── constraint-layers.md           # 约束分层说明
docs/                                  # 当前开发说明
├── README.md                          # 文档入口
├── 2026-08-30-项目定位、愿景与总体架构.md
├── 2026-08-30-当前实现、运行与限制.md
├── 2026-08-30-近期开发路线.md
├── 2026-08-30-TM-Skill-OPS与知识流程统一实施SPEC.md
├── 2026-08-30-认知能力评测与受控迭代指南.md
└── history/                           # 旧设计与计划，不参与当前判断
01-Cards/                              # 实例知识卡片；Markdown 语义事实源
02-Profile/                            # 领域级思考特质档案
03-Archive/                            # 已处理原始材料
04-OutBox/                             # 分析产物
05-Buffer/<role>/                      # 普通 compile 产出的待消化质料
05-Buffer/themes/<theme>/              # 主题编译的正式章节来源、矩阵与图像，不进入普通消化队列
06-Journal/                            # 操作大事记
web/                                   # React 前端；由 DSH web-host 托管 dist
schemes/default/                       # 默认沉淀方案与 Thinking Model 基线
packages/nexogenesis-tools/lib/
├── cognition/                         # 长任务状态、操作记录和分析指导
├── compile/                           # 来源清单、有限切片与覆盖审计
└── harness/                           # 唯一写入 Gateway、关系契约、语义补丁
nexogenesis/                           # 历史 Python 占位；不作为 DSH 运行时写入权威
```

## 三、权限分层

- **宪法**：`AGENTS.md`
- **编排技能**：`.agent/skills/`
- **活契约**：`.agent/reference/`
- **当前实现**：`docs/history/pre-uno/2026-08-30-当前实现、运行与限制.md`
- **近期工作**：`docs/history/pre-uno/2026-08-30-近期开发路线.md`
- **提示语义**：`schemes/default/prompts/`

  统一写入入口：DSH `HarnessGateway`。它必须完成批次预检、关系语义校验、修订冲突检查、原子提交或回滚、Journal 收据与确认结果回送。
`origin: system` 的卡片未经用户批准不能进入 `mature` 或 `theory_status: active`。

## 四、Skill 索引

| Skill | 触发条件 | 主职 |
|---|---|---|
| `nexo-talk` | 日常对话、分析、思考 | 检索、归因，分析留对话，不自动写卡 |
| `nexo-deep-think` | 「测试 TM/OPS」「/deep-think」 | judge 的固定执行测试兼容入口；普通「深入思考」由 talk 自适应分析；只读不写卡 |
| `nexo-emerge` | 「记一下」「/capture」「涌现」 | ≤3 候选 → 用户确认 → HarnessGateway |
| `nexo-assess` | 「研判」「/assess」 | 2–4 个有区分度的观察角度，定位而非裁决 |
| `nexo-refine` | 「精修卡片」「/refine」 | 讨论既有卡、差异说明、确认后修订 |
| `nexo-report` | 「专题报告」「/report」 | 面向对象的可追溯结构化分析 |
| `nexo-judge` | 「运行思维体测试」「/judge」 | 冻结时点、只读证据与严格输出下的认知评测 |
| `nexo-compile` | 「编译」「/compile」 | Inbox → Buffer |
| `nexo-theme-compile` | 「主题编译」「/主题编译」 | 多书章节来源层 → 跨书聚合 Card → 质量验收 |
| `nexo-digest` | 「消化」「/digest」 | Buffer → Card（enrich + 新建） |
| `nexo-construct` | 「建构」「/construct」 | 结构诊断、合并、升枢纽、张力 |

## 五、Reference 索引

| 文档 | 职责 |
|---|---|
| `.agent/reference/card-contracts/body-structure.md` | Buffer / Card 正文结构契约 |
| `.agent/reference/card-contracts/ontology.md` | 卡片类型与关系类型契约 |
| `.agent/reference/card-contracts/card-exemplars/` | 七型写法正例 |
| `.agent/reference/harness-cli.md` | DSH Harness、认知工具与 Web 接口速查 |
| `.agent/reference/write-transaction.md` | HarnessGateway 事务、单层变更与收据规则 |
| `.agent/reference/ingest-pipeline.md` | compile → digest → construct 纪律 |
| `.agent/reference/theme-compile.md` | 多本同主题长材料的章节来源、跨书聚合与验收规范 |
| `.agent/reference/retrieval-design.md` | 图 + RAG 双轨检索设计 |
| `.agent/reference/thinking-body.md` | 思维体注意力设计 |
| `.agent/reference/thinking-output-contract.md` | 思维体证据等级、输出状态与沉淀边界 |
| `.agent/reference/constraint-layers.md` | 约束分层说明 |

## 六、开发文档

  开发前先读 `docs/history/pre-uno/2026-08-30-当前实现、运行与限制.md`；近期工作只看 `docs/history/pre-uno/2026-08-30-近期开发路线.md`。`docs/history/` 只用于追溯，不能用其中的旧路径、命令和完成状态推断当前能力。


## 七、AI 禁止与必须

### 禁止

- 把 ingest 做成「切书批处理器」。
- 用空心「原文未提及」/标题回声凑格式。
- 绕过 `HarnessGateway` 直接改卡片文件。
- 创建信息稀薄的空卡片。
- 为每篇文档都创建新卡片。
- 在 Inbox 中堆积已处理原始文档。
- 未经用户确认改写 `02-Profile/` 已有条目。
- 删除任何卡片（只能标记 `lifecycle: superseded`/`archived`）。
- 创建幽灵链接。
- 让卡片因无限引用而膨胀。

### 必须

- 以聚合涌现为目标：拥有细节、凝聚思想和信息的质料 → 可独立阅读的卡片结构。
- 以知识对象的清晰、完整、可复用和可推理性决定落点，不预设丰富旧卡或新建卡的优先级。比较真实增量、对象身份、解释完整性与承载负担后，选择新建、修订、拆分、合并或保留可追溯来源；既不重复造卡，也不把旧卡扩成杂糅容器。
- 检测并记录冲突。
- 维护领域卡片的完整性。
- 主动沉淀领域级理念与思维范式到 `02-Profile/`，并标注来源。
- 处理完后归档原始文档。
- 所有 AI 生成的内容标注来源。
- 任何写入须经授权：逐步确认，或用户一句「开始消化/建构」/`--auto` 视为本轮授权。
- **知识与程序分离纪律**：运行时代码、Skill、Thinking Model、GraphOp、Harness 与评测案例可以版本化；具体知识体内容默认不作为通用程序能力提交。部署实例可以在自己的仓库中保存知识体，但不得把实例内容误当成运行时规则。
- **默认分发包语义**：用户未作额外限定时，“打包分发用的压缩包”固定指 `tools/export-clean-agent.ps1` 生成的纯净初始化 Agent ZIP。八个知识与产物目录只保留空目录，不携带 Card、Profile、Buffer、OutBox、原始材料、Journal、会话、实例、依赖或构建结果。只有用户明确要求迁移现有知识实例或携带知识体时，才使用 `tools/export-portable-snapshot.ps1` 的知识迁移双包。

---

## 八、ORG 能力迁移纪律

- 迁移 ORG 成熟能力时先提取语义契约、校验规则、状态对象和测试案例，不直接搬运旧工作流控制器。
- ORG 的 compile / digest / construct 代码只能作为确定性能力来源；“下一步做什么”的决定必须留给 DSH Agent Loop。
- 迁移后的能力必须作为模型可见工具、Harness 校验器或只读算法进入 DSH，并具备结构化 Observation / Receipt。
- 任何迁移都要记录来源、适配差异、撤回方式和行为测试；不得维持两套并行写入真相。

---

## 九、Agent 任务规则

1. DSH 会话中的模型根据工具结果决定下一步；Web 按钮只创建任务，不能在后台替模型写死语义步骤。
2. 编译、消化、建构和普通对话使用独立会话与任务状态，不能共享隐式进度变量。
3. Skill 只说明目标、可用工具和停止条件，不规定固定调用顺序。
4. 长任务保存目标、已发现内容、待办和预算；这些运行文件不是知识卡，也不保存隐藏思维链。
5. 工具失败、写入拒绝和用户决定必须返回原会话。拒绝后由模型修正、换方向、缩小范围或说明为何停止。
6. 一次写入只处理一个层面，最多三个紧密相关操作；卡片写入必须经过授权、校验和失败回滚。
7. 工具说明、参数示例和实际校验必须一致。不存在或尚未验证的能力不能写进当前说明。

  是否具备有效的 Agent 行为，只看真实任务中能否根据新结果改变下一步、拒绝后继续、恢复时避免重复写入以及不同任务是否互不污染。目录名、类名和提示词不算证明。自动学习、策略晋升和新增工具都暂缓，直到真实案例反复表明现有机制不足。
