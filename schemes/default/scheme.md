---
scheme_id: "default"
version: "0.2.0"
name: "默认沉淀方案"
---

# 默认沉淀方案

适用于个人思想沉淀与一般性知识管理。

- Card：7 种 `type`
- Buffer：按 `role` 整理质料
- 关系：8 种
- 正文契约：`.agent/reference/card-contracts/body-structure.md`
- 写法正例：`.agent/reference/card-contracts/card-exemplars/`（源：`schemes/default/card-exemplars/`）

## 文档摄入流水线

`prompts/` 下的 Jinja2 模板驱动三阶段：

- `compile-*.txt`：00-Inbox → 05-Buffer/<role>/（意义单元质料）
- `digest.txt`：Buffer → 01-Cards / 问题清单（跨源对照，聚类/区分/衔接）
- `construct.txt`：跨批次结构扫描与方案

可在本 scheme 内覆盖模板。
