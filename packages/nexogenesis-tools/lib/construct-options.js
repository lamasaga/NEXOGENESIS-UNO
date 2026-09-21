/** User-facing intent, not a prescribed sequence of semantic operations. */
export const CONSTRUCT_CONTEXT_MARKER = "\n\n[CONSTRUCT_CONTEXT_V1]\n";
export const CONSTRUCT_GOALS = [
	{ id: "connect", label: "接通知识孤岛", description: "检查孤立卡与小片知识，找到有依据的联系，也保留合理独立。" },
	{ id: "decentralize", label: "改善过度中心化", description: "检查依赖少数枢纽的结构，让机制、反例和边界能直接被找到。" },
	{ id: "organize", label: "整理重复与混杂", description: "比较重复、混杂或难以阅读的内容，判断精修、合并或拆分。" },
	{ id: "relations", label: "修正关系与分歧", description: "检查关系的依据、方向与类型，区分真正的反对和适用条件。" },
	{ id: "domains", label: "整理领域与入口", description: "检查领域归属和导航入口，改善知识的发现与组织。" },
	{ id: "recommend", label: "让NEXO自由地建构知识图谱", description: "结合结构线索和正文，选择当前最值得改善的问题。" },
];
export const CONSTRUCT_WORKLOADS = [
	{ id: "advice", label: "先看建议", description: "只诊断并给出建议，不修改知识。" },
	{ id: "group", label: "先完成一组", description: "解决一个紧密相关的局部问题，并检查效果。" },
	{ id: "systematic", label: "系统处理所选范围", description: "连续处理多组问题，保存进度；预算不足时如实保留待办。" },
];
