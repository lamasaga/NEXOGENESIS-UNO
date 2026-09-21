# nexogenesis-web-host

Nexogenesis × DSH 融合层的 **host 插件**：在 DSH 的产品 profile（`nexogenesis`）里挂载 Nexogenesis 前端并托管 `/api` 兼容层。

## 职责（融合设计 §5）

1. **提供 `webRuntime` 服务** `{ lanAddresses, trustedHosts }` —— 官方 `connection` 行 `inject: [webRuntime]`，缺失则 `/api` RPC 网关不启动。因此禁用了官方 `web-runtime` 行后，本插件必须补上这个服务。
2. **挂载 Nexogenesis dist** —— 通过 `@deepseek-ai/dsh-host-frontend-static` 认领 webserver 的 fallback seat（唯一主人），`dist` 路径来自 patch 配置（独立项目的 dist，非硬编码包导出）。
3. **`/api` 兼容层路由** —— DSH webserver 按「exact 优先、prefix 最长优先」匹配，本插件注册的 `/api/xxx` 前缀天然压过官方 `/api` RPC 网关。
4. **web-surface 提示段**（模型可见的界面说明）与 URL 打印。

## 已实现端点（M0–M4 全量）

| 路由 | 方法 | 实现 |
|---|---|---|
| `/api/health` | GET | 探针（`{ ok, service }`） |
| `/api/settings` | GET/PUT | 显式选择 DeepSeek / Kimi Code Plan；供应商凭据分离保存，api_key 只回掩码 |
| `/api/projects` | GET/POST | meta 登记过滤（只显示新 agent 创建的会话/项目，§12 隔离） |
| `/api/conversations` (+ `/:id`) | POST/GET/PATCH/DELETE | DSH session 适配 + 扩展元数据（pinned/task_kind/软删） |
| `/api/chat`、`/api/chat/stream` | POST | session.prompt 桥 + SSE 帧（delta/step/sources/confirm_request/pipeline_status/done/error） |
| `/api/events` | GET（EventSource） | 图谱事件流（retrieve.query/graph.hit/context.ready/card.read/session.idle/failed） |
| `/api/graph` | GET | fs 直读卡片 + relations 构建 GraphData |
| `/api/cards/:id` | GET | 卡片详情（frontmatter + body） |
| `/api/pipeline/status`、`/api/pipeline/job`、`/api/pipeline/:stage/conversation`、`/api/pipeline/jobs/:id/stop` | GET/POST | pipeline 会话与任务投影 |
| `/api/candidates/prepare` | POST | 候选预检（M3 起折叠进 propose_write） |
| `/api/write/confirm` | POST | 提案确认/取消 → 原子落盘（staging→rename）+ Journal |
| `/api/inbox` | POST（multipart） | Inbox 材料上传 |
| `/api/simulate/:scenario`、`/api/replay/:scenario` | POST/GET | 图谱模拟回放（稳定空实现，低优先级） |

## 配置（patch 层传入）

| 字段 | 默认 | 说明 |
|---|---|---|
| `dist` | 必填 | `web/dist/index.html` 的绝对路径 |
| `printUrl` | `true` | 启动打印 URL 行 |
| `surfaceContext` | `true` | 注册提示段与 `DSH_WEB_URL` shell 变量 |
| `trustedHosts` | `[]` | 额外信任 Host（来自 `--trusted-host`） |

## 安装与挂载

  见 `patch/cordis.patch.yml` 与融合设计 §6.1：禁用官方 `web-runtime` 行，注册 `kimi-code-plan` 模型路由，再 `insert` 本插件行。

  部署位：`$DSH_HOME/profiles/nexogenesis/cordis.patch.yml`（§12 隔离纪律，不碰 `profiles/web/`）。插件本体由 profile 以 junction 引用本项目 `packages/nexogenesis-web-host`（改码后重启 DSH 生效）。
