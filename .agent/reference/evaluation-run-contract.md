# 思维体评测运行契约

## 一、职责分离

  `nexo-judge` 约束模型在单个 checkpoint 内如何判断；评测运行器负责材料装载、时点隔离、模型参数、重复运行、输出保存和评分。Skill 不得读取 evaluator、outcomes、checksum、未来 checkpoint 或生产知识体，也不得自行修改实验 profile。

## 二、运行范围

  评测 run 的 `scope` 至少应包含 `case_id`、`current_checkpoint`、`as_of`、`execution_profile`、允许的 Thinking Model 和允许的 Operator。T1 之后还应包含 `previous_checkpoint` 与不可变的 `previous_output`。没有这些字段时，模型应明确指出运行契约不完整，不得自行寻找答案文件补齐。

  隔离由运行器和临时项目根强制执行。Skill 只能使用当前会话实际暴露的工具；工具不可用、预算耗尽或访问被拒绝时，应保留未知项并停止，不能换用任意文件读取或网络搜索绕过限制。

## 三、证据与更新

  核心判断使用 `card_id` 或 `card_id#unit-id` 作为锚点，并为每项标注 `support`、`counter`、`boundary`、`background` 或 `inference`，同时挂接稳定的 `claim_id`。只有本轮真实精读过的地址才可进入答案。

  T1 之后先读取冻结的上一轮输出。最终结果只能说明 `changed`、`unchanged` 和原因，不得回写或重新生成过去 checkpoint。风险信号、传导路径和目标事件必须分开；新增证据不足时，保持判断也是合法更新。

## 四、输出

  运行器提供输出 Schema 时，最终回答只输出符合 Schema 的 JSON，不附加 Markdown 围栏或解释。确定性校验失败时，只修复格式、交叉字段或锚点问题，不改变已经冻结的历史答案。

  Episode 保存工具 Observation、Workspace 差异、证据锚点、TM 选择和停止原因，不保存隐藏思维链。评分程序与人工评分表对模型不可见。
