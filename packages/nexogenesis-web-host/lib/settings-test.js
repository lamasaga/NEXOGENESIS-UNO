import { resolveModelCredential } from "./model-credentials.js";
/** Read-only connection check: one model-directory request, no generation or settings writes. */
import { assertUsableApiKey, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { modelCapabilities, normalizeModelSettings, providerConfigOf, validateModelSettings, validateEndpoint } from "../../nexogenesis-tools/lib/model-providers.js";
import { HttpError, json, readJsonBody } from "./rpc.js";

const pending = new WeakSet();
const statusMessage = status => ({
  401: "密钥或账户权限未通过验证，请核对供应商、密钥和套餐。",
  403: "服务拒绝访问，请检查账户权限、套餐或访问限制。",
  404: "此地址没有提供模型目录。请核对 Base URL；不提供目录的服务仍可手动填写模型并保存。",
  429: "服务暂时限流或额度不足，请稍后再试。",
}[status] ?? (status >= 500 ? "模型服务暂时不可用，请稍后再试。" : "服务拒绝了模型目录请求，请核对接口地址和账户权限。"));

export async function probeModelConnection(ctx, body, { fetchImpl = fetch, signal, timeoutMs = 15000 } = {}) {
  let current, active, provider, key;
  try {
    current = ctx.settings.get("nexogenesis") ?? {};
    provider = providerConfigOf(body.provider ?? current.provider);
    const previous = provider.id === (current.provider ?? "deepseek") ? current : { provider: provider.id, ...current.provider_configs?.[provider.id] };
    active = normalizeModelSettings({ ...previous, ...Object.fromEntries(
      ["provider", "base_url", "model", "thinking_mode", "reasoning_effort", "model_type", "thinking_protocol"]
        .filter(field => body[field] !== undefined).map(field => [field, body[field]])) });
    // Reading a directory is also useful before choosing a model.
    validateModelSettings({ ...active, model: active.model || "connection-check" });
    const supplied = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (provider.id === "custom" && !supplied) {
      const stored = normalizeModelSettings(previous);
      if (!stored.base_url || validateEndpoint(active.base_url) !== validateEndpoint(stored.base_url))
        throw new Error("更换自定义端点时请重新输入密钥，测试不会把旧密钥发送到新地址。");
    }
		key = supplied || (await resolveModelCredential(ctx,provider.credential_ref,{endpoint:provider.id==='custom'?active.base_url:undefined}))?.value || "";
    if (!key) throw new Error("请先输入该供应商的 API Key，或使用已经保存的密钥。");
    assertUsableApiKey(key, "nexogenesis", provider.credential_ref);
  } catch (error) {
    // Validation messages are local; never include credential-service errors.
    const safe = error instanceof Error && /^(请|更换|不支持|该|无效|关闭|远程|Base URL)/.test(error.message);
    throw new HttpError(400, safe ? error.message : "无法读取有效密钥，请重新输入该供应商的 API Key。");
  }
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const base = validateEndpoint(active.base_url);
    const url = provider.id === "kimi_code_plan" ? base + "/v1/models" : base + "/models";
    const response = await fetchImpl(url, {
      method: "GET", redirect: "error", signal: combined,
      headers: { ...attributionHeaders(), accept: "application/json", authorization: "Bearer " + key },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(502, statusMessage(response.status) + "（HTTP " + response.status + "）");
    }
    if (!response.body) throw new HttpError(502, "模型目录返回空响应。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1_000_000) throw new HttpError(502, "模型目录响应过大，请手动填写模型 ID。");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let payload;
    try { payload = JSON.parse(text); } catch { throw new HttpError(502, "服务返回的不是有效模型目录，请核对 Base URL。"); }
    if (!Array.isArray(payload?.data)) throw new HttpError(502, "服务未返回兼容的模型目录，请手动填写模型 ID。");
    const all = [...new Set(payload.data.map(item => item?.id).filter(id =>
      typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 200
      && !/[\u0000-\u001f\u007f]/.test(id) && !id.includes(key)))].sort();
    const selectedCanonical = modelCapabilities(active.provider, active.model, active).canonical_id ?? active.model;
    const listed = all.some(id => (modelCapabilities(active.provider, id, active).canonical_id ?? id) === selectedCanonical);
    return { provider: active.provider, base_url: active.base_url, model: active.model, model_listed: listed,
      models: all.slice(0, 500), truncated: all.length > 500, elapsed_ms: Date.now() - started,
      message: "模型目录可访问。" + (listed ? "所选模型已列出。" : active.model ? "目录未列出所选模型；别名或专属模型可能不在目录中。" : "请选择或填写模型 ID。")
        + "未发送生成请求，尚未验证实际回答能力；测试不会保存配置。" };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (combined.aborted) throw new HttpError(504, "连接测试已取消或超过 15 秒，请检查网络和服务地址。");
    throw new HttpError(502, "无法连接模型目录，请检查网络、证书与 Base URL；不跟随地址重定向。");
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function handleSettingsTest(ctx, req, res) {
  if (pending.has(ctx)) throw new HttpError(409, "已有连接测试正在进行，请稍后再试。");
  pending.add(ctx);
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once?.("close", close);
  try {
    const body = await readJsonBody(req);
    json(res, 200, await probeModelConnection(ctx, body, { signal: controller.signal }));
  } finally { pending.delete(ctx); res.off?.("close", close); }
}
