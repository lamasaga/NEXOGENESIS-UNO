# Nexogenesis Web 前端与图谱可视化设计（A 阶段 · 前端优先切片）

> 日期：2026-08-08
> 状态：待用户审阅
> 上游文档：`docs/specs/2026-08-07-独立agent-runtime-design.md`（本设计落实其 §3.6 事件总线与 §3.7 Web 前端，并据视觉方向决议修订技术选型）
> 前提决议（本次 brainstorm 确认）：
> 1. **前端优先 + 事件模拟**：本切片不做 LLM provider/loop/skill runtime（M1–M3），以真实图谱数据 + 后端事件模拟器驱动，先交付界面与图谱可视化。
> 2. **视觉方向**：束主导（D1）+ 有机神经风（A）——节点降级为「突触小结」（平时不显标题），边按 domain/关系类型汇聚成多股纤维束；激活时纤维沿走向逐段顺序点亮，无移动光点；3D 搁置。
> 3. **终局约束**：服务器可部署 + Win/Mac 桌面可安装；UI 精致度对标现代 AI 应用；知识体规模目标 3000–5000 节点。

---

## 一、目标与非目标

**目标：**

- `python -m nexogenesis serve` 启动 Web 应用：中央纤维束知识图谱 + 对话面板壳 + 事件日志 + 卡片阅读器。
- 图谱静息态可读（密集神经束聚合形态），agent 活动时呈现区域激活与信息流（逐段顺序点亮、涟漪、泛光、标题浮现）。
- 事件协议（SSE）成为本切片最重要的产物：未来 M1–M3 的 agent loop 接上事件总线时，前端零改动。
- 现有 harness 行为零改动；CLI + code agent 路径继续可用。

**非目标：**

- LLM 调用、真实 agent loop、HITL 确认队列（M1–M3，后续切片）。
- Tauri/Electron 桌面打包工程（后续阶段；本切片仅遵守前后端分离纪律为之铺路）。
- WebGL 渲染器（规模退路，渲染接口已隔离）。
- 3D 可视化（已否决，留作远期可选皮肤）。

## 二、技术选型（对上游 spec §3.7 的修订）

| 项 | 决策 | 理由 |
|---|---|---|
| 前端框架 | **React + Vite + TypeScript + Tailwind** | 「AI 应用级精致度」需要组件化生态；上游 spec 的 Cytoscape 方案因做不出束渲染而否决 |
| 图谱渲染 | **自研分层 Canvas2D**（渲染接口隔离） | 视觉原型（Canvas2D）已验证；5000 节点靠静息层离屏缓存达成 60fps；万级再换 WebGL |
| 布局 | **服务端预计算**，坐标落盘 `.nexogenesis/graph/layout.json` | 浏览器跑 5000 节点力导向是浪费；预算布局保证束形态稳定可控 |
| 桌面壳（后续阶段） | Tauri 2 + PyInstaller sidecar | 安装包 ~10MB 级；本阶段只需保证前端只经 HTTP/SSE 通信 |
| 后端 | FastAPI + uvicorn（`nexogenesis serve`） | 与上游 spec 一致；runtime 只 import harness 函数，不起 subprocess |

## 三、总体架构

```
┌─ React SPA（web/，Vite 构建，FastAPI 托管产物）──────────┐
│  GraphCanvas   分层 Canvas2D 束渲染器（静息层/激活层/标注层）│
│  ActivationEngine  SSE 事件 → 激活状态机（束热力/突触亮度）   │
│  ChatPanel     对话面板（本阶段为模拟剧本驱动，不接 LLM）     │
│  EventLog      事件流面板（协议可视化，可折叠）              │
│  CardReader    卡片阅读器（点击突触 → 抽屉式打开）           │
└──────▲───────────────────────────────────▲────────────────┘
       │ REST（只读）                        │ SSE
┌──────┴───────────────────────────────────┴────────────────┐
│  FastAPI server（python -m nexogenesis serve）             │
│    runtime/api.py       /api/graph /api/cards/{id} …       │
│    runtime/layout.py    布局预计算 → layout.json            │
│    runtime/events.py    事件总线（pub/sub → SSE 广播）       │
│    runtime/simulate.py  事件模拟器：judge/talk/digest 剧本   │
└──────┬─────────────────────────────────────────────────────┘
       │ 只读调用（import，非 subprocess）
┌──────┴─────────────────────────────────────────────────────┐
│  现有 harness：graph export / 卡片读取 —— 零改动            │
└────────────────────────────────────────────────────────────┘
```

**纪律继承：** 新增代码全部在 `nexogenesis/runtime/` 与 `web/`；harness 零改动；markdown 仍是唯一语义事实之源；本切片 runtime 只读，不引入任何新状态存储（layout.json 是可重建索引，与 graph/rag 索引同级）。

## 四、组件设计

### 4.1 GraphCanvas —— 三层画布叠加（同坐标系，透明叠放）

| 层 | 内容 | 重绘时机 |
|---|---|---|
| 静息层（离屏缓存） | 全部纤维束（多股贝塞尔、束收拢控制点）、突触小结、区域光晕底 | 仅布局变化 / 缩放结束后（防抖重渲染） |
| 激活层（每帧） | 激活束逐段顺序点亮（front 推进 → 保持 → 衰减）、涟漪环、区域泛光 | rAF 每帧，只画活跃束（通常 <10 条） |
| 标注层（每帧） | 卡片标题（激活/悬停才浮现）、domain 标签、悬停高亮 | rAF 每帧，元素量少 |

- 平移/缩放时对静息层只做 `drawImage` 变换（GPU 加速），交互结束后按新精度重渲染——5000 节点 60fps 的关键。
- 相机：滚轮缩放（以光标为中心）、拖拽平移；点击突触打开 CardReader。
- **束生成规则**（与视觉原型一致）：同一 domain 对之间的边共享收拢控制点形成束；每条边 3–5 股，法向抖动；关系类型决定色相（`supports` 青 / `conflicts` 紫红 / `applies-to` 蓝……映射表集中在主题文件）。

### 4.2 ActivationEngine —— 事件驱动状态机

- 每个可视实体（束、突触、区域）持有 `heat` 状态 `{front, fade, color, startedAt}`；引擎按 SSE 事件写入，渲染器只读。
- 事件 → 视觉映射（原型已验证）：
  - `graph.hit role=seed` → 突触涟漪 + 持续琥珀光晕 + 标题浮现
  - `graph.hit role=expand` → 关联束蓝色逐条顺序点亮（条间 0.35s 交错）
  - `graph.hit role=conflict` → 紫红点亮（judge 模式的冲突子图强化）
  - `lens.begin` → 琥珀金通路 + 当前透镜徽章
  - `write.applied` → 新节点入场 + 新边生长动画（本阶段由 digest 模拟剧本触发）
  - `session.idle` → 全部 heat 衰减归零
- 并发纪律：同一束被新事件命中时重置其 `front`（神经再激活隐喻）。
- **所有视觉参数**（点亮速度、保持时长、衰减曲线、颜色映射）集中在 `web/src/activation/activation-theme.ts`，供用户调参。

### 4.3 事件模拟器（`runtime/simulate.py`）

- 剧本即数据：每个剧本是「时刻 → 事件」的声明式序列；新增剧本（talk 问答、digest 消化）只是加数据，不写新逻辑。
- `/api/simulate/{scenario}` 触发后按真实时间间隔把剧本事件推入事件总线——前端分不清真假，即为协议验证。
- 首批三个剧本：`judge`（深判：种子→扩展→conflict 强化→三透镜→综合，已在原型中验证）、`talk`（问答：种子→扩展→读卡→归因）、`digest`（消化：buffer 读取→确认→write.applied 新卡入场）。

### 4.4 ChatPanel / EventLog / CardReader

- ChatPanel：流式气泡 UI；本阶段输入触发词（「深判」「问答」「消化」）→ 调 `/api/simulate/{scenario}`；skill 徽章显示当前模拟的技能。不接 LLM。
- EventLog：右侧可折叠面板，逐条渲染 SSE 事件（类型着色）——协议的可视化调试器。
- CardReader：点击突触后抽屉式展开，渲染卡片 markdown。

## 五、API 契约

| 端点 | 内容 |
|---|---|
| `GET /api/graph` | 全图：节点（id、类型、domain、标题、坐标←layout.json）+ 边（两端 id、关系类型、束分组 id） |
| `GET /api/cards/{id}` | 卡片全文（frontmatter + body，供 markdown 渲染） |
| `GET /api/graph/stats` | 节点/边计数、类型分布 |
| `GET /api/events` | SSE 通道，事件 JSON 逐条推送 |
| `POST /api/simulate/{scenario}` | 触发模拟剧本（`judge` / `talk` / `digest`） |

SSE 事件统一信封：`{type, ts, payload}`。`graph.hit` payload 为 `{node_ids, edge_ids, role}`——前端据此查渲染实体，事件不携带冗余内容。完整事件类型集：`skill.trigger / retrieve.query / graph.hit(seed|expand|conflict) / card.read / lens.begin / write.applied / session.idle`。

## 六、目录结构

```
nexogenesis/runtime/     # api.py / events.py / layout.py / simulate.py / serve 入口
web/                     # Vite + React + TS + Tailwind
  src/graph/             # GraphCanvas 三层渲染器、相机、束生成
  src/activation/        # ActivationEngine、activation-theme.ts
  src/components/        # ChatPanel / EventLog / CardReader
  src/api/               # REST client + SSE 订阅
tests/runtime/           # 契约测试
```

## 七、错误处理

| 故障 | 处理 |
|---|---|
| SSE 断连 | EventSource 自动重连；重连后状态以服务端会话为准 |
| layout.json 缺失 | 服务端现算、落盘后再响应 |
| 卡片读取失败 | CardReader 显示占位错误，不影响图谱 |
| 模拟剧本并发触发 | 排队，同一时刻只演一场 |
| 节点数超渲染预算 | 静息层降采样（合并远端股线）；预留按 domain 分区加载的退路 |

## 八、测试策略

- `tests/runtime/`：API 契约测试（schema 快照）、事件总线测试（剧本 → 断言事件序列与顺序）、layout 确定性测试（同输入同坐标）。
- 前端渲染不做单元断言；用 **headless Chrome 定时截图走查**（本设计过程中已建立该工作流）验证关键激活时刻的画面。
- **回归纪律：现有测试套件零改动全绿**；runtime 测试独立于 harness 测试目录。

## 九、里程碑拆解

1. **M4-lite**：`runtime/` 事件总线 + 只读 API + `serve` 入口（无前端，curl 可验）。
2. **M5a**：布局预计算 + GraphCanvas 静息层（束网络可见、可缩放平移）。
3. **M5b**：ActivationEngine + 三个模拟剧本端到端可视。
4. **M5c**：ChatPanel 触发入口 + EventLog + CardReader，整体联调。

## 十、风险与开放问题

- **5000 节点的束渲染密度**：束数量随 domain 对组合增长，全亮时可能视觉过密。对策：静息层透明度随密度自适应下调；缩放到阈值以下时隐藏区域内细纤维（LOD）。M5a 用合成 3000 节点数据实测。
- **真实卡片标题长度**：中文长标题在标注层可能重叠。对策：激活标题按 act 值排序限量显示 + 碰撞回避。
- **开放问题**：digest 模拟剧本中「新节点入场」的布局增量策略（局部重排 vs 预算固定位）在 M5b 实施时定，本设计不锁死。
- **视觉原型资产**：brainstorm 过程的四版交互原型（风格 A/B/C、束主导 D1、judge 仿真）存于 `.superpowers/brainstorm/`，作为渲染器的验收参照。
