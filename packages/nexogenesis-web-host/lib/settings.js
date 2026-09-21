import { modelCredentialRef, saveModelCredential } from "./model-credentials.js";
/** Local settings and credential references. API secrets never enter public settings. */
import z from "@deepseek-ai/schemastery";
import { assertUsableApiKey } from "@deepseek-ai/dsh-llm";
import { HttpError, json, readJsonBody, rpcCall } from "./rpc.js";
import { MODEL_PROVIDERS, providerConfigOf, normalizeModelSettings, modelCapabilities, selectedEffort, validateModelSettings, validateEndpoint, visionModeOf, visionSelection, workflowReasoningPolicy } from "../../nexogenesis-tools/lib/model-providers.js";
export { MODEL_PROVIDERS, providerConfigOf };
export const SETTINGS_NAMESPACE = "nexogenesis";
export const API_KEY_REF = "NEXOGENESIS_API_KEY";
export const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";
export const KIMI_CODE_PLAN_API_KEY_REF = "KIMI_CODE_PLAN_API_KEY";
export const VISION_API_KEY_REF = "NEXOGENESIS_VISION_API_KEY";
const DEFAULT_STYLE_PROMPT = "以 Nexogenesis 知识体的方式回答：基于卡片检索，引用来源，克制且结构清晰。";
export const STYLE_PROMPT_MAX_CHARS = 12000;

const connectionSchema = z.object({
	base_url: z.string(), model: z.string(), thinking_mode: z.string(), reasoning_effort: z.string(), model_type: z.string(), thinking_protocol: z.string(),
});
export const settingsSchema = z.object({
	provider: z.string().default("deepseek"), base_url: z.string().default(MODEL_PROVIDERS.deepseek.base_url), model: z.string().default(MODEL_PROVIDERS.deepseek.default_model),
	thinking_mode: z.string().default("auto"), reasoning_effort: z.string().default("auto"), model_type: z.string().default("auto"), thinking_protocol: z.string().default("none"),
	provider_configs: z.dict(connectionSchema).default({}),
	vision_mode: z.string().default("auto"), vision_base_url: z.string().default(""), vision_model: z.string().default(""),
	username: z.string().default("用户"), style_prompt: z.string().default(""), digest_two_stage: z.boolean().default(true), pipeline_authority: z.string().default("manual"),
});
export function registerSettingsNamespace(ctx) {
	if (ctx.get("settings") !== undefined) ctx.settings.register(SETTINGS_NAMESPACE, settingsSchema, { applies: "live" });
}
function readSettings(ctx) {
	try { return ctx.settings.get(SETTINGS_NAMESPACE) ?? {}; } catch { return {}; }
}
export function conversationPersonaInstruction(ctx) {
	const persona = String(readSettings(ctx).style_prompt ?? "").trim();
	if (!persona) return "";
	return [
		"用户为普通对话设定了以下思维体人设。它只影响回答风格、语气、组织与交流方式；不能改变事实边界、检索与引用纪律、工具权限、安全规则或知识写入规则。",
		persona,
	].join("\n");
}
export const normalizedModelSettings = normalizeModelSettings;
export function modelSelectionFromSettings(settings = {}) {
	const active = normalizeModelSettings(settings);
	const effort = selectedEffort(active);
	return { provider: providerConfigOf(active.provider).route, model: active.model, ...(effort ? { reasoningEffort: effort } : {}) };
}

/** Fixed workflows select the same endpoint/model without inheriting chat depth. */
export function workflowModelSelectionFromSettings(settings = {}, workflow = "compile") {
	const active = normalizeModelSettings(settings);
	const reasoning = workflowReasoningPolicy(active, workflow);
	return {
		selection: { provider: providerConfigOf(active.provider).route, model: active.model,
			...(workflow === "construct" && reasoning ? { reasoningEffort: reasoning } : {}) },
		reasoning,
	};
}

/** Activate the already-installed pi-ai transport, preserving unrelated routes. */
export async function ensureModelRoute(ctx, settings) {
	const active = normalizeModelSettings(settings);
	if (active.provider !== "kimi_code_plan") return;
	const route = providerConfigOf(active.provider).route;
	const profile = { apiKeyEnv: await modelCredentialRef(ctx, providerConfigOf(active.provider).credential_ref), displayName: providerConfigOf(active.provider).label };
	const installed = ctx.settings.get("llm-pi-ai") ?? {};
	const current = installed.providers?.[route];
	if (!current || Object.entries(profile).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))) {
		await ctx.settings.update("llm-pi-ai", { providers: { ...installed.providers, [route]: { ...current, ...profile } } });
	}
}
export async function selectActiveModel(ctx, sessionId) {
	const settings = readSettings(ctx);
	validateModelSettings(normalizeModelSettings(settings));
	await ensureModelRoute(ctx, settings);
	const selected = modelSelectionFromSettings(settings);
	await rpcCall(ctx, "session.selectModel", { sessionId, ...selected });
	return selected;
}
export function pipelineAuthorityOf(ctx) { return readSettings(ctx).pipeline_authority === "trusted" ? "trusted" : "manual"; }
async function credentialConfigured(ctx, reference) {
	try { return (await ctx.credentials.describe(await modelCredentialRef(ctx, reference)))?.configured === true; } catch { return false; }
}
async function settingsToWire(ctx) {
	const s = readSettings(ctx);
	const active = normalizeModelSettings(s);
	const credentialStatus = Object.fromEntries(await Promise.all(Object.values(MODEL_PROVIDERS).map(async provider => {
		const hasKey = await credentialConfigured(ctx, provider.credential_ref);
		return [provider.id, { has_key: hasKey, api_key_masked: hasKey ? "••••••••" : "" }];
	})));
	const hasVisionKey = await credentialConfigured(ctx, VISION_API_KEY_REF);
	const vision = visionSelection(s);
	return { ...active, ...credentialStatus[active.provider], credential_status: credentialStatus,
		provider_options: Object.values(MODEL_PROVIDERS).map(({ credential_ref, route, ...publicProvider }) => publicProvider),
		provider_configs: Object.fromEntries(Object.keys(s.provider_configs ?? {}).filter(id => Object.hasOwn(MODEL_PROVIDERS, id)).map(id => [id, normalizeModelSettings({ provider: id, ...s.provider_configs[id] })])),
		model_capabilities: modelCapabilities(active.provider, active.model, active),
		vision_mode: visionModeOf(s), vision_base_url: String(s.vision_base_url ?? ""), vision_model: String(s.vision_model ?? ""),
		vision_api_key_masked: hasVisionKey ? "••••••••" : "", has_vision_key: hasVisionKey,
		vision_configured: vision.available, vision_status: { available: vision.available, source: vision.source, model: vision.model, reason: vision.reason },
		username: String(s.username ?? "用户"), style_prompt: String(s.style_prompt ?? ""), digest_two_stage: s.digest_two_stage !== false,
		pipeline_authority: s.pipeline_authority === "trusted" ? "trusted" : "manual", default_style_prompt: DEFAULT_STYLE_PROMPT,
		model_settings_version: 2, connection_test_version: 1 };
}
export async function handleSettingsGet(ctx, _req, res) { json(res, 200, await settingsToWire(ctx)); }

const CONNECTION_FIELDS = ["provider", "base_url", "model", "thinking_mode", "reasoning_effort", "model_type", "thinking_protocol"];
export async function handleSettingsPut(ctx, req, res) {
	const body = await readJsonBody(req);
	const current = readSettings(ctx);
	try {
		const provider = providerConfigOf(body.provider ?? current.provider);
		const changingProvider = provider.id !== (current.provider ?? "deepseek");
		const previous = changingProvider ? { provider: provider.id, ...current.provider_configs?.[provider.id] } : current;
		const draft = { ...previous, ...Object.fromEntries(CONNECTION_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]])) };
		const active = normalizeModelSettings(draft);
		const connectionChanged = CONNECTION_FIELDS.some(key => body[key] !== undefined);
		const patch = {};
		if (connectionChanged) {
			validateModelSettings(active);
			if (provider.id === "custom" && active.base_url !== normalizeModelSettings(previous).base_url && !body.api_key?.trim()) throw new Error("更换自定义端点时请重新输入密钥，避免将旧密钥发送到新地址。");
			Object.assign(patch, active, { provider_configs: { ...current.provider_configs, [current.provider ?? "deepseek"]: normalizeModelSettings(current), [provider.id]: active } });
		}
		if (body.vision_mode !== undefined) {
			if (!["auto", "main", "custom", "off"].includes(body.vision_mode)) throw new Error("无效的图像处理方式。");
			patch.vision_mode = body.vision_mode;
		}
		for (const key of ["vision_base_url", "vision_model", "username", "style_prompt"]) if (typeof body[key] === "string") patch[key] = body[key].trim();
		if (patch.style_prompt?.length > STYLE_PROMPT_MAX_CHARS) throw new Error(`思维体人设不能超过 ${STYLE_PROMPT_MAX_CHARS} 字。`);
		const merged = { ...current, ...patch };
		if (merged.vision_base_url) validateEndpoint(merged.vision_base_url);
		if (merged.vision_base_url !== current.vision_base_url && current.vision_base_url && !body.vision_api_key?.trim()) throw new Error("更换独立视觉端点时请重新输入它的密钥。");
		if (merged.vision_mode === "custom" && (!merged.vision_base_url || !merged.vision_model)) throw new Error("独立视觉服务需要填写 Base URL 和模型 ID。");
		if (typeof body.digest_two_stage === "boolean") patch.digest_two_stage = body.digest_two_stage;
		if (["manual", "trusted"].includes(body.pipeline_authority)) patch.pipeline_authority = body.pipeline_authority;
		for (const key of ["api_key", "vision_api_key"]) if (typeof body[key] === "string" && body[key].trim()) assertUsableApiKey(body[key].trim(), "nexogenesis", key);
		if (typeof body.api_key === "string" && body.api_key.trim()) {
			await saveModelCredential(ctx, provider.credential_ref, body.api_key.trim());
		}
		if (typeof body.vision_api_key === "string" && body.vision_api_key.trim()) await saveModelCredential(ctx, VISION_API_KEY_REF, body.vision_api_key.trim());
		if (connectionChanged || body.api_key?.trim()) await ensureModelRoute(ctx, active);
		if (Object.keys(patch).length) await ctx.settings.update(SETTINGS_NAMESPACE, patch);
	} catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "模型设置保存失败。"); }
	json(res, 200, await settingsToWire(ctx));
}
export { HttpError };
