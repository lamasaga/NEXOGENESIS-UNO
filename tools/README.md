# tools/：历史入口说明

  当前知识工具不在本目录，而位于 `packages/nexogenesis-tools/`。工具数量、参数、能力和风险等级以 `packages/nexogenesis-tools/lib/index.js` 注册的运行时 JSON Schema 为准，不在 README 中复制一份容易过时的清单。

  当前工具分为四类：Card 与 Buffer 读取、Compile 材料操作、GraphOps 观察、Harness 写入提案。Thinking Model 只能选择已注册能力，Skill 不能自行发明工具，任何 Card 实质写入必须经过 HarnessGateway。

  运行契约见[《2026-08-30 TM、Skill、OPS 与知识流程统一实施 SPEC》](../docs/history/pre-uno/2026-08-30-TM-Skill-OPS与知识流程统一实施SPEC.md)，当前可用能力和限制见[主运行文档](../docs/history/pre-uno/2026-08-30-当前实现、运行与限制.md)。

## Card 内部语义单元迁移

  `node tools/annotate-card-units.mjs --root=.` 默认只做干跑，统计符合优先池与实质章节门槛的卡片；增加 `--apply` 后，脚本以每批 1～3 张 content 操作调用 HarnessGateway。它只插入稳定地址，不修改知识正文，并跳过已有人工地址的卡片。

## 历史情景评测

  `tools/eval/` 保存测试集维护和单次答案评分脚本。它们检查测试资产与跨字段一致性，不属于生产知识工具，也不负责调用模型。使用方法见 [`tools/eval/README.md`](eval/README.md)。

## 历史关系迁移审计

  `node tools/audit-legacy-relations.mjs --root=.` 只读扫描当前活跃 Card，把 `legacy_candidate` 按冲突角色错误、直接证据候选、语义复核和移除复核分组，并写入 `.nexogenesis/graph/legacy-relations-audit.json`。分组只决定复核顺序，不自动生成 note，也不直接修改 Markdown。

  `node tools/migrate-legacy-relations.mjs --root=. --phase=conflict-contract` 默认只生成冲突档案迁移计划。增加 `--apply` 后，它会通过 HarnessGateway 分批移除 conflict 的非 `involves` 出边，并只为正文中明确点名参与方的旧 `involves` 补充证据说明；无法直接举证的参与方关系仍保留在待核验队列。

  `--phase=reciprocal-conflict-edges` 清理由具体立场卡反向指向争议档案、且档案已经通过 `involves` 收录该立场的重复边。它只删除重复结构，不把语义不明的其他入边一并清空。

  对需要逐条语义裁决的关系，使用 `node tools/apply-relation-decisions.mjs --root=. --decisions=<json>` 先执行全批预检，增加 `--apply` 后再提交。决定文件只描述 `upsert/remove` 原子动作；工具从磁盘读取完整 Card，通过 HarnessGateway 分批写入，避免人工转抄正文和元数据。

  `review-legacy-relations-with-model.mjs` 用当前环境中的 DeepSeek 配置逐个局部簇生成只读语义审稿结果，默认只跑一个来源簇并写 JSONL；它不读取或打印密钥，也不写知识体。`compile-relation-review-decisions.mjs` 再把通过本地签名和就绪检查的审稿结果编译为决定文件，最后仍由上述 HarnessGateway 工具预检与提交。

## 建构关系评测准备

  `node tools/eval/prepare-construct-cases.mjs --root=. --limit=100 --output=tmp/construct-eval-candidates.jsonl` 从历史关系审稿 JSONL 中去重，并尽量按保留、改型/改向、移除、延期平衡抽取候选。输出明确标记为 `candidate_requires_human_validation`：它只是一份人工精选清单，尚缺裁决时端点版本、支持/反证/边界锚点和风险标签，不能直接作为黄金答案。
