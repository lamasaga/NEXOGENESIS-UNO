/** Curated API contracts, checked 2026-09-18. Capabilities belong to exact models, not brands. */
const model = (id, label, vision, thinking, efforts = [], format = "openai", context = 262144) =>
	({ id, label, vision, thinking, efforts, format, context });
export const MODEL_PROVIDERS = {
	deepseek: { id: "deepseek", label: "DeepSeek", route: "nexo-deepseek", base_url: "https://api.deepseek.com", credential_ref: "DEEPSEEK_API_KEY", default_model: "deepseek-flash", description: "DeepSeek 官方 API；目录只列当前公开模型，旧 ID 仅作兼容识别。", docs: "https://api-docs.deepseek.com/guides/thinking_mode/", models: [
		model("deepseek-flash", "DeepSeek Flash · 当前通用", true, "toggle", ["low", "high", "max"], "deepseek", 1048576),
		model("deepseek-v4-pro", "V4 Pro", false, "toggle", ["low", "high", "max"], "deepseek", 1048576),
	] },
	kimi: { id: "kimi", label: "Kimi 开放平台", route: "nexo-kimi", base_url: "https://api.moonshot.cn/v1", credential_ref: "MOONSHOT_API_KEY", default_model: "kimi-k3", description: "按 API 用量计费，与 Kimi Code Plan 的密钥不通用。", docs: "https://platform.kimi.ai/docs/api/models-overview", models: [
		model("kimi-k3", "Kimi K3", true, "always", ["low", "high", "max"], "openai", 1048576),
		model("kimi-k2.7-code", "Kimi K2.7 Code", true, "always"),
		model("kimi-k2.6", "Kimi K2.6", true, "toggle", [], "deepseek"),
		model("kimi-k2.5", "Kimi K2.5", true, "toggle", [], "deepseek"),
	] },
	kimi_code_plan: { id: "kimi_code_plan", label: "Kimi Code Plan", route: "kimi-coding", base_url: "https://api.kimi.com/coding", credential_ref: "KIMI_CODE_PLAN_API_KEY", default_model: "k3-256k", description: "Kimi Code 控制台签发的套餐 Key；保留原生 Anthropic 适配，可用性受套餐限制。", docs: "https://www.kimi.com/code/docs/", models: [
		model("k3", "Kimi K3 · 套餐决定上下文", true, "always", ["low", "high", "max"], "native", 1048576),
		model("k3-256k", "Kimi K3 256K", true, "always", ["low", "high", "max"], "native"),
		model("kimi-for-coding", "Kimi Code · 标准（服务端更新）", true, "always", [], "native"),
		model("kimi-for-coding-highspeed", "Kimi K2.7 Code · 高速", true, "always", [], "native"),
	] },
	glm: { id: "glm", label: "智谱 GLM", route: "nexo-glm", base_url: "https://open.bigmodel.cn/api/paas/v4", credential_ref: "NEXO_GLM_API_KEY", default_model: "glm-5.2", description: "智谱开放平台通用 API，不是 Coding Plan 专用端点。", docs: "https://docs.bigmodel.cn/cn/guide/capabilities/thinking", models: [
		model("glm-5.2", "GLM-5.2", false, "toggle", ["high", "max"], "zai", 1000000),
		model("glm-5", "GLM-5", false, "toggle", [], "zai", 200000),
		model("glm-4.7", "GLM-4.7", false, "toggle", [], "zai", 200000),
		model("glm-4.6v", "GLM-4.6V · 图文", true, "toggle", [], "zai", 131072),
		model("glm-4.6v-flash", "GLM-4.6V Flash · 图文", true, "toggle", [], "zai", 131072),
	] },
	dashscope: { id: "dashscope", label: "阿里云百炼", route: "nexo-dashscope", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", credential_ref: "NEXO_DASHSCOPE_API_KEY", default_model: "qwen3.6-plus", description: "中国内地通用 API；其它地域或工作空间专属地址请使用自定义接口。", docs: "https://help.aliyun.com/zh/model-studio/deep-thinking", models: [
		model("qwen3.6-plus", "Qwen3.6 Plus · 图文", true, "toggle", [], "qwen"),
		model("qwen3-vl-plus", "Qwen3 VL Plus · 图文", true, "toggle", [], "qwen"),
	] },
	siliconflow: { id: "siliconflow", label: "硅基流动", route: "nexo-siliconflow", base_url: "https://api.siliconflow.cn/v1", credential_ref: "NEXO_SILICONFLOW_API_KEY", default_model: "Qwen/Qwen3-32B", description: "聚合服务使用完整模型 ID；同名模型的能力与参数以该平台为准。", docs: "https://docs.siliconflow.cn/docs/api/chat-completions-post", models: [
		model("Qwen/Qwen3-32B", "Qwen3 32B", false, "toggle", [], "qwen", 40960),
		model("Qwen/Qwen3-VL-30B-A3B-Instruct", "Qwen3 VL 30B · 图文", true, "none"),
	] },
	custom: { id: "custom", label: "自定义兼容接口", route: "nexo-custom", base_url: "", credential_ref: "NEXO_CUSTOM_API_KEY", default_model: "", description: "OpenAI Chat Completions 兼容服务；需自行确认工具调用、图像与思考参数支持。", models: [] },
};

// Provider aliases are compatibility inputs, not additional presets. Keeping
// them out of `models` prevents the selector from presenting one backend model
// as several different choices while still applying the correct capabilities.
const MODEL_ALIASES = {
	deepseek: {
		"deepseek-v4-flash": "deepseek-flash",
		"deepseek-v4-flash-vision-exp": "deepseek-flash",
	},
};

export function providerConfigOf(id = "deepseek") {
	if (!Object.hasOwn(MODEL_PROVIDERS, id)) throw new Error("不支持的模型供应商，请重新选择。");
	return MODEL_PROVIDERS[id];
}

export function modelCapabilities(provider, id, overrides = {}) {
	const canonicalId = MODEL_ALIASES[provider]?.[id] ?? id;
	const known = providerConfigOf(provider).models.find(entry => entry.id === canonicalId);
	if (known) return { ...known, known: true, requested_id: id, canonical_id: canonicalId, legacy_alias: canonicalId !== id };
	const format = overrides.thinking_protocol ?? "none";
	return { ...model(id, id, overrides.model_type === "vision", format === "none" ? "none" : "toggle",
		format === "openai" ? ["low", "medium", "high"] : [], format), known: false };
}

/** A stable, provider-aware reasoning policy for fixed knowledge workflows. */
export function workflowReasoningPolicy(settings = {}, workflow = "compile") {
	const active = normalizeModelSettings(settings);
	const cap = modelCapabilities(active.provider, active.model, active);
	if (cap.thinking === "none") return workflow === "compile" ? {} : undefined;
	const semantic = cap.efforts.includes("low") ? "low" : "high";
	const economical = cap.thinking === "toggle" ? "off" : "high";
	if (workflow === "construct") return "high";
	return { generate: semantic, supplement: semantic, repair: semantic, check: economical, verify: economical };
}

export function normalizeModelSettings(settings = {}) {
	const provider = providerConfigOf(settings.provider);
	const saved = settings.provider_configs?.[provider.id] ?? {};
	return { provider: provider.id, base_url: provider.id === "custom" ? String(settings.base_url ?? saved.base_url ?? "").trim() : provider.base_url,
		model: String(settings.model ?? saved.model ?? provider.default_model).trim(),
		thinking_mode: settings.thinking_mode ?? saved.thinking_mode ?? "auto",
		reasoning_effort: settings.reasoning_effort ?? saved.reasoning_effort ?? "auto",
		model_type: settings.model_type ?? saved.model_type ?? "auto",
		thinking_protocol: settings.thinking_protocol ?? saved.thinking_protocol ?? "none" };
}

/** An omitted effort must retain the provider default, not silently turn thinking off. */
export function selectedEffort(config) {
	const cap = modelCapabilities(config.provider, config.model, config);
	if (cap.thinking === "none") return undefined;
	if (config.thinking_mode === "disabled") return "off";
	if (config.reasoning_effort !== "auto") return config.reasoning_effort;
	if (!cap.known && config.thinking_mode === "auto") return undefined;
	return cap.efforts.includes("max") && (config.provider.startsWith("kimi") || config.provider === "glm") ? "max" : "high";
}

export function validateModelSettings(config) {
	const cap = modelCapabilities(config.provider, config.model, config);
	if (!config.model || /[\r\n\u0000]/.test(config.model)) throw new Error("请填写有效的模型 ID。");
	if (config.provider === "kimi_code_plan" && !cap.known) throw new Error("该 Code Plan 型号尚未接入原生适配，请选择列表中的型号。");
	validateEndpoint(config.base_url);
	if (!["auto", "enabled", "disabled"].includes(config.thinking_mode)) throw new Error("无效的思考模式。");
	if (!["auto", "text", "vision"].includes(config.model_type) || !["none", "openai", "deepseek", "qwen", "zai"].includes(config.thinking_protocol)) throw new Error("无效的模型能力声明。");
	if (cap.thinking === "always" && config.thinking_mode === "disabled") throw new Error("该模型始终开启思考，不能关闭。");
	if (cap.thinking === "none" && config.thinking_mode === "enabled") throw new Error("该模型没有已声明的思考开关，请检查模型能力。");
	if (config.reasoning_effort !== "auto" && !cap.efforts.includes(config.reasoning_effort)) throw new Error("该模型不支持所选思考强度。");
	if (config.thinking_mode === "disabled" && config.reasoning_effort !== "auto") throw new Error("关闭思考时不能设置思考强度。");
}

export function validateEndpoint(value) {
	let url;
	try { url = new URL(value); } catch { throw new Error("请填写完整的 Base URL。"); }
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/(chat\/completions|messages)\/?$/.test(url.pathname)) throw new Error("Base URL 只能使用 HTTP(S)，不能含密钥、查询参数或完整调用路径。");
	if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("远程模型接口须使用 HTTPS，避免明文传输密钥与材料。");
	return value.replace(/\/+$/, "");
}


export function visionModeOf(settings) {
	return settings.vision_mode ?? "auto";
}

/** Resolve only declared destinations. Never borrow a key from an unrelated service. */
export function visionSelection(settings) {
	const mode = visionModeOf(settings);
	if (mode === "off") return { available: false, source: "off", reason: "已关闭自动图像处理。" };
	const active = normalizeModelSettings(settings);
	const cap = modelCapabilities(active.provider, active.model, active);
	if (mode !== "custom" && cap.vision) return { available: true, source: "main", ...active,
		protocol: active.provider === "kimi_code_plan" ? "anthropic" : "openai", credential_ref: providerConfigOf(active.provider).credential_ref };
	if (mode !== "main" && settings.vision_base_url?.trim() && settings.vision_model?.trim()) return {
		available: true, source: "custom", provider: "custom", protocol: "openai", base_url: settings.vision_base_url.trim(), model: settings.vision_model.trim(), credential_ref: "NEXOGENESIS_VISION_API_KEY",
		thinking_mode: "auto", reasoning_effort: "auto", thinking_protocol: "none", model_type: "vision" };
	return { available: false, source: "unavailable", reason: mode === "custom" ? "请填写独立视觉服务的 Base URL 和模型 ID。" : cap.known ? "当前主模型不支持图像输入，请选择图文模型或配置独立视觉服务。" : "当前模型的视觉能力尚未声明，请确认模型类型或配置独立视觉服务。" };
}

/** Direct auxiliary request knobs; do not send a universal temperature to reasoning models. */
export function requestThinking(config) {
	const cap = modelCapabilities(config.provider ?? "custom", config.model, config);
	const enabled = config.thinking_mode !== "disabled";
	if (cap.thinking === "none") return {};
	if (!cap.known && config.thinking_mode === "auto" && (!config.reasoning_effort || config.reasoning_effort === "auto")) return {};
	const effort = config.reasoning_effort && config.reasoning_effort !== "auto" ? config.reasoning_effort : undefined;
	return { ...(cap.thinking === "toggle" ? cap.format === "qwen" ? { enable_thinking: enabled } : cap.format === "openai" ? { reasoning_effort: enabled ? effort ?? "high" : "none" } : { thinking: { type: enabled ? "enabled" : "disabled" } } : {}),
		...(enabled && effort && cap.efforts.length ? { reasoning_effort: effort } : {}) };
}
