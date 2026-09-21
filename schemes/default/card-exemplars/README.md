# 卡片写法正例（card-exemplars）

　　本目录是编译、建构、涌现、精修与审核提示的**写法参考**，不是正式知识库卡片（不得通过 DSH 写入工具把样例 id 当生产卡写入）。
　　活契约：`../body-structure.md`。

## 落点

| 位置 | 用途 |
|------|------|
| `schemes/default/card-exemplars/` | 方案源；`init` 复制到项目 |
| `.agent/reference/card-contracts/card-exemplars/` | 运行时正例（与 body-structure 同级） |

## 一览

| 文件 | type | 说明 |
|------|------|------|
| `concept-制度惯性.md` | concept | 定义、特征与近邻辨析 |
| `claim-慈善攀比动机污染.md` | claim | 开篇即主张，无人话导读套层 |
| `mechanism-数量考核导致复杂事项积压.md` | mechanism | 条件 → 行为反应 → 结果 → 失效边界 |
| `model-有闲阶级作为保守力量.md` | model | 开篇即核心思想；组件有职责 |
| `phenomenon-古雅措辞炫耀性浪费.md` | phenomenon | 诠释与模式描述分工 |
| `conflict-管理替代与时间购买.md` | conflict | 诠释 + 两钉分歧；system 构造对手须标明 |
| `conflict-投资银行家功能边界.md` | conflict | 结构克制的经典冲突 |
| `method-观察炫耀性浪费迹象.md` | method | 输入→步骤→输出 |
| `case-甲港协商过程.md` | case | 情境、过程、结果与有限启示 |
| `undetermined-多领域年度任务并列安排.md` | undetermined | 完整保存计划性安排，不伪装成模型、方法或现象 |
| `entity-有闲阶级.md` | entity | 开篇即定义 |
| `entity-人物.md` | entity | 人物别名归一、思想归因与传记边界 |
| `entity-机构.md` | entity | 机构主体、制度角色与时点边界 |

## 反例（勿模仿）

- 把书名、章节名或临时关键词写成领域；领域定义应单独维护在 `01-Cards/_meta/domains/`
- 同时把一张卡标成多个主类型，或以旧 `tags/topics` 代替 `type/domains`
- 主张用分号串三条机制
- 模型组件是名词子弹
- claim/model 再套一层与核心重复的「导读」
- conflict 开六条并列「核心分歧」
