# presets/nexogenesis/（agent preset）——已实现（M2，2026-08-16）

> 融合设计 §4.2：思维体插件化 = nexo-* 技能 + agent preset。preset 承载 persona（宪法 + style_prompt + 检索纪律），会话默认挂载。

## 内容

| 文件 | 职责 |
|---|---|
| `preset.yml` | 预设元数据（名称「知识体对话」、顺序 order: 5） |
| `agent.cordis.yml` | 会话默认挂载组合：persona（宪法/检索纪律/写入纪律/M5 能力说明） + nexogenesis-tools（知识域工具行） + skill-filesystem（加载 `.agent/skills` 的 nexo-* 技能） + tool-skill + **M5 质量行**（tool-goal / plan-mode 知识工作版 / compaction 组 / subagent spawn+fork+control / ask-user / todo） |

## 部署（事实源在本目录）

复制到 `$DSH_HOME/.agent-presets/nexogenesis/`（preset 注册目录），重启 `dsh --profile nexogenesis` 生效：

```powershell
Copy-Item presets\nexogenesis\preset.yml, presets\nexogenesis\agent.cordis.yml $env:USERPROFILE\.dsh\.agent-presets\nexogenesis\ -Force
```

- 素材来源：原项目 `nexogenesis/runtime/agent.py` 的 `BASE_PROMPT`、`RETRIEVAL_DISCIPLINE`、`style_prompt` 设置、`AGENTS.md` 宪法。
- 当前架构说明：`docs/history/pre-uno/2026-08-30-项目定位、愿景与总体架构.md`；迁移来源保存在 `docs/history/specs/2026-08-16-nexogenesis-x-dsh-融合设计.md`。
