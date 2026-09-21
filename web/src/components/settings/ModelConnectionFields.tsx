import { useEffect, useRef, useState } from "react";
import { testModelConnection, type ConnectionTestResult, type ModelConnection, type ModelProvider, type Settings, type VisionMode } from "../../api/client";
import { MODEL_PROVIDERS, modelCapabilities, selectedEffort, validateModelSettings, visionSelection } from "../../../../packages/nexogenesis-tools/lib/model-providers.js";
import "./modelConnection.css";

export interface ModelConnectionFieldsProps {
  settings: Settings | null; connection: ModelConnection; apiKey: string; showApiKey: boolean;
  onProviderChange: (value: ModelProvider) => void; onChange: (value: Partial<ModelConnection>) => void;
  onApiKeyChange: (value: string) => void; onToggleApiKey: () => void;
  visionMode: VisionMode; visionBaseUrl: string; visionModel: string; visionApiKey: string;
  onVisionModeChange: (value: VisionMode) => void; onVisionBaseUrlChange: (value: string) => void;
  onVisionModelChange: (value: string) => void; onVisionApiKeyChange: (value: string) => void;
}

const EFFORT_LABELS: Record<string, string> = { low: "低 · 更快", medium: "中", high: "高 · 深入", max: "最大 · 更耗时" };
export function ModelConnectionFields(p: ModelConnectionFieldsProps) {
  const c = p.connection;
  const provider = MODEL_PROVIDERS[c.provider];
  const cap = modelCapabilities(c.provider, c.model, c);
  const key = p.settings?.credential_status?.[c.provider];
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [testing, setTesting] = useState(false);
  const testController = useRef<AbortController | null>(null);
  useEffect(() => { setRemoteModels([]); }, [c.provider, c.base_url, p.apiKey]);
  useEffect(() => {
    testController.current?.abort(); testController.current = null;
    setTesting(false); setTestResult(null); setTestError("");
    return () => { testController.current?.abort(); testController.current = null; };
  }, [c, p.apiKey]);
  const models = [...provider.models, ...remoteModels.filter(id =>
    c.provider !== "kimi_code_plan" && !provider.models.some(entry => entry.id === id)).map(id => ({ id, label: id }))];
  const chooseModel = (model: string) => p.onChange({ model, thinking_mode: "auto", reasoning_effort: "auto", model_type: "auto", thinking_protocol: "none" });
  let validation = "";
  try { validateModelSettings(c); } catch (error) { validation = error instanceof Error ? error.message : "请检查连接配置。"; }
  const effort = selectedEffort({ ...c, reasoning_effort: "auto" });
  const testConnection = async () => {
    if (testController.current) return;
    const controller = new AbortController(); testController.current = controller;
    setTesting(true); setTestResult(null); setTestError("");
    try {
      const result = await testModelConnection(c, p.apiKey, controller.signal);
      if (testController.current !== controller) return;
      setTestResult(result); setRemoteModels(result.models);
    } catch (error) {
      if (testController.current === controller && !controller.signal.aborted) setTestError(error instanceof Error ? error.message : "连接测试失败。");
    } finally {
      if (testController.current === controller) { testController.current = null; setTesting(false); }
    }
  };
  const vision = visionSelection({ ...c, vision_mode: p.visionMode, vision_base_url: p.visionBaseUrl, vision_model: p.visionModel });
  return <div className="settings-page model-connection">
    {p.settings && p.settings.model_settings_version !== 2 && <p role="alert" className="model-connection__notice">后台尚未加载新版模型配置，请先重启 NEXO。当前不能保存新参数。</p>}
    <div className="settings-credential-status">
      <div><strong>凭据状态</strong><span>网页保存的密钥优先用于 UNO，不改动启动环境中的密钥；已保存不代表连接可用。</span></div>
      <span className={key?.has_key ? "is-configured" : ""}><i aria-hidden />{p.apiKey.trim() ? "新密钥待保存" : key?.has_key ? "已保存" : "尚未配置"}</span>
    </div>
    <section className="model-connection__section" aria-label="模型服务">
      <header className="model-connection__heading"><h3>连接主模型</h3><p>这里选择实际调用的供应商和模型。对话、编译与建构共用连接；思考深度只控制对话，编译与建构使用各自固定策略。</p></header>
      <label className="settings-field"><span className="settings-field__label">模型服务提供方</span>
        <select aria-label="模型服务提供方" value={c.provider} onChange={e => p.onProviderChange(e.target.value as ModelProvider)}>{Object.values(MODEL_PROVIDERS).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>
        <span className="settings-field__hint">{provider.description} {provider.docs && <a href={provider.docs} target="_blank" rel="noreferrer">官方接口说明 ↗</a>}</span>
      </label>
      <label className="settings-field"><span className="settings-field__label">{provider.label} API Key</span>
        <span className="settings-secret-field"><input aria-label={provider.label + " API Key"} type={p.showApiKey ? "text" : "password"} autoComplete="off" value={p.apiKey} onChange={e => p.onApiKeyChange(e.target.value)} placeholder={key?.has_key ? "已保存 · 留空保持不变" : "输入该供应商的 API Key"} />
          <button type="button" onClick={p.onToggleApiKey} aria-label={p.showApiKey ? "隐藏 API Key" : "显示 API Key"}>{p.showApiKey ? "隐藏" : "显示"}</button></span>
      </label>
      <label className="settings-field"><span className="settings-field__label">Base URL</span><input aria-label="Base URL" value={c.base_url} readOnly={c.provider !== "custom"} placeholder="https://…/v1" onChange={e => p.onChange({ base_url: e.target.value })} />
        <span className="settings-field__hint">{c.provider === "custom" ? "修改地址须重新输入密钥。只支持 Chat Completions；远程地址须使用 HTTPS。" : c.provider === "kimi_code_plan" ? "Anthropic Messages 协议 · 保留原生套餐适配。" : "OpenAI Chat Completions 兼容协议 · 固定官方端点，防止密钥错发。"}</span>
      </label>
      <label className="settings-field"><span className="settings-field__label">模型</span>
        <select aria-label="已登记模型" value={models.some(entry => entry.id === c.model) ? c.model : ""} onChange={e => { if(e.target.value) chooseModel(e.target.value); }}>
          <option value="">选择已登记型号，或在下方输入准确 ID</option>
          {models.map(entry => <option key={entry.id} value={entry.id}>{entry.label}{entry.label !== entry.id ? " — " + entry.id : ""}</option>)}
        </select>
      </label>
      <label className="settings-field"><span className="settings-field__label">模型 ID</span>
        <input aria-label="模型 ID" value={c.model} autoComplete="off" spellCheck={false} readOnly={c.provider === "kimi_code_plan"} placeholder="供应商提供的完整模型 ID" onChange={e => chooseModel(e.target.value)} />
        <span className="settings-field__hint">{c.provider === "kimi_code_plan" ? "Kimi Code Plan 使用原生适配支持的预设型号；其它兼容接口可直接输入模型 ID。" : "这是发送给供应商的实际模型 ID。服务目录只证明该 ID 可见，不会自动证明图像或思考参数兼容；保存不会调用模型。"}</span>
      </label>
      <div className="model-connection__capabilities" aria-live="polite">
        <span>{cap.known ? cap.vision ? "已登记 · 图文" : "已登记 · 文本" : "未登记 · 需声明能力"}</span>
        <span>{cap.thinking === "always" ? "始终思考" : cap.thinking === "toggle" ? "支持开关思考" : "未声明思考控制"}</span>
        <span>实际 ID：{c.model || "未填写"}</span>
        {cap.legacy_alias && <span>兼容旧名 · 当前对应 {cap.canonical_id}</span>}
      </div>
      {validation && <p className="model-connection__notice is-error" role="status">{validation}</p>}
      <div className="model-connection__test">
        <div className="model-connection__test-actions"><button type="button" className="settings-button settings-button--secondary" disabled={testing || p.settings?.connection_test_version !== 1 || !c.base_url.trim() || (!p.apiKey.trim() && !key?.has_key)} onClick={() => void testConnection()}>{testing ? "正在测试连接…" : "测试连接并读取模型"}</button>
          {testing && <button type="button" className="settings-text-button" onClick={() => { testController.current?.abort(); testController.current = null; setTesting(false); }}>取消测试</button>}
        </div>
        <p className="settings-field__hint">只读取模型目录，不发送知识或生成请求，不保存配置。</p>
        {p.settings && p.settings.connection_test_version !== 1 && <p className="model-connection__notice">重启 UNO 后端后可使用连接测试；模型配置仍可正常保存。</p>}
        {testResult && <p className="model-connection__test-result" role="status">{testResult.message} 耗时 {(testResult.elapsed_ms / 1000).toFixed(2)} 秒。{testResult.truncated && "目录仅展示前 500 项。"}</p>}
        {testError && <p className="model-connection__test-result is-error" role="alert">{testError}</p>}
      </div>
    </section>
    <details className="model-connection__section model-connection__advanced">
      <summary>对话思考深度 <span>{c.thinking_mode === "disabled" ? "思考已关闭" : c.reasoning_effort !== "auto" ? EFFORT_LABELS[c.reasoning_effort] ?? c.reasoning_effort : "模型默认"}</span></summary>
      <p className="model-connection__notice">这里只控制普通对话。编译会按“制卡/审核/返工”分别采用固定的经济性策略；建构采用固定的深入策略，不继承这里的选择。</p>
      {!cap.known && <div className="model-connection__row">
        <label className="settings-field"><span className="settings-field__label">模型类型</span><select aria-label="模型类型" value={c.model_type} onChange={e => p.onChange({ model_type: e.target.value as ModelConnection["model_type"] })}><option value="auto">未知 · 不自动发送图片</option><option value="text">仅文本</option><option value="vision">图文 · 已确认支持图片</option></select></label>
        <label className="settings-field"><span className="settings-field__label">接口如何控制思考</span><select aria-label="思考参数协议" value={c.thinking_protocol} onChange={e => p.onChange({ thinking_protocol: e.target.value as ModelConnection["thinking_protocol"], thinking_mode: "auto", reasoning_effort: "auto" })}><option value="none">未知 · 不发送控制参数</option><option value="deepseek">DeepSeek 兼容 · thinking.type</option><option value="qwen">Qwen 兼容 · enable_thinking</option><option value="openai">OpenAI 兼容 · reasoning_effort</option><option value="zai">GLM 兼容 · thinking.type</option></select><span className="settings-field__hint">仅在手动输入未登记模型时使用；选错协议可能被供应商拒绝。</span></label>
      </div>}
      <div className="model-connection__row">
        <label className="settings-field"><span className="settings-field__label">思考模式</span><select aria-label="思考模式" value={c.thinking_mode} disabled={cap.thinking !== "toggle"} onChange={e => p.onChange({ thinking_mode: e.target.value as ModelConnection["thinking_mode"], reasoning_effort: "auto" })}><option value="auto">{cap.thinking === "always" ? "自动 · 原生适配开启" : "模型默认"}</option><option value="enabled">开启</option><option value="disabled">关闭</option></select></label>
        <label className="settings-field"><span className="settings-field__label">思考强度</span><select aria-label="思考强度" value={c.reasoning_effort} disabled={!cap.efforts.length || c.thinking_mode === "disabled"} onChange={e => p.onChange({ reasoning_effort: e.target.value })}><option value="auto">{!cap.efforts.length ? "当前适配不提供强度档位" : "自动 · " + (EFFORT_LABELS[effort ?? ""] ?? "服务默认")}</option>{cap.efforts.map(effort => <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}</option>)}</select></label>
      </div>
      <p className="model-connection__notice">切换型号会重置不兼容的参数。当前接入尚未支持的能力不会因目录出现新型号而自动开放。</p>
    </details>
    <details className="model-connection__section model-connection__advanced">
      <summary>图像处理 <span>可选</span></summary>
      <label className="settings-field"><span className="settings-field__label">图像处理</span><select aria-label="图像处理方式" value={p.visionMode} onChange={e => p.onVisionModeChange(e.target.value as VisionMode)}><option value="auto">自动 · 主模型优先，独立服务补充</option><option value="main">仅使用主模型</option><option value="custom">仅使用独立视觉服务</option><option value="off">关闭 · 保留图片待处理</option></select>
        <span className="settings-field__hint">为支持读图的功能配置视觉服务。新编译目前只处理提取文本，不会因配置视觉服务而自动补做 PDF 图表或 OCR，也不会猜测图像语义。</span>
      </label>
      <p className="model-connection__notice" role="status">{vision.available ? `将使用${vision.source === "main" ? "主模型" : "独立视觉模型"} ${vision.model}。${vision.source === "main" ? "自动复用该供应商的密钥，无需重复配置。" : "使用独立的视觉密钥。"}` : vision.reason}</p>
      {(p.visionMode === "auto" || p.visionMode === "custom") && <details open={p.visionMode === "custom" || undefined}><summary>独立视觉服务{p.visionBaseUrl && p.visionModel ? " · 已填写" : " · 按需配置"}</summary>
        <label className="settings-field"><span className="settings-field__label">视觉 Base URL</span><input value={p.visionBaseUrl} onChange={e => p.onVisionBaseUrlChange(e.target.value)} placeholder="https://…/v1" /></label>
        <label className="settings-field"><span className="settings-field__label">视觉模型 ID</span><input value={p.visionModel} onChange={e => p.onVisionModelChange(e.target.value)} placeholder="支持 image_url 的模型 ID" /></label>
        <label className="settings-field"><span className="settings-field__label">视觉 API Key</span><input type="password" autoComplete="off" value={p.visionApiKey} onChange={e => p.onVisionApiKeyChange(e.target.value)} placeholder={p.settings?.has_vision_key ? "已保存 · 留空保持不变" : "输入独立服务的密钥"} /></label>
      </details>}
    </details>
  </div>;
}
