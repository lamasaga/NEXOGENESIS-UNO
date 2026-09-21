# Nexogenesis

**当前版本：`v2.0`**（重大里程碑：独立 Web Agent、可视化知识调用与知识体摄入工作流）

  查阅历史版本：`git tag -l`。近期锚点：`v1.6` 约束与技能分层，`v1.7` Agent 架构重构，`v2.0` 形成可运行的 Web Agent、图谱动效、对话沉淀以及 compile / digest / construct 工作流。

面向社科领域的知识架构体系：用大模型把领域思想**结构化**为可支撑推理、分析与判断的知识体，同时沉淀可被思维体复用的领域级思考特质。

- **知识体**：`01-Cards/` + `05-Buffer/` 沉淀领域对象（主张、模型、现象、方法、实体、冲突、领域）。
- **思维体**：`nexo-talk` / `nexo-judge` / `nexo-emerge` 利用知识结构进行推理、分析与判断，不替代知识体写入。
- **领域 Profile**：`02-Profile/领域理念.md` 与 `02-Profile/领域思维范式.md` 记录领域级立场、价值取向、心智模型与推理模式，供思维体作为透镜复用。

系统强调**聚合涌现**，不是把书自动切成碎片的批处理器。

- **第一次了解项目** → [`docs/项目快速理解.md`](docs/项目快速理解.md)（推荐从这里读；后续将迁入 `.agent/reference/`）
- **约束分层（宪法 / Skills / 环节）** → [`.agent/reference/constraint-layers.md`](.agent/reference/constraint-layers.md)
- **日常命令与 AI 规矩** → [`AGENTS.md`](AGENTS.md)（宪法层）；完整 CLI 见 [`.agent/reference/harness-cli.md`](.agent/reference/harness-cli.md)
- **Agent 编排技能** → [`.agent/skills/`](.agent/skills/)（`nexo-talk` / `nexo-emerge` / `nexo-judge` / `nexo-compile` / `nexo-digest` / `nexo-construct`）
- **卡片正文结构** → [`.agent/reference/card-contracts/body-structure.md`](.agent/reference/card-contracts/body-structure.md)
- **卡片写法正例** → [`.agent/reference/card-contracts/card-exemplars/`](.agent/reference/card-contracts/card-exemplars/)

技术专题：[`.agent/reference/retrieval-design.md`](.agent/reference/retrieval-design.md)（双轨检索）、[`.agent/reference/thinking-body.md`](.agent/reference/thinking-body.md)（思维体记忆与注意力）。

## 快速开始

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
python -m nexogenesis init
python -m nexogenesis validate
python -m nexogenesis doctor
python -m nexogenesis compile --plan   # 预览 Inbox 分波；默认每波少量文档
# compile 后先 --check-responses，再 --apply（可 --response 逐个落盘）
# digest --auto（Agent 自审 batch 后落盘）；construct --auto → --auto --lens …
# 完整 CLI 列表见 .agent/reference/harness-cli.md
```
