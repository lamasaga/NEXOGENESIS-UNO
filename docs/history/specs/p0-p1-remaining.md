# P0 / P1 进度与剩余工作

> 日期：2026-07-29  
> 依据：`AGENTS.md`、双轨检索与思维体草案、金融库实卡反馈。  
> 本文回答「阶段还缺什么」；细节实现以代码与专题设计为准。

---

## 阶段怎么划

| 阶段 | 含义（本项目口径） |
|------|-------------------|
| **P0** | 底座 + 统一写入 + 摄入闭环可用；对话捕获靠 Agent 按契约执行；真实使用可跑通 |
| **P1** | 检索与结构反馈闭环产品化；思维体编排可复现；指标与体验协议硬化 |
| **延后** | 向量 embedding、Web UI、多 Agent、联邦等——须有证据再开 |

---

## P0：已完成（Harness）

- [x] 目录 / scheme / init / validate / index / write --batch / doctor / Journal  
- [x] Buffer（role）↔ Card（type）分层；body-structure 契约  
- [x] compile 分波 + check-responses + 部分 apply  
- [x] digest / construct 分波、镜头、`--auto` 自检落盘  
- [x] 双轨检索：graph + RAG(FTS) + `retrieve` Context Package  
- [x] graph analyze / export；write 后刷新 index·图·RAG  
- [x] 思维体基建：`attention.yaml`、STM（约 10 会话）、双账户组装、强信号  
- [x] CLI 速查（`AGENTS.md` §5.0）；项目快速理解文档  
- [x] markdown 语义主权 / git 版本层表述澄清  
- [x] （2026-07-29）digest/construct 补边与 involves 纪律；结构信号汇总；doctor 图谱偏稀 WARNING  
- [x] （2026-07-29）retrieve `type_priors`；边质量诊断（applies-to 过载）；事实外查纪律写入 prompt/AGENTS  

---

## P0：未完成或仅「契约有、产品未硬化」

| 项 | 状态 | 说明 |
|----|------|------|
| 真实对话 10–20 次验收 | ⏳ 使用证据 | `AGENTS.md` §六；金融库偏摄入，对话闭环待补 |
| `/talk` `/capture` `/answer` 专用 CLI | ❌ 刻意偏 Agent | 现靠 Agent + `retrieve` / `write`；可选 P1 做 prompt 命令 |
| 捕获去重（验收 #2） | ⚠️ 半自动 | 靠 LLM + 目录对照，无确定性「同题合并」引擎 |
| 归因纪律可测（验收 #7） | ⚠️ 靠纪律 | 无自动化抽检；discussion nascent 已标 |
| 使用指标落盘（验收 #10） | ❌ | 接受率 / 复用率 / 纠正率尚未有最小日志格式 |
| Synthesis 正式写入路径 | ⚠️ | OutBox 可手写；无 schema/命令 |
| 问题清单增强（关联卡、answered） | ❌ 非 P0 必需 | 现行三列表已符合 write 契约 |
| 向量 / 混合检索 | 延后 | R6 |

**P0 使用侧建议（金融库已暴露）：** 下一轮 construct 优先 `distinguish` + `articulate` **补边**，再扩卡。

---

## P1：目标与缺口

P1 不是「再堆功能」，而是让思维体与结构反馈在真实使用中可复现、可度量。

| 主题 | 已有 | 仍缺 |
|------|------|------|
| **对话面协议产品化** | §4.8 + STM/attention/signal | Agent 默认剧本固化；可选 `talk-context` 一键包 |
| **捕获闸门 UX** | write batch | 自然语言候选→batch 的标准模板与去重辅助 |
| **结构反馈闭环** | graph analyze + construct_ops + **边质量诊断**（applies-to 过载/语义边不足）+ seed-links | 语义边半自动建议；桥接跨 domain |
| **检索答题骨架** | attention `type_priors`：提 model/conflict/entity，压图表 phenomenon | 会话级覆盖调参 UX |
| **事实外查纪律** | digest/construct prompt 明示序列不入库 | 可选「事实笔记」目录约定（仍非 Card） |
| **图谱健康** | doctor 偏稀 WARNING、信号汇总 | 目标：实例卡平均 ≥2 语义出边；conflict 全员 involves |
| **评测** | 设计稿有 Recall 思路 | 黄金问答题集；归因错误率抽样 |
| **理论升格 `/theorize`** | theory_status + theory-index | 升格工作流与失效边界检查产品化 |
| **判断升级 `/judge`** | retrieve mode=judge | 2–4 透镜 prompt 与可选 OutBox |
| **深反思** | Journal 一行 | 摩擦模式报告（用户触发） |
| **向量 EBD** | — | 仅当 FTS+图不够再开 |

---

## 建议推进顺序（近期）

1. **金融库：先立房价/政策时间线 entity + 文档—事实 conflict，再 articulate 补语义边**（收益大于再全库 construct）  
2. **补最小使用指标**（例如 Journal 旁或 `.nexogenesis/metrics.yaml` 记 capture 批/驳）——关闭 P0 §六 #10  
3. **对话捕获跑通 10 次**——关闭 P0 主验收  
4. **P1**：talk 上下文一键包 + conflict involves 自检进 validate（warning）  

---

## 与「公版教材」疑问的对齐

　　P0/P1 不追求「让模型背会教材」；剩余工作应优先服务：**架构可演进、边可检索、讨论受约束、归因可分**。详见 `docs/项目快速理解.md` 常见疑问一节。
