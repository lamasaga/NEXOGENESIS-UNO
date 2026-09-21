# 架构审查、目标体量方向与参考项目（2026-08-04）

> 性质：设计参考文档（spec）。来源：2026-08-04 OutBox 十三篇复盘迭代后的整体架构审查、
> 面向 3000–5000 卡目标体量的方向评估、agent 记忆领域参考项目调研。
> 用途：调整/优化 agent 自身时查阅；不参与日常运作。

---

## 一、架构全景

```text
摄入链（知识体建设）                思维链（知识体使用）
00-Inbox                            用户对话
  │ compile（开窗/分波/prompt）       │ nexo-talk / nexo-judge / nexo-emerge（纯 skill 编排）
  ▼                                   ▼
05-Buffer ── digest（决策树/分波）──▶ 01-Cards ◀── retrieve（双轨 + 注意力组装）
  │                                   ▲           ├─ graph（结构子图）
  └── construct（四镜头诊断/手术）──────┘           ├─ RAG（FTS 质料）
                                                    └─ STM（会话焦点/已引卡/张力）
统一写入闸：write --batch（两阶段事务 → validate → journal → 索引刷新）
提示语义：schemes/default/prompts/*.txt + shared/ 四片段（Jinja 注入）
编排契约：.agent/skills（流程）+ .agent/reference（纪律）+ schemes（语义）
配置：schemes/default/attention.yaml（预算/席位/权重/类型先验/STM/强信号）
```

设计骨架：摄入三拍（compile→digest→construct）与思维三入口（talk/judge/emerge）
共用同一写入闸与同一卡片契约；「Harness 管过程、LLM 管语义」——确定性信号只做
可机检子集，语义判断全部留给 prompt 驱动的 LLM。

## 二、批判性审查结论（按严重度）

1. **ingest 链 prompt 无预算控制（高风险）**：digest/construct 注入全库目录（一卡一行）
   + 深读卡全文 + 本波 Buffer 全文，`estimate_pack_chars` 只估不控。retrieve 有
   `budget_chars=16000` 预算，ingest 没有等价物——架构不对称，库越大越接近静默劣化。
2. **检索核心长期无回归**：双账户、类型先验、权重是「直觉设定的数值决策」。本轮题库
   （tests/evaluation/bank）一落地即抓出两个存在已久的真 bug（类型先验凭空造种子
   导致盲区永不暴露；中文整句单 token 零命中）。权重调参至今无基线。
3. **提示语义分层自相矛盾**：compile 核心规则 `format_rules()` 硬编码在
   `ingest/prompts.py`（权限分层写明提示语义归 schemes）；同一纪律在
   skill/reference/prompt 三处复制，靠人工同步（response 命名铁律曾因此三处不一致）。
4. **construct 诊断产物面过宽**：lenses-report / structure-ops-draft /
   structure-ops-llm.yaml / diagnose-prompt / suggested-lenses + runbook，
   信息重叠各自维护，是「双文件漂移」的来源。
5. **双路径残留**：`--no-attention` legacy 组装 + `rank_nodes` 与
   `_dual_account_select` 两套并行打分逻辑。
6. **scheme 机制名存实亡**：`_load_template(name, scheme_dir=None)` 支持自定义
   scheme，但所有调用点都不传；要么打通（领域定制层），要么删参数。
7. **STM 设计超前于证据**：会话卷/化石/容量/覆盖/turn 计数机制重，实际注入只有
   focus/cites/tensions；session_overrides 等基本闲置（违反宪法第六条）。

### 设计合理、应保留的部分

- markdown 唯一事实之源 + 统一写入闸 + 两阶段事务：十三篇复盘无一篇指向写入层
  丢数据，事故全在编排与契约裂缝——底座判断正确。
- 「确定性信号只做可机检子集，语义交给 LLM」：involves 语义检查、domain 过载信号
  等本轮迭代证明可演进。
- 共享 prompt 片段（shared/）：一处维护多处注入。
- 注意力配置完全外置（attention.yaml + profile 预设 + 会话覆盖）。
- 复盘 → OutBox → 迭代的工作方式本身：「复杂度必须有证据」被真实执行。

## 三、面向 3000–5000 卡的方向评估

### 各环节存活度

| 环节 | 目标体量下 | 判断 |
|---|---|---|
| compile | 与卡库规模无关 | 存活，无需改 |
| digest | 全库目录 + 「看见全部才能 enrich」假设 | **断裂**——5000 卡目录约 50–80 万字符，超上下文上限 3–5 倍 |
| construct | 信号计算没问题；lens prompt 同病 | **半断裂**——诊断可全局（机器算），手术必须局部（LLM 做） |
| retrieve / 思维体 | 预算/席位/摘录全受控；图遍历局部 | **基本存活**——全线最适合规模化的部分 |
| STM / 索引 | 与库规模弱相关；图重建 5000 卡仍秒级 | 存活 |

关键非对称：思维体的痛点是**质量问题**（本轮已修 + 题库覆盖），ingest 链的问题是
**规模问题**（当前无解药）。核心断裂假设：「全库视图可以塞进一个 prompt」。

### 改造路线（三阶段，不推倒重来）

**阶段 1：ingest 链上下文检索化（解决断裂）**
- digest/construct 的 prompt 从「全库目录」改为「domain 骨架常驻（≈50–100 行）
  + 按本波 Buffer 检索 top-K 候选卡（K≈30–50）+ 硬预算」；超限自动收紧并明示。
- construct lens 增加作用域参数（如 `--domain X`）；诊断报告默认只给统计与告警。

**阶段 2：基数治理（解决熵增）**
- 「冷门卡」信号（长期无检索命中、无出入边）→ construct 合并/归档候选；
  合并从可选镜头升级为常规压力。
- domain 层承担「全局地图」：数量控制在几十张，每张维护核心问题与边界
  （≈ GraphRAG 的 community report 层，但目前靠人工维持）。

**阶段 3：评测基线（解决调参盲目）**
- 合成 300–500 卡基准库（金库扩写 + 脚本生成同质噪声卡），跑检索命中率/噪声率基线；
- 题库加入 digest 决策题（给 Buffer + 候选工作集，断言 enrich/新建/skip 选择）。

## 四、参考项目（按相关度，2026-08 调研）

1. **A-MEM（Agentic Memory）——与本项目最像，重点研读**。
   Zettelkasten 式原子笔记 + LLM 自动关联边 + 周期性记忆演化。与卡片+关系+construct
   同构。注意其教训：链接图被 LLM 重写时**无审计轨迹**（[分析](https://arxiv.org/pdf/2605.29630)）——
   本项目的 write --batch 事务 + journal 是强项，不可丢。
2. **Microsoft GraphRAG——「全局视图」的工程化解法**。
   Leiden 社区检测 + 层级化 community report（[论文](https://arxiv.org/html/2404.16130v2)）。
   本项目的 domain 卡 ≈ community report（当前手写），可借鉴其层级摘要的半自动维护；
   同时注意[生产教训](https://cyberinsist.com/blog/raptor-vs-graphrag-hierarchical-retrieval)：
   摘要的摘要会丢关键实体（domain 摘要须保留具体锚点）、索引 token 成本高一个量级。
3. **Letta（前 MemGPT）——内存分层与自编辑纪律**（[GitHub](https://github.com/letta-ai/letta)）。
   core/archival/recall 三层 ≈ 本项目 02-Profile / 卡库 / STM。启发：记忆块写入是
   agent 的一等工具调用且有明确块结构——对照检查 Profile 更新链路。
4. **Zep / Graphiti——时态与失效**。
   时态知识图谱，旧边标记失效而非删除（[相关讨论](https://arxiv.org/pdf/2603.17244)，
   DMR 基准 94.8%）。本项目 `lifecycle: superseded` 是同思想粗粒度版；
   若未来承载「会过期的判断」，其双时态（事件时间 vs 入库时间）值得借鉴。
5. **HippoRAG——检索侧多跳**。
   写入建 KG、查询 Personalized PageRank 找桥接实体。本项目图扩展 + 桥接节点加分
   是同方向；5000 卡时 PPR 是更成熟的排序器候选。

**不对标**：Mem0 / LangMem（聊天记忆层，解决「记住用户偏好」，不做结构化知识策展）；
RAPTOR（纯文本层级摘要，本项目是卡片图谱而非文档树）。

## 五、双仓开发环境（git 拓扑）

两仓库同源（副本从 `e27d25e` 分叉），按角色分工：

```text
Nexogenesis-org（基座，dev）
  └── main：代码迭代，每轮打 tag
NexogenesisV1.6org 金融2（副本，practice）
  └── remote dev → 基座；main：数据 + OutBox 复盘
  └── 同步：git fetch dev && git merge dev/main（路径不相交，零冲突）
```

- **路径治理**：`nexogenesis/` `schemes/` `.agent/` `tests/` 只在基座改；
  `01-Cards/` `02-Profile/` `05-Buffer/` 等只在副本经摄入链写；
  `04-OutBox/` 副本产生、基座消费（反馈流）。
- **索引不追踪**：`.nexogenesis/graph/` `rag/` `tmp/` 可重建，移出 git；
  `.nexogenesis/memory/` 与 `attention.yaml` 属会话状态，保留追踪。
- **纪律**：副本永不手改代码路径；每轮迭代 = 基座提交打 tag → 副本 merge →
  验证实践 → OutBox 复盘提交 → 基座读复盘开始下轮。
- 长期可选：收敛为单仓双分支 + git worktree（待双仓流程跑顺后再评估）。

## 六、收敛：如果只做三件事

1. digest/construct 上下文检索化 + 硬预算（3000 卡生死线）；
2. construct 分层（机器全局统计 + LLM 局部手术 + 冷门卡合并压力）；
3. 300–500 卡合成基准库 + 检索/消化基线（让调参变成实验而非直觉）。
