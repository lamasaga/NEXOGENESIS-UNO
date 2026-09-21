---
id: "2026-08-05-domain-overload-cross-domain"
title: "Domain 过载阈值上调 + cross_domain 发现镜头"
date: "2026-08-05"
status: "implemented"
---

# Domain 过载阈值上调 + cross_domain 发现镜头

## 背景

- 实践副本（`NexogenesisV1.6org 金融2`）中 construct --diagnose 已出现真实 domain 过载：
  - `金融权力投机与内生不稳定` 挂靠 113 张卡
  - `短期波动与AD-AS` 90 张
  - `储蓄投资与金融体系` 65 张
- 原阈值 `max_members=25` 在 460 卡副本上已触发 8/19 个 domain，过于敏感。
- 用户确认 5000 卡目标下，单个 domain 舒适上限为 **50–80 张实例**。

## 决策

不改 schema、不引入 3 级领域。先以最小改动止血：

1. 把 domain 过载阈值从 **25** 提到 **50**。
2. 对过载 domain 自动生成 sibling 拆分候选（基于成员标题/id 的共现术语）。
3. 新增 `cross_domain` construct 镜头，只发现**有证据**的跨域桥接。

## 改动清单

### A. Domain 过载与 sibling 拆分

| 文件 | 变更 |
|------|------|
| `nexogenesis/ingest/construct_ops.py` | 新增常量 `DOMAIN_OVERLOAD_MEMBERS=50` 等；`find_overloaded_domains` 默认阈值改为 50；新增 `suggest_domain_splits()`；`build_structure_action_plan` 输出拆分候选；`structure-ops-draft.md` 新增拆分候选章节 |
| `nexogenesis/ingest/structure_signals.py` | 从 `construct_ops` import 阈值常量；`LENSES` 增加 `cross_domain`；过载判定使用常量 |
| `nexogenesis/commands/digest.py` | `--plan` 输出中的过载判定同步为 50 |
| `schemes/default/prompts/construct.txt` | “挂靠>25” → “挂靠>50”；明确 `suggest_domain_split` 候选须优先使用 |
| `schemes/default/prompts/digest.txt` | 补充“不要把 50+ 成员的大域当垃圾桶，具体分裂由 construct 处理” |

### 2. cross_domain 发现镜头

| 文件 | 变更 |
|------|------|
| `nexogenesis/ingest/structure_signals.py` | 新增 `cross_domain` 信号：① 两 domain 共享同一张实例卡；② 不同 domain 的实例卡之间存在 supports/extends/based-on/influences/conflicts-with/example-of 关系 |
| `nexogenesis/ingest/batch_auto.py` | `suggest_lenses` 给 `cross_domain` 加权 |
| `nexogenesis/graph/analyze.py` | 信号字典增加 `cross_domain` 键 |
| `nexogenesis/ingest/construct_ops.py` | `merge_action_ops_into_graph_signals` 增加 `cross_domain` 键 |
| `schemes/default/prompts/construct.txt` | 新增 `cross_domain` 镜头职责：只处理有证据的桥接，禁止凭字面相似硬造 analogy |

### 测试

- `tests/test_construct_ops.py` 新增 3 个测试：
  - `test_overload_threshold_uses_50_not_25`
  - `test_suggest_domain_splits_from_member_titles`
  - `test_cross_domain_signal_shared_instance`

结果：`pytest tests/` 150 passed（原 147）。

## 使用方式

```bash
# 查看 domain 过载与 sibling 拆分候选
python -m nexogenesis construct --diagnose --root .

# 处理过载分裂
python -m nexogenesis construct --lens cluster --root .

# 发现跨域关联
python -m nexogenesis construct --lens cross_domain --root .
```

## 撤回方式

- 阈值改回：修改 `DOMAIN_OVERLOAD_MEMBERS` 为 25。
- cross_domain 镜头移除：从 `LENSES` 元组中删除 `"cross_domain"`。
- 已写入的 sibling domain / 跨域关系：通过 git 回退 batch 提交。

## 后续方向

- 当积累了稳定的 sibling domain 命名后，再评估是否引入轻量 umbrella domain（B 路线）。
- prompt 预算系统（ingest 链字符上限告警/截断）仍是独立议题，待 A+2 跑稳后再设计。
