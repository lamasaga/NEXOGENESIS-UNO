# 上游 nexogenesis-org 进展核对（2026-08-19）

> 目的：核对原项目（只读参考仓）自融合基线（2026-08-16 复制）以来的最新进展，评估对融合仓的影响与待决策项。
> 核对对象：`D:\UESR\Desktop\Nexogenesis智构涌现\Nexogenesis-org`（HEAD `50c7ba2`，2026-08-18 02:17）
> 方法：git log/diff 自 2026-08-16 以来的 7 个提交 + 与融合仓当前文件的内容级比对。

---

## 1. 上游提交（自 2026-08-16，7 个）

| 提交 | 内容 |
|---|---|
| `ed330a1` | fix(ingest): frontmatter 闭合 `---` 自动修复与 chunker 空阅读窗合并健壮性 |
| `489d731` | fix(prompts): compile-essay 模板注入质量样本与 quality_contract |
| `e8b28e5` | fix(batch_runner): 去除 LLM 重复写的 frontmatter 分隔线 |
| `2c8b5a4` | fix(yaml_utils): split_frontmatter 正确处理字段值中的 `---` |
| `c2fb06b` | feat(compile): preprocess books into chapter markdown（书籍预切章） |
| `8a95423` | refactor(core+digest): **能力内核双执行平面重构** + digest 检索兜底修复 |
| `50c7ba2` | feat(digest): **v2.1 消化双执行平面与 enrich 段落补丁**（HEAD） |
| `dd41a0b` | feat: **v2.2 GraphOps 思考循环**（2026-08-19 01:41，用户已 git 入库）——`nexogenesis/graph/ops.py`（GraphOps 闭集：search/members/walk/conflicts/analogize/read/note_debt + 观察学分）、论证边/隶属分账（traverse.py is_argument_edge）、编译表图质料（artifacts.py/figure_vision.py）、消化失败改选；设计文档 `docs/specs/2026-08-18-图谱操作层与思考循环.md` |

## 2. 重大变化

### 2.1 思维体结构重构：9 SKILL → 2 SKILL + 6 web-skills 策略

- `.agent/skills/` 从 9 个 SKILL.md **删到只剩 2 个**：`nexo-compile`、`nexo-digest`（Code Agent 平面）。
- talk / emerge / assess / refine / report / construct 迁移为 `schemes/default/web-skills/*.md`（**Web 平面策略文档**，无 SKILL.md frontmatter，非 DSH skill 格式）。
- AGENTS.md 语义变化：「Code Agent 只能执行 compile 与 digest；建构以及 talk/emerge/assess/refine/report 均属 DeepSeek + Web 执行平面，不得由外部 Code Agent 自行编排」。

### 2.2 双执行平面实现落地（Python 侧）

- 新增 `nexogenesis/application/`（ports / context / run_manager / workflows：compile/construct/dialogue/digest/lifecycle）、`adapters/`（model：deepseek/external_agent；events：callback/composite/journal/memory/web_graph；writes/harness；checkpoints/json_store）、`policies/`（compile/dialogue）。
- 服务化：`compile_service` / `digest_service` / `construct_service`、`digest_index`、`book_material`（书→章 markdown）、`docx_extractor`、`card_overlay`。
- digest v2.1：enrich 段落补丁、两阶段路由（新 prompts：`digest-route.txt`、`shared/digest-constitution.txt`、`shared/digest-write-contract.txt`）。
- 新 spec：`docs/specs/2026-08-16-compile-apply-archive-unit-id-mismatch.md`（compile apply 归档判定问题记录）。

### 2.3 Web v2.0 → v2.1（API 契约不变，仅 Settings 增可选字段）

- 内容级 diff（融合仓 vs 上游，排除 node_modules/dist）共 10 个文件不同：
  - `src/api/client.ts`：Settings 接口新增 `digest_two_stage?: boolean`（两阶段路由消化开关）；其余端点/帧协议**未变**。
  - `src/components/SettingsModal.tsx`：新增「两阶段路由消化」勾选。
  - `src/App.tsx`：新增浏览历史 / 收藏 / 帮助菜单、空知识库引导。
  - `src/activation/engine.ts`、`theme.ts`、`graph/render.ts`：动画/视觉微调。
  - `package.json` 2.0.0 → 2.1.0。
- **兼容层影响**：上游前端新增的 `digest_two_stage` 字段会被融合仓 `/api/settings` PUT 忽略（settings.js 只 patch 已知字段），不破坏现有契约；但该设置不会持久化。

### 2.4 AGENTS.md v2.0 → v2.1

- 版本行更新为 v2.1（2026-08-18）；思维体索引表改为「Code Agent Skill 索引」；知识体/思维体表述更新。

## 3. 对融合仓的影响与待决策项

| 项 | 现状（融合仓） | 上游 v2.1 | 影响 / 待决策 |
|---|---|---|---|
| `.agent/skills` | 9 个 SKILL.md（v2.0 结构） | 仅 compile/digest 保留 SKILL.md，其余迁 web-skills | ✅ **已决策（2026-08-19）**：不对齐——单体系，9 技能保持统一 DSH 技能集（见 `2026-08-19-单体系架构决策-不追随上游双执行平面.md`） |
| `AGENTS.md` | v2.0 副本 | v2.1 | ✅ **已决策**：不跟进 v2.1 的 Code Agent 纪律，保持 v2.0 语义（单体系） |
| digest 语义 | 无 enrich 段落补丁/两阶段路由 | v2.1 落地 | 融合的 propose_write/confirm_write 是"整卡替换"；上游 enrich 段落补丁是更精细的丰富语义，可作 M5 质量增强参考 |
| compile | 无书籍预处理/apply 归档 | book_material + apply 归档 | 融合的 compile 以「会话 + 技能 + write_buffer」实现；是否引入书→章预处理待定 |
| Web 前端 | v2.0（无 digest_two_stage/历史/收藏） | v2.1 | 可同步；若同步需在 `/api/settings` 增加 `digest_two_stage` 支持 |
| Python 实现 | 占位（JS 检索已取代 RAG） | 双执行平面落地 | 两条路线独立：融合不追随 Python 实现；上游的健壮性修复（frontmatter 闭合、yaml 字段值 `---`、chunker 空窗）可作 JS 解析器/检索的对照清单 |
| 知识体 | 718 卡 / 2675 条 relations（解析器修复后） | 实践仓 732 卡 / 2665 条 | 实践仓继续演进（08-18 合并 v2.1）；融合知识体独立，单向镜像纪律不变 |

## 4. 本次核对顺带解决的问题（详见 `docs/baseline/2026-08-19-全端点冒烟.md`）

1. **frontmatter 顶格列表解析缺陷**（graph.js/cards.js 双份）→ 修复后图谱边 17→2669、领域索引 29 个、检索扩散恢复——与上游「yaml 健壮性」系列修复同向，但发生在 JS 侧。
2. meta.js 缓存失效机制修复。

## 5. 结论

- 融合仓（DSH 栈）与原项目（Python 栈）已**实质性分叉**：上游继续演进 Python 双执行平面，融合仓以 DSH 为唯一执行平面。
- **架构定调（2026-08-19 用户确认）**：融合仓是**单体系**——Web 界面 + DSH agent 一体，不追随上游双执行平面（详见 `docs/specs/2026-08-19-单体系架构决策-不追随上游双执行平面.md`）。
- **v2.2 GraphOps（2026-08-19）**：上游落地 GraphOps 思考循环；融合仓已按单体系移植为 DSH 工具（graph_search/walk/members/analogize/note + read_card slots），见 `docs/specs/2026-08-19-思维体思考机制分析与agent-loop优化路径.md` §3.1。
- 近期最值得跟进的上游成果：① web v2.1 前端（体验增强，契约兼容——已同步）；② digest v2.1 的 enrich 段落补丁语义（质量增强参考）；③ yaml 健壮性修复清单（JS 解析器对照，顶格列表解析已修复）。
- 上游 skill 结构变化（9→2+6）**不影响**融合仓现有 preset 的自洽运行；按单体系决策，不做对齐。
