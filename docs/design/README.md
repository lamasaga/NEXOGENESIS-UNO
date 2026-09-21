# UNO 设计对齐文件

现行编译设计：[UNO编译功能重构](../UNO编译功能重构.md)。[知识类型与关系使用说明](./knowledge-guidance/README.md) 包含八种可叠加类型、七种检索关系的定义、边界与正反示例，已由新编译工具和常驻提示直接读取。

入口：[编译设计对齐页](./uno-compile-alignment.html)。可直接用浏览器打开，无需 UNO 服务；图和说明已内嵌。意见保存在当前浏览器中，可汇总复制到对话。

- [独立流程图](./uno-compile-v1.html)：缩放、查看、导出。
- [完整文字规格](./UNO-编译设计对齐.md)：A–L 同编号，含数量、能力边界和代码依据。
- `uno-compile-v1.details.json`：文字事实源。
- `uno-compile-v1.workflow.json`：流程图规格。
- `uno-compile-v1.delivery.json`：交付校验与源码哈希。

当前版本 UNO-CMP-v1 是 2026-09-12 源码快照，不代表已验证运行中服务。意见是待讨论草稿，不会修改编译行为。

修改详情或页面模板后，在项目根目录运行 `node docs/design/build-compile-alignment.mjs`，重新生成对齐页和文字规格。修改流程图须重新通过 Archify validate、deliver 和 visual-check，再生成对齐页；不要手改已交付的流程图 HTML。
