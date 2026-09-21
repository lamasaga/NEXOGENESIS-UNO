import { resolveModelCredential } from "./model-credentials.js";
import { assertUnoWireBudget } from '../../nexogenesis-tools/lib/uno/request-context.js';
/** OpenAI-compatible wire adapter. DSH still owns turns, retries, tools and persistence. */
import { LlmAdapter, LlmError, attributionHeaders, assertUsableApiKey } from "@deepseek-ai/dsh-llm";
import { captureWireInput } from './prompt-inspector.js';
import { registerNativeKimiBudget } from './native-kimi-budget.js';
import { ProviderBudgetError, captureProviderRequestContext, reserveProviderRequest, settleProviderRequest } from '../../nexogenesis-tools/lib/uno/request-budget.js';
import { MODEL_PROVIDERS, normalizeModelSettings, modelCapabilities, selectedEffort, requestThinking, validateEndpoint } from "../../nexogenesis-tools/lib/model-providers.js";

const flatten = blocks => blocks.map(block => {
	if (block.type === "image") throw new LlmError("此消息位置不能直接携带图片，请通过用户图片输入或图像复核工具处理。", "UNSUPPORTED_CONTENT");
	return block.type === "text" ? block.text : block.type === "tool-result" ? flatten(block.content) : "";
}).join("");
export async function wireMessages(options, cap, attachments) {
	const messages = options.system ? [{ role: "system", content: options.system }] : [];
	for (const message of options.messages) {
		const results = message.content.filter(block => block.type === "tool-result");
		for (const result of results) messages.push({ role: "tool", tool_call_id: result.toolCallId, content: flatten(result.content) });
		const blocks = message.content.filter(block => block.type !== "tool-result");
		if (!blocks.length) continue;
		if (message.role === "assistant") {
			const calls = blocks.filter(block => block.type === "tool-call");
			const reasoning = blocks.filter(block => block.type === "reasoning").map(block => block.text).join("");
			messages.push({ role: "assistant", content: flatten(blocks) || null,
				...(reasoning ? { reasoning_content: reasoning } : {}),
				...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) });
		} else {
			const content = [];
			for (const block of blocks) {
				if (block.type === "text") content.push({ type: "text", text: block.text });
				if (block.type === "image") {
					if (!cap.vision || !attachments) throw new LlmError("当前模型或运行环境不支持图片输入。", "UNSUPPORTED_CONTENT");
					const stored = await attachments.readImage(block.attachment);
					content.push({ type: "image_url", image_url: { url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}` } });
				}
			}
			messages.push({ role: message.role, content: content.every(block => block.type === "text") ? content.map(block => block.text).join("") : content });
		}
	}
	return messages;
}

export async function buildModelRequest(options, config, attachments) {
	const cap = modelCapabilities(config.provider, options.model, config);
	const effort = options.reasoningEffort ?? selectedEffort({ ...config, model: options.model });
	if (effort === "off" && cap.thinking === "always") throw new LlmError("该模型不能关闭思考。", "UNSUPPORTED_REASONING_EFFORT");
	if (effort && effort !== "off" && !(cap.efforts.length ? cap.efforts : cap.thinking !== "none" ? ["high"] : []).includes(effort)) throw new LlmError("该模型不支持所选思考强度。", "UNSUPPORTED_REASONING_EFFORT");
	const knobs = requestThinking({ ...config, model: options.model, thinking_mode: effort === "off" ? "disabled" : effort ? "enabled" : config.thinking_mode,
		reasoning_effort: cap.efforts.length && effort !== "off" ? effort : "auto" });
	return { model: options.model, messages: await wireMessages(options, cap, attachments), stream: true,
		stream_options: { include_usage: true }, ...knobs,
		...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
		...(options.stop ? { stop: options.stop } : {}),
		...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}) };
}

/** Parse arbitrary network boundaries; never report a truncated SSE response as success. */
export async function* completionChunks(body, refreshTimeout = () => {}) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const blocks = new Map();
	let buffer = "", finish, usage, ended = false;
	function* apply(payload) {
		if (payload.error) throw new LlmError("模型服务返回错误，请检查权限、请求参数与额度。", "INVALID_REQUEST");
		if (payload.usage) {
			const u = payload.usage;
			const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
			usage = { inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached), outputTokens: u.completion_tokens ?? 0, cacheReadTokens: cached,
				...(u.completion_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: u.completion_tokens_details.reasoning_tokens } : {}) };
		}
		const choice = payload.choices?.[0];
		if (choice?.finish_reason) finish = choice.finish_reason;
		const delta = choice?.delta ?? {};
		for (const [field, type] of [["reasoning_content", "reasoning"], ["content", "text"]]) {
			if (typeof delta[field] !== "string" || !delta[field]) continue;
			if (!blocks.has(type)) { const index = blocks.size; blocks.set(type, { index, block: { type, text: "" } }); yield { type: "block-start", index, blockType: type }; }
			const state = blocks.get(type); state.block.text += delta[field];
			yield { type: type === "text" ? "text-delta" : "reasoning-delta", index: state.index, text: delta[field] };
		}
		for (const call of delta.tool_calls ?? []) {
			const key = `tool-${call.index}`;
			if (!blocks.has(key)) { const index = blocks.size; blocks.set(key, { index, block: { type: "tool-call", id: "", name: "", arguments: "" } }); yield { type: "block-start", index, blockType: "tool-call" }; }
			const state = blocks.get(key);
			state.block.id += call.id ?? ""; state.block.name += call.function?.name ?? ""; state.block.arguments += call.function?.arguments ?? "";
			yield { type: "tool-call-delta", index: state.index, id: state.block.id, ...(call.function?.name ? { name: state.block.name } : {}), argumentsDelta: call.function?.arguments ?? "" };
		}
	}
	try {
		while (!ended) {
			refreshTimeout();
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			if (buffer.length > 4_000_000) throw new LlmError("模型单条流事件过大。", "INVALID_RESPONSE");
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") { ended = true; break; }
				if (data) {
					let payload;
					try { payload = JSON.parse(data); } catch { throw new LlmError("模型返回了无效的流数据。", "INVALID_RESPONSE"); }
					yield* apply(payload);
				}
			}
			if (done) break;
		}
		if (!finish) throw new LlmError("模型响应在结束标记前中断，请检查连接。", "TRANSPORT");
		const kind = { stop: "stop", tool_calls: "tool-calls", length: "max-tokens" }[finish];
		if (!kind) throw new LlmError("模型服务未正常完成本次回答。", "INVALID_RESPONSE");
		if (!blocks.size) throw new LlmError("模型返回空内容。", "EMPTY_RESPONSE");
		for (const { index, block } of blocks.values()) {
			if (block.type === "tool-call" && kind === "tool-calls") {
				if (!block.id || !block.name) throw new LlmError("模型工具调用缺少标识。", "INVALID_RESPONSE");
				try { JSON.parse(block.arguments); } catch { throw new LlmError("模型工具参数不完整。", "INVALID_RESPONSE"); }
			}
			yield { type: "block-end", index, block };
		}
		if (usage) yield { type: "usage", usage };
		yield { type: "finish", reason: { kind } };
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class NexoModelAdapter extends LlmAdapter {
	constructor(ctx, fetchImpl = fetch) { super(); this.ctx = ctx; this.fetch = fetchImpl; }
	providerInfo(route) { const p = Object.values(MODEL_PROVIDERS).find(p => p.route === route); return { id: route, name: p?.label ?? route }; }
	config(route, model) {
		const provider = Object.values(MODEL_PROVIDERS).find(p => p.route === route);
		if (!provider) throw new LlmError("未注册模型服务。", "NO_ADAPTER");
		const s = this.ctx.settings.get("nexogenesis") ?? {};
		return normalizeModelSettings({ ...(s.provider === provider.id || !s.provider && provider.id === "deepseek" ? s : s.provider_configs?.[provider.id]), provider: provider.id, model });
	}
	async listModels(route) { const p = Object.values(MODEL_PROVIDERS).find(p => p.route === route); return Promise.all(p.models.map(m => this.resolveModel(route, m.id))); }
	async resolveModel(route, model) {
		const c = this.config(route, model); const cap = modelCapabilities(c.provider, model, c);
		const efforts = cap.thinking === "none" ? [] : [...(cap.thinking === "toggle" ? ["off"] : []), ...(cap.efforts.length ? cap.efforts : ["high"])];
		return { provider: route, id: model, name: cap.label, inputModalities: cap.vision ? ["text", "image"] : ["text"], ...(cap.known ? { context: { contextWindow: cap.context } } : {}),
			...(efforts.length ? { reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort: selectedEffort(c) } } : {}) };
	}
	async *stream(options) {
		let budgetContext;
		try { budgetContext = captureProviderRequestContext(this.ctx, options); }
		catch (error) { if (error instanceof ProviderBudgetError) throw new LlmError(error.message, error.code); throw error; }
		const config = this.config(options.provider, options.model);
		const provider = MODEL_PROVIDERS[config.provider];
		const credential = await resolveModelCredential(this.ctx, provider.credential_ref);
		const key = assertUsableApiKey(credential?.value ?? "", "nexogenesis", provider.credential_ref);
		const body = await buildModelRequest(options, config, this.ctx.get("attachments"));
		const controller = new AbortController();
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		let timer, reservation, usage, outcome = 'incomplete';
		const refresh = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error("模型流超过 180 秒无响应。")), 180000); };
		try {
			refresh();
			signal.throwIfAborted();
			const endpoint = `${validateEndpoint(config.base_url)}/chat/completions`;
			const requestBody = JSON.stringify(body);
			assertUnoWireBudget(options, requestBody);
			reservation = reserveProviderRequest(this.ctx, options, budgetContext);
			captureWireInput(body);
			const response = await this.fetch(endpoint, {
				method: "POST", redirect: "error", signal, headers: { ...attributionHeaders(), "content-type": "application/json", authorization: `Bearer ${key}` }, body: requestBody,
			});
			if (!response.ok) throw new LlmError(`模型 ${config.model} 请求失败（HTTP ${response.status}），请检查密钥、模型权限、参数或额度。`,
				response.status === 429 ? "RATE_LIMIT" : response.status === 401 || response.status === 403 ? "AUTH" : response.status >= 500 ? "SERVER" : "INVALID_REQUEST", { status: response.status });
			if (!response.body) throw new LlmError("模型没有返回流。", "EMPTY_RESPONSE");
			for await (const chunk of completionChunks(response.body, refresh)) {
				if (chunk.type === 'usage') usage = chunk.usage;
				if (chunk.type === 'finish') outcome = chunk.reason.kind === 'max-tokens' ? 'truncated' : 'completed';
				yield chunk;
			}
		} catch (error) {
			outcome = signal.aborted ? 'cancelled' : 'failed';
			if (error instanceof ProviderBudgetError) throw new LlmError(error.message, error.code);
			throw error;
		} finally {
			clearTimeout(timer); controller.abort();
			try { settleProviderRequest(reservation, { state: outcome, usage }); }
			catch (error) { if (error instanceof ProviderBudgetError) throw new LlmError(error.message, error.code); throw error; }
		}
	}
}

export function registerModelAdapter(ctx) {
	ctx.effect(() => registerNativeKimiBudget(ctx), 'nexogenesis-web-host: native Kimi request budget');
	ctx.inject(["llm"], llmCtx => llmCtx.llm.registerAdapter(Object.values(MODEL_PROVIDERS).filter(p => p.id !== "kimi_code_plan").map(p => p.route), new NexoModelAdapter(llmCtx)));
}
