# Web Agent Runtime：进度快照与目标清单（2026-08-10 暂停点）

> 用途：任务暂停时的状态记录与恢复指引。配套文档：
> 愿景 `docs/specs/2026-08-10-agent一体化需求模式与差距清单.md`、
> 设计 `docs/specs/2026-08-10-web-agent-runtime-design.md`、
> 实施计划 `docs/plans/2026-08-10-web-agent-runtime.md`（9 任务详细步骤与完整代码）。

---

## 一、今日已完成工作（2026-08-10）

### 1. Web 对话三问题修复（已上线实践仓）

| 问题 | 修复 | 开发仓提交 |
|---|---|---|
| 无流式输出 | `POST /api/chat/stream` SSE 流式端点 + 前端 fetch 流读取 | `7266127` `98c2372` `52a4488` `bf326a7` `81f0359` |
| 无 Markdown 渲染 | react-markdown + remark-gfm | `b06d856` |
| 图谱检索不点亮 | 根因①实践仓 RAG 索引残缺（已全量重建 26→5455 chunks）；根因②FTS5 把整段中文当单 token，长问句零命中 → LIKE 兜底改 CJK bigram OR + 命中数排序 | `8366b0c` |

另：chat 路径加了**索引保鲜**（检索前增量刷新 RAG，防静默退化）；`AGENTS.md` 新增 §八双仓联动速查（`e4b6551`）。

### 2. 架构方向确立（文档）

- `docs/specs/2026-08-10-agent一体化需求模式与差距清单.md` — 一体化愿景 + 五层检查表（Loop/Tools/Context/Playbooks/Discipline）+ 差距清单 A–H
- `docs/specs/2026-08-10-web-agent-runtime-design.md` — 对话即 agent 设计（talk/emerge/judge 三技能，触发词硬路由+模型兜底，写卡走对话内确认卡）
- `docs/plans/2026-08-10-web-agent-runtime.md` — 9 任务 TDD 实施计划（含全部代码）

### 3. 实施进度（9 任务全部完成，2026-08-11）

- [x] **Task 1: 提取 `execute_batch`**（`1c4515c`）——`write --batch` 的程序化入口，返回 created/enriched；CLI 变薄壳
- [x] **Task 2: `runtime/pending_writes.py`**——提案存取与 `pending → processing → terminal` 状态流
- [x] **Task 3: `runtime/agent.py` 基础件**——技能路由、剧本加载、流式 `tool_calls` 重组
- [x] **Task 4: `runtime/agent_tools.py`**——真实 retrieve/read_card/propose_write；提案复用完整 staging 预校验
- [x] **Task 5: `run_agent_stream` 循环**——≤6 轮、强制终答、真实 sources 帧
- [x] **Task 6: 端点接线**——`/api/chat/stream` 已换 agent loop；`/api/write/confirm` 已接线
- [x] **Task 7: 前端帧协议扩展 + confirmWrite**
- [x] **Task 8: 前端渲染**——步骤线、来源芯片、确认卡与对话 UI 优化
- [x] **Task 9: 全量回归 + 实践仓同步 + live 走查**——开发/实践仓均 234 后端测试、31 前端测试及生产构建通过；金融库只读 live 对话已验证

---

## 二、恢复指引（下次继续时）

1. Runtime 实施已完成；下一步是持续收集真实使用证据，优先核验写入提案确认体验与 judge 的透镜质量。
2. 环境约定：
   ```bash
   cd "D:/UESR/Desktop/Nexogenesis智构涌现/Nexogenesis-org"
   export PATH="/c/Users/MECHREVO/AppData/Local/Programs/Python/Python313:$PATH"
   ```
   前端命令在 `web/` 下；每个 Task 末尾 commit（pre-commit 钩子需要上述 PATH）
3. 实施提交：`08d9ced feat(web): 接入多技能 agent runtime 与确认写入`。`propose_write` 使用 `preflight_batch`，与实际写入共用 staging 校验。
4. 已知约束：`card_meta_from_write` 要求 write 项含 `lifecycle/created/updated`；`run_validate` 要求 domains 有对应 domain 卡片。

## 三、遗留事项（与主任务无关）

- 开发仓工作区有 2 处未提交修改：`.agent/reference/constraint-layers.md`、`thinking-body.md`（失效链接修正，此前会话留下，待用户确认是否提交）
- 开发仓 main 领先 GitHub origin/main 30+ 提交，是否 push 由用户决定
- 实践仓已合并 `dev/main` 至 `c291ca0`；Web 服务运行于 `127.0.0.1:8787`。
