# mcp/：外部计算服务占位目录

  当前没有启用项目自带的 Python MCP Server。卡片检索、GraphOps、编译读取、认知状态和 Harness 均由现有 Node 工具包提供。

  只有当语料规模、性能测试或材料标准化任务反复证明现有工具不足时，才考虑把明确的计算能力拆成 MCP 服务。MCP 只能提供工具和 Observation，不得成为新的知识事实源或绕过 HarnessGateway 写入 Card。

  当前实现与限制见[主运行文档](../docs/history/pre-uno/2026-08-30-当前实现、运行与限制.md)；早期融合决策保存在 `docs/history/specs/2026-08-16-nexogenesis-x-dsh-融合设计.md`。
