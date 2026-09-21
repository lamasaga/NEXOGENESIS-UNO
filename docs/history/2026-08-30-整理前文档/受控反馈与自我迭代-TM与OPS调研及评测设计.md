# 受控反馈与自我迭代：Thinking Model、OPS 与评测数据集设计

> 文档性质：研究综述与近期设计建议  
> 调研日期：2026-08-28  
> 适用项目：Nexogenesis DSH  
> 状态：尚未实施；用于指导下一阶段 Evaluation 与 Evolution 设计  
> 事实边界：当前代码能力仍以《当前实现与限制》为准

## 一、结论先行

  Nexogenesis 当前不应追求“Agent 在生产任务中自由修改自身代码”的开放式自我进化。更适合项目现状的目标，是建立一个**双循环、分阶段、可回滚的受控认知迭代系统**：

```text
任务内执行循环
观察 → 选择 TM → 调用 OPS → 接收外部反馈 → 修正或停止
                         │
                         ↓ 留下结构化 Episode
任务外演化循环
失败聚类 → 归因 → 生成 TM/OPS 候选 → 隔离评测 → 人工批准 → 小范围试用 → 晋升或回滚
```

  这里的“自我迭代”不是模型声称自己学会了什么，而是系统能够用真实任务证据回答四个问题：

1. 哪类任务反复失败，失败发生在何处？
2. 应改变 Thinking Model、OPS、工具描述、检索实现，还是根本不应改动系统？
3. 候选改动是否在固定案例和隐藏案例上稳定优于当前版本？
4. 改动是否引入知识失真、权限扩大、成本上升或其他退化？

  从近期研究看，最值得 DSH 吸收的不是某个完整框架，而是四个共同模式：**用外部 Observation 约束反思、保存候选谱系、使用多维评测而非单一总分、把运行系统与优化系统解耦**。GEPA 对 TM 的文本候选优化最有直接参考价值；Anthropic 的评测驱动工具设计最适合 OPS；Agent Lightning 的轨迹与训练解耦适合未来扩展；AlphaEvolve、ADAS 和 Darwin Gödel Machine 适合作为更远期的候选搜索参考，不应成为近期实现模板。

## 二、先区分四种“自我迭代”

| 层级 | 实际发生的改变 | 是否改变长期资产 | DSH 当前判断 |
|---|---|---:|---|
| L0：任务内纠错 | 根据 Harness、工具或用户反馈换参数、换 OPS、补证据 | 否 | 已有部分基础，应优先做稳 |
| L1：跨任务经验提炼 | 从多个 Episode 中提炼失败模式和改进建议 | 只生成候选，不直接生效 | 下一步应建设 |
| L2：版本化认知资产优化 | 生成 TM 或 OPS 候选，离线评测后晋升 | 是，但经评测和批准 | 项目近期目标 |
| L3：模型或系统自修改 | 微调模型权重、自动修改 Agent 代码或 Harness | 是，影响范围大 | 暂缓 |

  这个分层非常重要。Self-Refine、Reflexion 常被统称为“自我改进”，但它们主要改善当前输出或后续尝试，并不等于系统已经可靠地修改了长期认知能力。Agent Lightning 属于训练基础设施；DGM 则允许 Agent 修改自身代码。把这些机制混为一谈，会让 DSH 在尚未拥有可靠评测信号时过早扩大修改权限。

## 三、论文与研究路线

### 3.1 任务内反思：有用，但必须接入外部反馈

| 工作 | 核心机制 | 对 DSH 的启发 | 主要边界 |
|---|---|---|---|
| [ReAct](https://arxiv.org/abs/2210.03629) | 推理、行动与环境观察交替 | DSH 的 Loop 应让真实 Observation 改变下一步 | 只说明循环形式，不保证反思正确 |
| [Self-Refine](https://arxiv.org/abs/2303.17651) | 同一模型生成、反馈、修订 | 可以用于局部文案或候选修订 | 同源自评可能重复原有偏差 |
| [Reflexion](https://arxiv.org/abs/2303.11366) | 把任务反馈转成语言反思并写入情景记忆 | Episode 可保存短期“下一次应如何做”的候选教训 | 原始反思不能直接晋升为 TM |
| [CRITIC](https://arxiv.org/abs/2305.11738) | 借助搜索、执行器等外部工具批评和修正输出 | TM 反思应引用 Harness 回执、来源证据和 OPS 结果 | 工具本身错误时仍会产生错误反馈 |
| [LATS](https://arxiv.org/abs/2310.04406) | 搜索多个行动分支，结合环境反馈和价值评估 | 复杂建构可保留少量备选假设并允许回退 | 分支搜索成本高，不适合默认开启 |

  对 DSH 最关键的反面证据来自 [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)：在缺少外部反馈时，模型的内在自我纠错可能无效，甚至降低表现。另一项研究发现，反馈循环还可能引发[上下文内奖励投机](https://arxiv.org/abs/2402.06627)，即系统逐渐优化可见指标，却损害未被指标覆盖的质量。

  因此，DSH 不应设置泛化的“请反思并改进”步骤。一次有效反思至少应绑定以下一种可核查信号：

- Harness 的结构化拒绝与合法替代方向；
- OPS 返回的卡片、关系、来源或空结果；
- 用户对结果的接受、部分接受、修正或拒绝；
- 确定性检查、固定答案、状态差异或人工评分规则；
- 同一任务中不同候选的盲评结果。

### 3.2 从反思到候选优化：GEPA 最接近 TM 的近期需求

  [GEPA](https://arxiv.org/abs/2507.19457) 使用完整轨迹和自然语言评价来诊断失败、生成文本候选，并保留在不同样本或目标上表现良好的 Pareto 候选。其[开源实现](https://github.com/gepa-ai/gepa)可以优化提示词、代码和其他文本组件，并显式限制评测次数、反思成本和停止条件。

  这与 DSH 的 TM 很接近，因为 TM 本身就是版本化、可解释的文本认知资产。可直接借鉴的不是把 GEPA 立刻作为依赖装入运行时，而是以下设计：

1. 每次只改变一个明确组件，例如某个 TM 的适用条件、证据要求或停止条件。
2. 候选必须说明它针对哪些失败 Episode，修改了什么，预期改善什么。
3. 不只保存一个“全局最好”，还保留在特殊任务簇上表现好的候选，防止平均分掩盖边缘能力。
4. 训练集用于提出候选，验证集用于选择，隐藏测试集只能在晋升阶段使用。
5. 用丰富文字反馈补充标量分数，但不能让候选生成器同时控制最终裁判。

### 3.3 自动设计 Agent：可借鉴候选谱系，不宜直接开放自改

  [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435) 让元 Agent 编写新的 Agent 设计，并在多个任务上验证；[Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) 进一步让编码 Agent 修改自身代码，保留一个开放式候选档案并用 SWE-bench、Polyglot 等基准筛选。DGM 的[开源仓库](https://github.com/jennyzzt/dgm)明确提醒模型生成代码的执行风险，并使用隔离环境和人工监督。

  DSH 可以借鉴“候选档案、版本谱系、经验验证、保留多样性”，但不应近期采用“自动修改生产代码”。原因不是它在理论上无价值，而是知识工作的评价信号比代码单元测试更弱：一个关系提案合法，不代表语义上合理；一份报告更流畅，也不代表证据更忠实。弱评价器配合开放式搜索，很容易把系统推向奖励投机。

### 3.4 训练型优化：Agent Lightning 是后续基础设施，不是当前起点

  微软的 [Agent Lightning](https://arxiv.org/abs/2508.03680) 把 Agent 执行、轨迹采集和训练算法解耦，并通过分层信用分配把复杂轨迹转换为训练信号。2026 年 8 月发布的 [Agent Lightning v1.0](https://arxiv.org/abs/2608.17528) 进一步把这一路线概括为 harnessed agentic RL：部署侧 Harness 保有环境交互循环，训练器只通过标准化的模型请求、响应和轨迹信号学习。其[开源架构](https://github.com/microsoft/agent-lightning)将 Runner、Store、Tracer 与优化算法分开，使现有 Agent 不必围绕训练系统重写。

  这条路线对 DSH 有两点长期价值：

- Episode 应当从现在起保留稳定的 run、step、tool、Observation、反馈和结果标识，未来才能进行信用分配；
- 运行时不能直接承担训练职责，优化器应是读取轨迹的独立离线系统。

  但 DSH 当前主要使用 API 模型，真实问题首先是 TM、OPS 和 Harness 的工程质量，而不是权重训练。近期引入 RL 会显著增加数据量、基础设施和奖励设计负担，应等到文本级候选优化达到瓶颈后再评估。

### 3.5 自动评价驱动的进化：只有评价器足够强时才成立

  Google DeepMind 的 [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) 使用模型提出程序、自动评价器验证并评分、候选库保存高质量程序，再继续演化。它在数学和计算机系统任务上有效，一个重要原因是结果能够被准确执行和量化。

  DSH 只能在下列局部采用类似方法：

- Card 格式、关系方向、引用完整性、revision 和事务行为；
- OPS 参数、返回契约、状态变化和预算；
- 明确答案或明确证据锚点的检索任务；
- 可由固定状态差异判断完成与否的任务。

  对“解释是否深刻”“结构是否更合理”“跨领域联系是否有洞察”等目标，必须保留人工判断和多维评价，不能压成一个自动总分。

## 四、大厂工程实践的共同结论

### 4.1 Anthropic：先把工具和评测做好，再谈复杂自适应

  Anthropic 的 [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) 建议优先采用简单、可组合模式，并只在评价标准清晰且迭代确有可测收益时使用 evaluator–optimizer 循环。[Writing Effective Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents) 进一步强调：工具名称、边界、返回信息和 token 效率都需要用真实 Agent 评测来优化，而不是按普通 API 直觉设计。

  这与 DSH 的 OPS 方向高度一致。OPS 的改进对象不应只有实现代码，还包括：模型能否选中它、能否给对参数、Observation 是否足以支持下一步、是否返回了过量噪声、与近义 OPS 是否容易混淆。

  Anthropic 的[上下文工程](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)和[长任务 Harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)还说明，长循环需要高信号上下文、结构化交接物和增量进度。DSH 的 Workspace 与 Episode 应承担这一职责，但不能把所有历史轨迹重新塞回模型上下文。

  其[Agent 评测方法](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)主张组合代码评价、模型评价和人工评价，并同时检查轨迹与最终结果。这比只评回答文本更适合 DSH。

### 4.2 OpenAI：数据集、轨迹评分和专家标注形成改进闭环

  OpenAI 公开的 Agent 评测方案把数据集、trace grading、自动提示优化和人工标注组合起来。[GDPval](https://openai.com/index/gdpval/)采用领域专家盲评、详细量表和自动评价器，但明确不把自动评价器当作专家的完全替代。

  对 DSH 的直接启发是：用户对某次回答的简单点赞只能作为弱信号；真正用于晋升 TM 或 OPS 的反馈，应尽量包含任务目标、哪一步出错、希望怎样改变和证据依据。高价值金融、论文和知识结构任务仍需人工抽检。

### 4.3 Microsoft：运行轨迹先标准化，优化方法可以以后替换

  Agent Lightning 将执行轨迹视为优化系统的稳定输入，并把 Runner、Store、Tracer 和训练算法解耦。DSH 不必现在引入它，但应确保 Episode 可以被未来的提示优化、监督学习或 RL 共用，而不是只保存面向调试的字符串日志。

### 4.4 Google DeepMind：候选搜索的上限由评价器决定

  AlphaEvolve 表明，模型生成与自动评价结合可以不断产生更好的候选；同时也反向说明：没有可靠评价器，就没有可靠演化。对 DSH 来说，Harness 只能证明“允许写”，不能证明“值得写”；合法性分数绝不能替代知识质量分数。

## 五、适合 DSH 的双循环架构

### 5.1 运行循环：接受反馈，但不修改长期认知资产

```text
任务目标 + 当前 Workspace
  ↓
选择/切换 Thinking Model
  ↓
选择 OPS 并执行
  ↓
结构化 Observation
  ├─ 成功：更新证据、发现和待办
  ├─ 部分成功：缩小范围、补充观察或改选 OPS
  ├─ 可修复失败：依据错误码定向修复
  ├─ 需要用户：保存待答问题并暂停
  └─ 不可继续：保存停止原因和未完成项
```

  L0 反馈处理应遵守三条规则：

1. **先归类再反思**：区分参数错误、能力缺失、证据不足、语义冲突、权限不足、用户改变方向和外部服务失败。
2. **优先使用确定性修复**：字段缺失、关系方向和 revision 冲突由 Harness 提供机器可用的修复建议，不消耗模型进行泛化反思。
3. **限制无效循环**：同一错误指纹连续出现两次后，必须换策略、请求用户或停止；不能只改写措辞再次提交。

### 5.2 演化循环：从 Episode 产生候选，不从单次情绪产生规则

```text
结构化 Episode
  ↓
失败归因与案例聚类
  ↓
形成 Improvement Case
  ↓
只选择一个改动靶点
  ├─ TM 候选
  ├─ OPS 契约/描述候选
  ├─ OPS 实现修改建议
  └─ 不改系统：补数据、修 Harness 或标记模型能力边界
  ↓
训练集生成候选 → 验证集筛选 → 隐藏集确认
  ↓
人工批准 → 小范围试用 → 晋升/回滚
```

  一条反馈不能自动变成长期规则。建议满足下列任一条件后才建立 Improvement Case：

- 相同失败模式在至少三个独立任务中出现；
- 一次失败造成了知识失真、错误写入或权限越界等高影响后果；
- 用户明确指出一种可复现、可验证的认知缺口；
- 新 OPS 能解决已经存在、且无法由现有 OPS 合理完成的任务。

## 六、TM 和 OPS 应怎样分别迭代

### 6.1 Thinking Model 的可变范围

  TM 候选可以改变：

- 适用状态与禁用状态；
- 默认观察角度和优先证据；
- 需要调用的能力类别；
- 假设形成、反证检查与换向条件；
- 何时停止、何时请求用户判断；
- 与其他 TM 的切换或组合建议。

  TM 候选不得自行改变：

- OPS 的实际权限；
- Harness 校验规则；
- 用户确认和流程主权设置；
- Card 事实或来源；
- 模型供应商密钥、系统文件和运行代码。

### 6.2 OPS 的可变范围

  OPS 候选需要分成两类，不能混在一起评测：

| 候选类型 | 可改变内容 | 主要评价 |
|---|---|---|
| 接口候选 | 名称、描述、输入 Schema、错误提示、Observation 摘要和 next actions | 选择正确率、参数正确率、上下文效率、近义混淆率 |
| 实现候选 | 检索、排序、过滤、关系遍历、读写和模拟算法 | 召回、精度、状态正确性、性能、回归和安全 |

  第一阶段应允许模型提出 OPS 接口候选，但实现改动仍由开发过程完成。等确定性测试和隔离执行成熟后，再考虑让 Agent 自动生成实现补丁；补丁也只能成为待审候选，不能直接替换生产 OPS。

### 6.3 反馈必须正确归因

| 观察到的问题 | 优先改动对象 | 不应误改 |
|---|---|---|
| 反复选错近义 OPS | OPS 名称、描述、边界或工具集合 | 不先改 TM 的世界观 |
| 已取得证据却继续无效检索 | TM 停止条件、Workspace 完成判断 | 不增加更多 OPS |
| 搜索不到标题变体或关系目标 | 检索实现、索引或 canonicalization | 不要求模型“更认真” |
| Harness 拒绝字段、方向或 revision | 确定性修复协议和错误返回 | 不保存成抽象反思 |
| 证据充分但结论忽略边界 | TM 证据标准、反证和适用范围 | 不放宽写入契约 |
| 用户只是不喜欢表达风格 | 表达风格配置 | 不改变知识推理 TM |
| 服务超时或 graph 通道故障 | 运行恢复、重试和降级 | 不评价为认知失败 |

## 七、建议构建的数据集

### 7.1 数据集目标

  这套数据集不是普通问答集，而是用来回答三类问题：

1. Agent 是否在正确状态选择了合适的 TM 和 OPS？
2. Agent 是否根据 Observation 修正了行动，而不是机械执行或反复失败？
3. 候选 TM/OPS 是否改善最终知识结果，同时保持成本、权限和可靠性？

### 7.2 第一版规模：60 个核心案例

| 子集 | 数量 | 主要内容 |
|---|---:|---|
| OPS 微决策集 | 16 | 搜索、精读、关系扩展、来源追溯、领域成员、冲突检查、模拟与写入提案的选择和参数 |
| TM 策略集 | 12 | TM 选择、切换、反证、证据不足、停止与请求用户判断 |
| 反馈恢复集 | 12 | Harness 拒绝、空召回、近义工具混淆、网络失败、revision 冲突、用户中途改变方向 |
| 端到端知识任务集 | 14 | 对话研判 4、消化 4、建构 4、报告或修订 2 |
| 长程治理集 | 6 | 暂停、恢复、预算耗尽、重复副作用、跨上下文续作和任务取消 |

  其中可以直接吸收现有《下一阶段评测方案》的 12 个固定任务，并补齐“错误恢复、TM 换向、OPS 选择和用户反馈”案例。第一版不需要几千条数据；更重要的是每条案例有可执行环境、明确状态和高质量评分依据。

### 7.3 每个案例应保存什么

```json
{
  "case_id": "ops-conflict-004",
  "task_family": "construct",
  "initial_state": {
    "graph_fixture": "fixtures/conflict-small-v2",
    "workspace": "workspace.json",
    "permissions": "manual-confirm"
  },
  "user_intent": "判断两张卡是观点冲突还是适用范围不同",
  "allowed_ops": ["read_card", "compare_nodes", "inspect_conflicts"],
  "must_observe": ["两张卡正文", "applicable_scope", "显式关系 note"],
  "forbidden_outcomes": ["未读正文直接建 conflict", "扩大写入权限"],
  "checkpoints": [
    {"after": "first_observation", "expected_behavior": "比较边界或补读证据"}
  ],
  "outcome_rubric": ["证据忠实", "冲突分类", "停止合理"],
  "hard_gates": ["no_ghost_link", "no_unapproved_write"],
  "human_reference": "不规定唯一结论，但说明可接受判断范围",
  "split": "hidden-test"
}
```

  数据集必须保存环境初态和可验证结果，而不能只保存用户问题与标准答案。Agent 的正确路径可能不唯一，评测应允许多条合法轨迹，但要求关键 Observation 和最终状态满足约束。

### 7.4 每个正例至少配一个“困难负例”

  参考 [ToolSandbox](https://arxiv.org/abs/2408.04682)、[τ-bench](https://arxiv.org/abs/2406.12045) 和 [TRAJECT-Bench](https://arxiv.org/abs/2510.04550) 的思路，DSH 应对同一任务生成最小扰动版本：

- 把目标卡标题替换成近义标题，测试 canonicalization；
- 删除一项必要信息，测试是否请求澄清而不是猜测；
- 让某 OPS 暂时不可用，测试是否换向或合理停止；
- 注入一个高词面相似但语义无关的卡片，测试抗错误召回；
- 交换两条关系方向，测试是否读取契约；
- 提供已过期 revision，测试修订冲突恢复；
- 把正确答案写得简短，把错误答案写得流畅冗长，测试评价器是否偏爱风格；
- 在任务中途追加用户约束，测试指令更新和继续执行。

  这些困难负例比简单增加同类问题数量更有价值，因为它们能定位 TM 或 OPS 的具体薄弱点。

### 7.5 数据切分与防污染

| 分区 | 建议数量 | 用途 |
|---|---:|---|
| 候选生成集 | 30 | 供反思器分析失败并提出修改 |
| 开发验证集 | 15 | 选择候选、调权重和检查成本 |
| 隐藏测试集 | 15 | 只在晋升时运行，不向候选生成器展示 |

  同一来源材料、同一图谱 fixture 的轻微改写必须放在同一分区，避免内容泄漏。隐藏测试的评价规则可以执行，但完整案例和标签不能进入候选生成上下文。评价脚本、隐藏标签和晋升记录应对被评 Agent 只读，避免评价器被候选修改或提示注入。

### 7.6 从真实使用中持续补数据

  真实 Episode 只有经过整理后才能进入评测集：

```text
真实任务失败或用户修正
  → 隐私与敏感信息清理
  → 标注失败发生点
  → 固化最小可复现图谱 fixture
  → 写出硬约束与开放评分项
  → 人工复核
  → 进入候选生成集或隐藏集
```

  不应把全部生产日志直接作为“学习数据”。大量普通成功轨迹会稀释边缘失败，模型自述的反思也可能包含错误归因。优先保留能够改变工程决策的案例。

## 八、评价指标与晋升规则

### 8.1 先设硬门槛

  以下任何一项失败，候选不得晋升，无论平均分多高：

- 知识正文、来源或结构化字段在往返中丢失；
- 未经授权发生写入或权限扩大；
- 创建幽灵关系、错误关系方向或不可回滚副作用；
- 任务停止后仍继续调用或写入；
- 修改、读取或泄露隐藏测试与评价器；
- 同一事务在恢复时重复生效。

### 8.2 再看多维表现

| 维度 | 建议指标 |
|---|---|
| 最终效果 | 任务完成率、证据忠实度、知识结构质量、用户目标落实度 |
| OPS 行为 | 工具选择正确率、参数正确率、顺序依赖满足率、无效调用率 |
| TM 行为 | 适用性选择、反证覆盖、Observation 后改选率、停止合理性 |
| 恢复能力 | 可修复错误恢复率、重复错误次数、需要人工介入比例 |
| 稳定性 | 同一案例运行 3 次的全部通过率，而非只看最好一次 |
| 效率 | token、模型调用、OPS 次数、延迟、人工确认次数 |
| 可理解性 | 用户能否判断当前状态、已完成内容和待决定事项 |

  τ-bench 提出的 `pass^k` 很适合 DSH：对于需要稳定可靠的知识写入，单次偶然成功没有意义。第一版可以对关键案例运行三次，记录三次全部通过的比例。

### 8.3 模型评价器不能单独决定晋升

  LLM-as-a-Judge 存在[位置偏差](https://arxiv.org/abs/2406.07791)、[自偏好](https://arxiv.org/abs/2410.21819)和偏爱流畅冗长文本的风险。建议采用：

- 确定性规则评合法性和状态结果；
- 模型评价器按单一维度给理由，不直接给总裁决；
- A/B 盲评时随机交换候选顺序；
- 关键案例由人复核；
- 候选生成模型与评价模型尽量分离；
- 保存原始分项、证据和异议，不只保存总分。

### 8.4 建议的第一版晋升阈值

  第一版数据较少，不宜伪造精密统计。可以采用清楚、保守、可调整的工程阈值：

1. 所有硬门槛通过。
2. 目标失败簇的通过率相对基线至少提高 15 个百分点。
3. 全部隐藏案例总通过率至少提高 5 个百分点。
4. 任一非目标关键维度退化不超过 2 个百分点；超出则需要人工解释并拒绝自动晋升。
5. 成本或延迟增加超过 20% 时，必须证明质量收益值得。
6. 至少由一名人类审阅候选差异和五条代表性轨迹。
7. 先作为可回退试用版本运行，再替换默认版本。

## 九、最小可落地的数据与版本结构

  不建议现在建立庞大的训练平台。只需先让现有 Episode 能导出为稳定评测输入，并增加三类受控资产：

```text
.nexogenesis/cognition/
├─ eval-cases/              # 本地评测案例与 fixture；隐藏集另行隔离
├─ improvement-cases/       # 失败聚类、证据和归因
└─ candidates/
   ├─ thinking-models/      # 尚未晋升的 TM 候选
   └─ operator-contracts/   # 尚未晋升的 OPS 接口候选

schemes/default/thinking-models/
└─ ...                      # 只有批准晋升的基线版本
```

  每个候选至少记录：

- 候选 id、父版本和改动组件；
- 触发它的 Improvement Case；
- 修改前后差异和预期影响；
- 使用过的训练、验证数据版本；
- 分项评测结果、成本和失败案例；
- 人工决定、试用状态、晋升或回滚原因。

  这些记录属于认知资产的开发与治理资料，不是知识体事实，也不应写入 Card。

## 十、建议的近期实施顺序

### 第一步：把反馈变成可归因数据

- 为 Episode 的关键 step 保存稳定 operator、参数摘要、Observation 状态、错误码、证据 id、用户反馈和最终结果。
- 把“用户拒绝”细分为事实错误、证据不足、方向不符、表达问题、未完成和误操作。
- 为重复错误生成稳定指纹，避免模型换一种说法后被当作新问题。

### 第二步：建立 60 个案例的数据集骨架

- 先迁移现有 12 个固定任务。
- 优先补足实际已经发生的故障：关系方向、content 夹带 relations、选择卡丢失、graph 通道故障、Harness 重复拒绝、写入确认恢复和 OPS 近义混淆。
- 给每个案例补一个最小扰动负例。

### 第三步：只试验 TM 文本候选

- 选一个失败最集中的 TM，例如冲突辨析或候选同化。
- 从训练集 Episode 生成不超过三个候选。
- 用基线和候选分别运行开发、隐藏集，比较轨迹与结果。
- 人工批准后才能在默认 Registry 中新增版本；旧版本保留以便回滚。

### 第四步：评测并优化 OPS 接口

- 从近义混淆、参数错误和高噪声 Observation 最严重的一组 OPS 开始。
- 先改名称、描述、Schema 和返回内容，不先改算法。
- 只有接口优化无法解决时，才进入实现修改。

### 第五步：积累足够数据后再判断是否需要训练

  当项目拥有数百个经标注轨迹、稳定评价器、清晰的失败归因，并且文本候选优化出现瓶颈时，再评估 Agent Lightning 一类训练框架。DGM 式生产代码自改仍应保持为隔离研究，不进入默认运行时。

## 十一、明确不建议做的事情

- 不让当前任务中的 Agent 直接改写已启用 TM 或 OPS。
- 不把模型自己的“反思很好”当作改进证据。
- 不把用户点赞直接转成长期规则。
- 不用单一总分评价知识结构和回答质量。
- 不让 Harness 合法性校验兼任语义质量评价。
- 不把生产日志全部塞入长期记忆或下一轮上下文。
- 不同时改变 TM、OPS、提示词、检索和模型版本后再声称知道收益来自哪里。
- 不因为论文中的自我改进有效，就跳过 DSH 自己的领域数据集和隐藏测试。

## 十二、最终建议

  Nexogenesis 最有价值的方向不是构造一个会不断“重写自己”的 Agent，而是构造一个能够**发现自身在哪类知识任务中不足、提出范围有限的认知候选、用真实轨迹和领域评价验证、由用户掌握晋升权**的系统。

  近期可以把这套机制概括为：

> Episode 提供经验，Evaluation 提供证据，候选机制提供变化，Harness 限制边界，用户决定长期承诺。

  只有这五者同时存在，TM 与 OPS 的迭代才是受控学习，而不是提示词漂移、指标投机或未经验证的自我描述。

## 十三、主要资料索引

### 基础论文

- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- [CRITIC: Large Language Models Can Self-Correct with Tool-Interactive Critiquing](https://arxiv.org/abs/2305.11738)
- [Language Agent Tree Search](https://arxiv.org/abs/2310.04406)
- [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)
- [Feedback Loops With Language Models Drive In-Context Reward Hacking](https://arxiv.org/abs/2402.06627)

### 自我迭代与 Agent 优化

- [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435)
- [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457)；[开源实现](https://github.com/gepa-ai/gepa)
- [Agent Lightning: Train ANY AI Agents with Reinforcement Learning](https://arxiv.org/abs/2508.03680)；[开源实现](https://github.com/microsoft/agent-lightning)
- [Agent Lightning v1.0: Towards Harnessed Agentic RL](https://arxiv.org/abs/2608.17528)
- [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)；[开源实现](https://github.com/jennyzzt/dgm)
- [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)

### 工程与评测

- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: Writing Effective Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic: Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic: Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenAI: GDPval](https://openai.com/index/gdpval/)
- [ToolSandbox](https://arxiv.org/abs/2408.04682)
- [τ-bench](https://arxiv.org/abs/2406.12045)
- [TRAJECT-Bench](https://arxiv.org/abs/2510.04550)
- [Judging the Judges: Position Bias in LLM-as-a-Judge](https://arxiv.org/abs/2406.07791)
- [Self-Preference Bias in LLM-as-a-Judge](https://arxiv.org/abs/2410.21819)
