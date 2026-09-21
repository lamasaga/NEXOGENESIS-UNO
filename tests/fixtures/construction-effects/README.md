# UNO 建构效果固定案例

所有内容均为明确标注的合成资料，不代表真实研究。该评测实际调用 UNO 的 `HarnessGateway.stageUnoKnowledge`、`publishUnoKnowledge`、`collectThinkingContext` 和 `buildQuickRequest`，只使用新建的临时知识库。

运行：

```powershell
node --test tests/uno-construction-effects.test.mjs
node tools/evaluate-construction.mjs --output "$env:TEMP/uno-construction-effects"
```

脚本会在输出目录下创建唯一子目录，不覆盖既有知识库，不联网、不调用模型。`effects.json` 保留修订动作、Harness 收据、前后正文、来源哈希、真实检索上下文和检查结果。

| 案例 | 观察目标 | 反向对照 |
|---|---|---|
| duplicate-merge | 同一对象不重复召回，两份来源、观察窗口、替代解释及旧卡历史均保留 | 来源文件虽然保留，合并正文却删除替代解释，应判失败 |
| counterexample-navigation | 低词面匹配的反例候选进入实际检索，且仍明确是导航线索 | 将整理者导航误标成来源已有论证，应判失败 |
| viewpoint-conflict | 分别保留作者、对象、时限和条件，通过比较导航一起召回 | 将不同作者合并为一张卡，即使全部来源仍在，也应判失败 |

预设动作和审核决定来自固定案例，不能证明模型会自主选择正确的建构动作。通过确定性检查也不能证明回答质量已改善；不使用卡片数或连边数作为通用质量分数。

`answer-plan.json` 准备恰好两个匿名请求，每次批量回答三道独立问题：相同问题、系统规则、无历史、无工具，只改变各题检索所得材料。它没有模型配置、凭据或网络执行器。由负责实验的宿主使用既有共享预算账本发送，每项只发一次，关闭自动重试，冻结同一模型和相同参数并保留原始响应与用量。一次请求内批量包含三题只节省调用，不能视为三个独立统计试验；也不评估意图路由。

`answer-review-private.json` 单独保存匿名条件映射与语义评分要求，不能发给回答模型。应先盲审回答中的归属、关键条件、支持程度、引用合法性和因果夸大，再揭示前后条件。尚未运行真实回答时，`answer_quality_tested` 必须保持 `false`。
