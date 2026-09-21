# UNO 知识处理优化提议

2026-09-13，尚未实施到业务服务。

- [完整设计](../../UNO-知识处理优化设计方案.md)：取舍、18 项反馈对应、数量、实施、验收与回退。
- [逐项对齐](alignment.html)：A–P 与插入环节 C1，修改意见保存在浏览器；复制汇总到对话后助手才能收到。
- [设置与编译弹窗](interaction.html)：可点击的交互原型，所有材料为虚构示例；只修改浏览器内示例设置，不能执行编译。

两个网页均可离线打开。长期设置与本次要求分别展示，原型可切换单批/全部、选择材料、直接点击开始；示例数值不是运行服务数据。

重建对齐规格：`node build-spec.mjs`，再用 workflow-alignment 技能的 `scripts/build_page.mjs alignment.spec.json alignment.html` 构建。当前流程标识 `uno-knowledge-optimization`，版本 `proposal-v2`，与旧对齐页草稿隔离。浏览器验证使用独立测试标识。

本轮反馈：偏好有效原文合计上限 3,000 tokens，原型未接入分词器；编译弹窗取消独立计划预览；稠密向量检索延后。旧版 [proposal-v1 对齐页](alignment.proposal-v1.html) 仍可打开并读取同浏览器的旧版草稿，新版不会自动迁入或清空旧意见。
