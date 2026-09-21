import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { Context } from "../packages/nexogenesis-web-host/node_modules/@deepseek-ai/cordis/lib/index.js";
import { LlmRuntime, BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { conversationPersonaInstruction, modelSelectionFromSettings, workflowModelSelectionFromSettings, handleSettingsPut, handleSettingsGet } from "../packages/nexogenesis-web-host/lib/settings.js";
import { MODEL_PROVIDERS, normalizeModelSettings, modelCapabilities, validateModelSettings, visionSelection, selectedEffort, workflowReasoningPolicy } from "../packages/nexogenesis-tools/lib/model-providers.js";
import { NexoModelAdapter, buildModelRequest, completionChunks } from "../packages/nexogenesis-web-host/lib/model-adapter.js";

function context(initial = {}) {
  const namespaces = { nexogenesis: initial, "llm-pi-ai": { providers: { untouched: { baseURL: "https://example.org" } } } };
  const keys = new Map();
  return { namespaces, keys, get: () => undefined,
    settings: { get: ns => namespaces[ns], update: async (ns, patch) => { namespaces[ns] = { ...namespaces[ns], ...patch }; } },
    credentials: { describe: async ref => ({ configured: keys.has(ref) }), resolve: async ref => keys.has(ref) ? { value: keys.get(ref) } : undefined, set: async (ref, value) => { keys.set(ref, value); } } };
}
async function save(ctx, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.headers = { "content-type": "application/json" };
  const res = { writeHead(status) { this.status = status; }, end(body) { this.data = JSON.parse(body); } };
  await handleSettingsPut(ctx, req, res); return res.data;
}
const config = (provider, model, extra = {}) => normalizeModelSettings({ provider, ...(model ? { model } : {}), ...extra });
const user = { role: "user", content: [{ type: "text", text: "hello" }] };
const request = (c, extra = {}) => buildModelRequest({ model: c.model, messages: [user], ...extra }, c);
function stream(payloads, chunkSize = 19) {
  const bytes = Buffer.from(payloads.map(p => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join(""));
  return new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize)); controller.close(); } });
}
const collect = async iterator => { const chunks = []; for await (const chunk of iterator) chunks.push(chunk); return chunks; };

test("实际 DSH 注册与流组装接受新适配器，保留正文、思考与结束状态", async () => {
  const root = new Context();
  const runtime = new LlmRuntime(root);
  const ctx = context(config("kimi", "kimi-k3", { reasoning_effort: "low" }));
  ctx.keys.set("MOONSHOT_API_KEY", "test-only");
  const adapter = new NexoModelAdapter(ctx, async (_url, init) => {
    assert.equal(JSON.parse(init.body).reasoning_effort, "low");
    return new Response(stream([
      { choices: [{ delta: { reasoning_content: "检验依据" } }] },
      { choices: [{ delta: { content: "有据可查" }, finish_reason: "stop" }] }, "[DONE]",
    ]));
  });
  const dispose = runtime.registerAdapter(["nexo-kimi"], adapter);
  try {
    const assembler = new BlockAssembler();
    const chunks = await collect(runtime.stream({ provider: "nexo-kimi", model: "kimi-k3", messages: [createUserMessage({ content: [{ type: "text", text: "测试" }] })] }));
    for (const chunk of chunks) assembler.push(chunk);
    assert.deepEqual(assembler.blocks(), [{ type: "reasoning", text: "检验依据" }, { type: "text", text: "有据可查" }]);
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
    assert.equal(chunks.find(c => c.type === "text-delta").text, "有据可查");
    const unsupported = await collect(runtime.stream({ provider: "nexo-kimi", model: "kimi-k3", reasoningEffort: "medium", messages: [] }));
    assert.equal(unsupported.at(-1).reason.kind, "error");
  } finally { dispose(); }
});

test("未知协议的模型默认不强加参数，原生套餐未知型号明确拒绝", async () => {
  const c = config("custom", "private-model", { base_url: "https://example.org/v1", thinking_protocol: "qwen" });
  const body = await request(c);
  assert.equal(body.enable_thinking, undefined);
  assert.throws(() => validateModelSettings(config("kimi_code_plan", "not-installed")), /尚未接入/);
  await assert.rejects(request(config("glm", "glm-5.2"), { reasoningEffort: "medium" }), /不支持/);
});

test("升级旧配置后首次切换供应商仍保留原型号；非法密钥不产生写入", async () => {
  const ctx = context(config("deepseek", "deepseek-v4-pro", { thinking_mode: "disabled" }));
  await save(ctx, { provider: "glm" });
  const original = await save(ctx, { provider: "deepseek" });
  assert.equal(original.model, "deepseek-v4-pro");
  assert.equal(original.thinking_mode, "disabled");
  const count = ctx.keys.size;
  await assert.rejects(save(ctx, { api_key: "invalid\r\nkey" }));
  assert.equal(ctx.keys.size, count);
});

test("供应商清单独立凭据与端点，未知模型 ID 不再静默替换", () => {
  assert.equal(new Set(Object.values(MODEL_PROVIDERS).map(p => p.credential_ref)).size, 7);
  assert.equal(config("kimi", "new-model").model, "new-model");
  assert.equal(modelCapabilities("kimi", "new-model").vision, false);
  assert.throws(() => config("missing"));
  assert.throws(() => config("__proto__"));
  assert.equal(config("kimi_code_plan", "k3", { base_url: "https://wrong.example" }).base_url, "https://api.kimi.com/coding");
});
test("DeepSeek 的关闭、低、高、最大强度都进入实际请求", async () => {
  for (const effort of ["low", "high", "max"]) {
    const body = await request(config("deepseek", null, { reasoning_effort: effort }));
    assert.equal(body.thinking.type, "enabled"); assert.equal(body.reasoning_effort, effort);
    assert.equal(body.temperature, undefined);
  }
  const body = await request(config("deepseek", null, { thinking_mode: "disabled" }));
  assert.equal(body.thinking.type, "disabled"); assert.equal(body.reasoning_effort, undefined);
  assert.equal(modelSelectionFromSettings({ model: "deepseek-v4-pro" }).provider, "nexo-deepseek");
});
test("Kimi K3 始终思考，仅发送强度；K2.6 可关闭，K2.7 不伪造开关", async () => {
  const k3 = await request(config("kimi", "kimi-k3", { reasoning_effort: "low" }));
  assert.equal(k3.reasoning_effort, "low"); assert.equal(k3.thinking, undefined);
  assert.throws(() => validateModelSettings(config("kimi", "kimi-k3", { thinking_mode: "disabled" })), /不能关闭/);
  assert.equal((await request(config("kimi", "kimi-k2.6", { thinking_mode: "disabled" }))).thinking.type, "disabled");
  assert.equal((await request(config("kimi", "kimi-k2.7-code"))).thinking, undefined);
  assert.equal(selectedEffort(config("kimi", "kimi-k3")), "max");
});
test("GLM 仅 5.2 有强度档位，百炼和硅基流动使用 enable_thinking", async () => {
  assert.equal((await request(config("glm", "glm-5.2"))).reasoning_effort, "max");
  assert.equal((await request(config("glm", "glm-4.7"))).reasoning_effort, undefined);
  assert.throws(() => validateModelSettings(config("glm", "glm-4.7", { reasoning_effort: "max" })));
  for (const provider of ["dashscope", "siliconflow"]) {
    const body = await request(config(provider, null, { thinking_mode: "disabled" }));
    assert.equal(body.enable_thinking, false); assert.equal(body.thinking, undefined);
  }
});
test("参数验证先于任何设置和凭据写入", async () => {
  const ctx = context();
  await assert.rejects(save(ctx, { provider: "kimi", model: "kimi-k3", thinking_mode: "disabled", api_key: "secret" }));
  assert.deepEqual(ctx.namespaces.nexogenesis, {}); assert.equal(ctx.keys.size, 0);
  await assert.rejects(save(ctx, { provider: "custom", model: "x", base_url: "https://key:secret@example.org/v1", api_key: "secret" }));
  await assert.rejects(save(ctx, { provider: "custom", model: "x", base_url: "http://example.org/v1", api_key: "secret" }));
});
test("保存与重新打开保留供应商配置，不回显密钥", async () => {
  const ctx = context();
  await save(ctx, { provider: "glm", model: "glm-5.2", api_key: "glm-secret", thinking_mode: "enabled", reasoning_effort: "max" });
  await save(ctx, { provider: "kimi", model: "kimi-k3", api_key: "kimi-secret" });
  const saved = await save(ctx, { provider: "glm" });
  assert.equal(saved.reasoning_effort, "max"); assert.equal(saved.model, "glm-5.2");
  assert.equal(ctx.keys.get("NEXO_GLM_API_KEY"), "glm-secret"); assert.equal(ctx.keys.get("MOONSHOT_API_KEY"), "kimi-secret");
  assert.ok(!JSON.stringify(saved).includes("secret")); assert.equal(saved.model_settings_version, 2);
});
test("Code Plan 保留既有原生路由和独立密钥", async () => {
  const ctx = context();
  const saved = await save(ctx, { provider: "kimi_code_plan", model: "k3-256k", api_key: "code-secret" });
  assert.deepEqual(modelSelectionFromSettings(saved), { provider: "kimi-coding", model: "k3-256k", reasoningEffort: "max" });
  assert.ok(ctx.namespaces["llm-pi-ai"].providers.untouched);
  assert.equal(ctx.namespaces["llm-pi-ai"].providers["kimi-coding"].apiKeyEnv, "KIMI_CODE_PLAN_API_KEY");
  assert.equal(ctx.keys.has("MOONSHOT_API_KEY"), false);
});
test("未知模型支持显式视觉声明，端点变化不得复用旧密钥", async () => {
  const ctx = context();
  await save(ctx, { provider: "custom", model: "my-vision", base_url: "https://example.org/v1", api_key: "key", model_type: "vision" });
  assert.equal(visionSelection(ctx.namespaces.nexogenesis).source, "main");
  await assert.rejects(save(ctx, { base_url: "https://another.example/v1" }), /重新输入密钥/);
  assert.equal(ctx.namespaces.nexogenesis.base_url, "https://example.org/v1");
});
test("视觉默认复用主模型和对应凭据；非视觉主模型只用显式备用", () => {
  for (const [provider, model] of [["kimi", "kimi-k3"], ["kimi_code_plan", "k3"], ["glm", "glm-4.6v"], ["deepseek", "deepseek-flash"], ["deepseek", "deepseek-v4-flash-vision-exp"]]) {
    const vision = visionSelection(config(provider, model));
    assert.equal(vision.source, "main"); assert.equal(vision.credential_ref, MODEL_PROVIDERS[provider].credential_ref);
  }
  const plain = config("deepseek", "deepseek-v4-pro"); assert.equal(visionSelection(plain).available, false);
  const backup = { ...plain, vision_model: "custom-vl", vision_base_url: "https://example.org/v1" };
  assert.equal(visionSelection(backup).source, "custom");
  assert.equal(visionSelection({ ...backup, vision_mode: "main" }).available, false);
  assert.equal(visionSelection({ ...config("kimi"), vision_mode: "off" }).available, false);
});
test("只读设置不会激活模型、修改凭据或暴露密钥", async () => {
  const ctx = context(config("kimi")); ctx.keys.set("MOONSHOT_API_KEY", "secret");
  const before = JSON.stringify(ctx.namespaces);
  const res = { writeHead() {}, end(body) { this.body = body; } };
  await handleSettingsGet(ctx, {}, res);
  assert.equal(JSON.stringify(ctx.namespaces), before); assert.ok(!res.body.includes("secret"));
  assert.equal(JSON.parse(res.body).vision_status.source, "main");
});
test("完整回送普通思考回合、工具调用及工具结果，而非只回送可见正文", async () => {
  const messages = [user, { role: "assistant", content: [{ type: "reasoning", text: "reason-one" }, { type: "text", text: "answer-one" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "reason-two" }, { type: "tool-call", id: "call1", name: "read_card", arguments: '{"id":"one"}' }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call1", content: [{ type: "text", text: "evidence" }] }] }];
  const body = await request(config("kimi"), { messages, system: "system", tools: [{ name: "read_card", description: "read", parameters: { type: "object" } }] });
  assert.equal(body.messages[0].role, "system"); assert.equal(body.messages[2].reasoning_content, "reason-one");
  assert.equal(body.messages[3].tool_calls[0].id, "call1"); assert.equal(body.messages[4].tool_call_id, "call1");
});
test("SSE 跨字节解析中文、思考、工具参数与用量", async () => {
  const payloads = [{ choices: [{ delta: { reasoning_content: "分析" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "id", function: { name: "read", arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } }, "[DONE]"];
  const chunks = await collect(completionChunks(stream(payloads, 1)));
  assert.equal(chunks.find(x => x.type === "block-end" && x.block.type === "tool-call").block.arguments, '{"x":1}');
  assert.equal(chunks.find(x => x.type === "reasoning-delta").text, "分析");
  assert.equal(chunks.find(x => x.type === "usage").usage.inputTokens, 80);
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
});
test("断流和残缺工具参数不能伪装成完成", async () => {
  await assert.rejects(collect(completionChunks(stream([{ choices: [{ delta: { content: "partial" } }] }]))), /中断/);
  await assert.rejects(collect(completionChunks(stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "x", arguments: "{" } }] }, finish_reason: "tool_calls" }] }, "[DONE]"]))), /参数不完整/);
});
test("真实适配器发请求时使用正确端点、凭据、参数与禁止重定向", async () => {
  const ctx = context(config("glm", "glm-5.2")); ctx.keys.set("NEXO_GLM_API_KEY", "glm-secret");
  let sent;
  const adapter = new NexoModelAdapter(ctx, async (url, init) => { sent = { url, ...init }; return new Response(stream([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }, "[DONE]"])); });
  const chunks = await collect(adapter.stream({ provider: "nexo-glm", model: "glm-5.2", reasoningEffort: "max", messages: [user] }));
  assert.equal(sent.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer glm-secret"); assert.equal(sent.redirect, "error");
  assert.equal(JSON.parse(sent.body).reasoning_effort, "max"); assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.ok(Object.keys(sent.headers).some(key => /user-agent/i.test(key)));
});
test("供应商错误不回显其响应正文里的敏感信息", async () => {
  const ctx = context(config("deepseek")); ctx.keys.set("DEEPSEEK_API_KEY", "secret");
  const adapter = new NexoModelAdapter(ctx, async () => new Response('{"error":"secret"}', { status: 401 }));
  await assert.rejects(collect(adapter.stream({ provider: "nexo-deepseek", model: "deepseek-v4-flash", messages: [user] })), e => !e.message.includes("secret") && e.failure.status === 401);
});
import { probeModelConnection } from '../packages/nexogenesis-web-host/lib/settings-test.js';
import { localCredentialRef } from '../packages/nexogenesis-web-host/lib/model-credentials.js';
test('环境密钥只读时网页保存到本地覆盖，目录和实际生成使用同一新密钥',async()=>{
 const ctx=context(config('deepseek'));ctx.keys.set('DEEPSEEK_API_KEY','inherited-test-key');
 const originalDescribe=ctx.credentials.describe,originalSet=ctx.credentials.set;const writes=[];
 ctx.credentials.describe=async ref=>({...await originalDescribe(ref),writable:ref!=='DEEPSEEK_API_KEY'});
 ctx.credentials.set=async(ref,value)=>{assert.notEqual(ref,'DEEPSEEK_API_KEY');writes.push(ref);await originalSet(ref,value);};
 const result=await save(ctx,{provider:'deepseek',model:'private-deepseek-id',api_key:'replacement-test-key'});
 assert.equal(ctx.keys.get('DEEPSEEK_API_KEY'),'inherited-test-key');assert.equal(result.model,'private-deepseek-id');assert.equal(result.has_key,true);assert.ok(!JSON.stringify(result).includes('replacement-test-key'));
 await probeModelConnection(ctx,{}, {fetchImpl:async(_url,init)=>{assert.equal(init.headers.authorization,'Bearer replacement-test-key');return Response.json({data:[]});}});
 const adapter=new NexoModelAdapter(ctx,async(_url,init)=>{assert.equal(init.headers.authorization,'Bearer replacement-test-key');return new Response(stream([{choices:[{delta:{content:'OK'},finish_reason:'stop'}]},'[DONE]']));});
 await collect(adapter.stream({provider:'nexo-deepseek',model:'private-deepseek-id',messages:[user]}));
 await save(ctx,{api_key:'replacement-second-key'});assert.equal(ctx.keys.get(localCredentialRef('DEEPSEEK_API_KEY')),'replacement-second-key');assert.deepEqual([...new Set(writes)],[localCredentialRef('DEEPSEEK_API_KEY')]);
});
test("对话人设保存后进入受边界约束的普通对话提示，且限制异常长输入", async () => {
  const ctx=context();
  await save(ctx,{style_prompt:"像严谨但自然的研究伙伴，先说结论。"});
  assert.match(conversationPersonaInstruction(ctx),/严谨但自然/);
  assert.match(conversationPersonaInstruction(ctx),/不能改变事实边界/);
  await assert.rejects(save(ctx,{style_prompt:"人".repeat(12001)}),/不能超过 12000 字/);
});
test("DeepSeek 当前 ID 与旧别名使用同一能力，固定工作流不继承对话深度", () => {
  const current=modelCapabilities("deepseek","deepseek-flash"),legacy=modelCapabilities("deepseek","deepseek-v4-flash");
  assert.equal(current.known,true);assert.equal(current.vision,true);assert.equal(legacy.known,true);assert.equal(legacy.legacy_alias,true);assert.equal(legacy.canonical_id,"deepseek-flash");
  const settings=config("deepseek","deepseek-flash",{reasoning_effort:"max"});
  assert.equal(modelSelectionFromSettings(settings).reasoningEffort,"max");
  assert.deepEqual(workflowReasoningPolicy(settings,"compile"),{generate:"low",supplement:"low",repair:"low",check:"off",verify:"off"});
  assert.deepEqual(workflowModelSelectionFromSettings(settings,"compile").selection,{provider:"nexo-deepseek",model:"deepseek-flash"});
  assert.equal(workflowModelSelectionFromSettings(settings,"construct").selection.reasoningEffort,"high");
});
test('套餐环境密钥只读时原生路由也指向本地覆盖，不修改环境',async()=>{
 const ctx=context(config('kimi_code_plan'));ctx.keys.set('KIMI_CODE_PLAN_API_KEY','inherited-test-key');const describe=ctx.credentials.describe;
 ctx.credentials.describe=async ref=>({...await describe(ref),writable:ref!=='KIMI_CODE_PLAN_API_KEY'});
 await save(ctx,{provider:'kimi_code_plan',api_key:'replacement-test-key'});
 assert.equal(ctx.namespaces['llm-pi-ai'].providers['kimi-coding'].apiKeyEnv,localCredentialRef('KIMI_CODE_PLAN_API_KEY'));assert.equal(ctx.keys.get('KIMI_CODE_PLAN_API_KEY'),'inherited-test-key');
});
