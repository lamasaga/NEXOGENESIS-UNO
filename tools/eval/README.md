# 思维体评测准备工具

  本目录只处理测试资产、隔离快照、运行计划和确定性结构检查，不属于生产 OPS，也不读取 `evaluator/` 中的答案来提示模型。

## 1. 校验四套案例

```powershell
node tools/eval/schema.mjs
```

  命令检查案例必需文件、checkpoint 顺序、A/B/C/D profile、fixture release 和 checksum。警告不等于失败；错误会返回非零退出码。

## 2. 生成一个隔离 checkpoint

```powershell
node tools/eval/materialize-fixture.mjs --case FT-003 --checkpoint T2 --variant anonymous --profile E_thinking_body_v1
```

  未指定 `--output` 时写入系统临时目录。临时根只复制该 checkpoint 可见的 Card、Archive、问题、输出 Schema、允许的 Skill/Thinking Model 和运行 scope，不复制 outcomes、rubric、checksum 或生产知识体。

## 3. 准备顺序运行计划

```powershell
node tools/eval/runner.mjs --case FT-004 --profile E_thinking_body_v1 --variant anonymous --repeat 3 --output tmp/eval-ft004
```

  `run-plan.json` 给出每次重复、每个 checkpoint 的隔离根、上一答案路径和目标答案路径。当前版本不调用模型；接入 DSH 适配器时，必须在同一重复内把上一答案内容写入下一 checkpoint 的 `scope.previous_output`，不同重复不得共享会话。

## 4. 检查单份答案结构

```powershell
node tools/eval/score.mjs --schema tmp/eval-ft004/repeat-1/T0/.eval/output-schema.json --answer tmp/eval-ft004/repeat-1/answers/T0.json --as-of 1994-03-25T23:59:59Z
```

  当前评分只覆盖 JSON Schema、概率和、区间嵌套、排名唯一和 `as_of`。Brier、MAE、结果命中和人工盲评仍由案例 evaluator 与后续模型适配层完成。

## 对照 profile

- `D_skill_only`：GraphOps + `nexo-judge`，不允许 TM。
- `D_tm_only`：GraphOps + TM，不加载专用 Skill。
- `E_thinking_body_v1`：GraphOps + `nexo-judge` + 稳定 TM；FT-002、FT-003 额外允许各自的实验候选 TM。

  先比较案例自带的 A/B/C/D，再使用以上 overlay 做单变量消融。实验性 TM 只因 scope 显式允许而可选，不自动进入普通分析。
