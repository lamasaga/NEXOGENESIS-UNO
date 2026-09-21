---
name: nexo-judge
description: |
  Nexogenesis 思维体评测：在冻结材料、时点、工具和输出契约下执行只读 checkpoint 判断，并保留可核验的证据与更新轨迹。
  当用户说「运行思维体测试」「认知评测」「/judge」，或评测运行器启动固定案例时触发；普通多维研判使用 nexo-assess。
---

# Grounding

  先区分测试目的：固定材料与时点的认知评测使用本文；用户明确测试 TM/OPS 执行或使用 /deep-think 时转 nexo-deep-think 的固定执行配置。普通「深入思考」仍是正常分析，不属于评测。执行次数只证明工具闭环，认知质量另看证据忠实度、判断改变、成本与稳定性。

1. `.agent/reference/evaluation-run-contract.md` — 隔离、checkpoint、证据和输出边界。
2. `.agent/reference/thinking-output-contract.md` — 证据等级与可审计输出。
3. 当前 run 的 Workspace scope — 本轮唯一可用的案例、时点、profile、TM 与 OPS 范围。

# Workflow

1. 检查当前 run 的 case、checkpoint、`as_of`、执行 profile 和允许能力；契约缺失时指出缺口，不自行读取测试目录或答案文件。
2. 有上一时点时调用 `inspect_checkpoint_state` 读取冻结输出，后续只记录改变与未改变，不重写历史判断。
3. 从允许列表中选择与问题匹配的 Thinking Model。序贯任务优先考虑 `sequential-belief-update`；实验性模型只有 scope 显式允许时才可选。
4. 自主选择必要的检索、比较和精读操作。核心结论必须挂接本轮真实精读过的 Card 或 Card unit；召回摘要、路径、领域隶属和来源归因不能代替正文证据。
5. 用 `inspect_evidence_set` 检查支持、反证、边界、来源独立性和对象覆盖，再用 `verify_evidence_anchors` 核验最终使用的地址。工具只检查确定性事实，语义适配仍由本轮判断承担。
6. 按当前输出 Schema 形成答案，并用 `finish_cognitive_run` 保存 changed、unchanged、pending、previous checkpoint 和证据锚点。最终回答只输出 Schema 要求的数据。

# Invariants

- 全程只读：不写 Card、Buffer、Profile、OutBox，不创建提案。
- 不访问 evaluator、outcomes、调研综述、checksum、未来 checkpoint、网络或生产知识体。
- 不因知道历史事件名称而引入当前 `as_of` 之后的信息；命名版与匿名版遵守同一证据边界。
- 风险发生、渠道存在和目标事件发生是三个不同判断。
- 工具拒绝、预算不足或证据缺失必须显式留作未知，不得用常识补成已验证事实。
