import { KnowledgeProcessing } from './settings/KnowledgeProcessing';
import { AppearancePicker } from './settings/AppearancePicker';
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchSettings, saveSettings, fetchUnoPreferences, saveUnoPreferences, type UnoPreferences, type ModelProvider, type ModelConnection, type VisionMode, type Settings } from "../api/client";
import { normalizeModelSettings, validateModelSettings } from "../../../packages/nexogenesis-tools/lib/model-providers.js";
import { ModelConnectionFields } from "./settings/ModelConnectionFields";
import { fetchProjectKnowledge, saveProjectKnowledge, type ProjectKnowledge } from '../api/client';

interface Props {
  projectId?: string;
  onClose: () => void;
  initialSection?: SettingsSection;
  onSaved?: (settings: Settings) => void;
}

type SettingsSection = "general" | "model" | "knowledge" | "expression";

const SECTION_COPY: Record<SettingsSection, { label: string; description: string }> = {
  general: { label: "常规", description: "选择界面配色，管理显示名称与设置范围。" },
  model: { label: "模型连接", description: "配置 API 服务与模型，测试连接后保存；设置作用于当前 UNO。" },
  knowledge: { label: "知识处理", description: "" },
  expression: { label: "思维体表达", description: "选择当前项目使用的知识库，并调整回答的组织与措辞。" },
};

const SECTION_ORDER = Object.keys(SECTION_COPY) as SettingsSection[];

export function SettingsModal({ onClose, initialSection = "model", onSaved, projectId }: Props) {
  const [processing,setProcessing]=useState<UnoPreferences|null>(null),[savedProcessing,setSavedProcessing]=useState<UnoPreferences|null>(null);
  const processingDirty=!!processing&&JSON.stringify(processing)!==JSON.stringify(savedProcessing);
  useEffect(()=>{const controller=new AbortController();fetchUnoPreferences(controller.signal).then(v=>{setProcessing(v);setSavedProcessing(v);}).catch(()=>{});return()=>controller.abort();},[]);
  const [knowledge, setKnowledge] = useState<ProjectKnowledge | null>(null);
  const [knowledgeIds, setKnowledgeIds] = useState<string[]>([]);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeRetry, setKnowledgeRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setKnowledge(null); setKnowledgeIds([]); setKnowledgeError(null);
    if (projectId) fetchProjectKnowledge(projectId).then(value => {
      if (!cancelled) { setKnowledge(value); setKnowledgeIds(value.knowledge_instance_ids); }
    }).catch(error => { if (!cancelled) setKnowledgeError(`知识库加载失败：${error}`); });
    return () => { cancelled = true; };
  }, [projectId, knowledgeRetry]);
  const knowledgeDirty = knowledge !== null && JSON.stringify([...knowledgeIds].sort()) !== JSON.stringify([...knowledge.knowledge_instance_ids].sort());
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [username, setUsername] = useState("");
  const [connection, setConnection] = useState<ModelConnection>(() => normalizeModelSettings());
  const { provider, base_url: baseUrl, model } = connection;
  const [connectionDrafts, setConnectionDrafts] = useState<Partial<Record<ModelProvider, ModelConnection>>>({});
  const [apiKey, setApiKey] = useState("");
  const keyDrafts = useRef<Partial<Record<ModelProvider, string>>>({});
  const [visionBaseUrl, setVisionBaseUrl] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [visionApiKey, setVisionApiKey] = useState("");
  const [visionMode, setVisionMode] = useState<VisionMode>("auto");
  const [showApiKey, setShowApiKey] = useState(false);
  const [stylePrompt, setStylePrompt] = useState("");
  const [digestTwoStage, setDigestTwoStage] = useState(true);
  const [pipelineAuthority, setPipelineAuthority] = useState<"manual" | "trusted" | null>(null);
  const [saving, setSaving] = useState(false);


  const [status, setStatus] = useState<string | null>(null);
  let connectionError = "";
  try { validateModelSettings(connection); } catch (error) { connectionError = error instanceof Error ? error.message : "请检查模型配置。"; }

  useEffect(() => {
    fetchSettings()
      .then((loaded) => {
        setSettings(loaded);
        setUsername(loaded.username);
        setConnection(normalizeModelSettings(loaded));
        setConnectionDrafts(loaded.provider_configs ?? {});
        setVisionMode(loaded.vision_mode ?? "auto");
        setVisionBaseUrl(loaded.vision_base_url);
        setVisionModel(loaded.vision_model);
        setStylePrompt(loaded.style_prompt);
        setDigestTwoStage(loaded.digest_two_stage);
        setPipelineAuthority(loaded.pipeline_authority);
      })
      .catch((error) => setStatus(`加载失败：${error}`));
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const isDirty = useMemo(() => {
    if (!settings) return false;
    return processingDirty || knowledgeDirty || apiKey.length > 0 || visionApiKey.length > 0
      || username !== settings.username
      || JSON.stringify(connection) !== JSON.stringify(normalizeModelSettings(settings))
      || visionMode !== (settings.vision_mode ?? "auto")
      || visionBaseUrl !== settings.vision_base_url
      || visionModel !== settings.vision_model
      || stylePrompt !== settings.style_prompt
      || digestTwoStage !== settings.digest_two_stage;
  }, [processingDirty, knowledgeDirty, apiKey, connection, digestTwoStage, settings, stylePrompt, username, visionApiKey, visionBaseUrl, visionModel, visionMode]);

  const chooseProvider = (next: ModelProvider) => {
    if (next === provider) return;
    setConnectionDrafts(current => ({ ...current, [provider]: connection }));
    setConnection(connectionDrafts[next] ?? normalizeModelSettings({ provider: next }));
    keyDrafts.current[provider] = apiKey;
    setApiKey(keyDrafts.current[next] ?? "");
    setShowApiKey(false);
    setStatus(null);
  };

  const save = async () => {
    if (!settings || saving || settings.model_settings_version !== 2 || connectionError) return;
    if(processingDirty&&processing?.construction_controls_contract!=='focus-and-permissions-v1'){setStatus('当前服务尚未加载新版知识处理设置，请更新服务后保存。');return;}
    setSaving(true);
    setStatus("正在保存更改…");
    try {
      const saved = await saveSettings({
        username: username.trim() || "用户",
        ...connection,
        base_url: baseUrl.trim(), model: model.trim(),
        api_key: apiKey,
        vision_base_url: visionBaseUrl.trim(),
        vision_model: visionModel.trim(),
        vision_api_key: visionApiKey,
        vision_mode: visionMode,
        style_prompt: stylePrompt,
        digest_two_stage: digestTwoStage,
        pipeline_authority: pipelineAuthority ?? settings.pipeline_authority,
      });
      setSettings(saved);
      setUsername(saved.username);
      setConnection(normalizeModelSettings(saved));
      setConnectionDrafts(current => ({ ...saved.provider_configs, ...current, [saved.provider]: normalizeModelSettings(saved) }));
      setVisionMode(saved.vision_mode ?? "auto");
      setVisionBaseUrl(saved.vision_base_url);
      setVisionModel(saved.vision_model);
      setStylePrompt(saved.style_prompt);
      setDigestTwoStage(saved.digest_two_stage);
      setPipelineAuthority(saved.pipeline_authority);
      setApiKey("");
      delete keyDrafts.current[provider];
      setVisionApiKey("");
      setShowApiKey(false);
      if (knowledgeDirty && projectId) {
        const savedKnowledge = await saveProjectKnowledge(projectId, knowledgeIds);
        setKnowledge(savedKnowledge); setKnowledgeIds(savedKnowledge.knowledge_instance_ids);
      }
      if(processingDirty&&processing){const updated=await saveUnoPreferences(processing);setProcessing(updated);setSavedProcessing(updated);}
      setStatus("更改已保存");
      onSaved?.(saved);
    } catch (error) {
      setStatus(`保存失败：${error}`);
    } finally {
      setSaving(false);
    }
  };

  const section = SECTION_COPY[activeSection];

  return <div className="settings-overlay" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section className="settings-shell" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <aside className="settings-sidebar">
        <div className="settings-sidebar__title">设置</div>
        <nav className="settings-nav" aria-label="设置分类">
          {SECTION_ORDER.map((id) => <button
            key={id}
            type="button"
            className={activeSection === id ? "is-active" : ""}
            aria-current={activeSection === id ? "page" : undefined}
            onClick={() => setActiveSection(id)}
          >
            <SettingsIcon kind={id} />
            <span>{SECTION_COPY[id].label}</span>
          </button>)}
        </nav>
        <div className="settings-sidebar__scope">
          <ShieldIcon />
          <span>设置保存在本地<br />仅作用于当前 UNO</span>
        </div>
      </aside>

      <div className="settings-main">
        <header className="settings-header">
          <div>
            <h2 id="settings-title">{section.label}</h2>
            {section.description?<p>{section.description}</p>:null}
          </div>
          <button className="settings-close" type="button" aria-label="关闭设置" onClick={onClose}><CloseIcon /></button>
        </header>

        <fieldset className="settings-content" disabled={saving || (!settings && activeSection !== "general")}>
          {!settings && !status && <div className="settings-loading" role="status">正在读取设置…</div>}
          {activeSection === "general" && <GeneralSettings username={username} onUsernameChange={setUsername} loading={!settings} />}
          {activeSection === "model" && <ModelConnectionFields
            settings={settings} connection={connection} apiKey={apiKey} showApiKey={showApiKey}
            onProviderChange={chooseProvider} onApiKeyChange={setApiKey} onChange={patch => { setConnection(current => ({ ...current, ...patch })); setStatus(null); }}
            onToggleApiKey={() => setShowApiKey((visible) => !visible)}
            visionBaseUrl={visionBaseUrl} visionModel={visionModel} visionApiKey={visionApiKey}
            visionMode={visionMode} onVisionModeChange={setVisionMode}
            onVisionBaseUrlChange={setVisionBaseUrl} onVisionModelChange={setVisionModel} onVisionApiKeyChange={setVisionApiKey}
          />}
          {activeSection === "knowledge" && (processing?<KnowledgeProcessing value={processing} onChange={setProcessing} conversationPersona={stylePrompt} defaultConversationPersona={settings?.default_style_prompt??''} onConversationPersonaChange={setStylePrompt} onRestoreConversationPersona={()=>{setStylePrompt(settings?.default_style_prompt??'');setStatus('已恢复默认人设，保存后生效');}}/>:<p role="status">知识处理设置尚未加载。<button onClick={()=>void fetchUnoPreferences().then(v=>{setProcessing(v);setSavedProcessing(v);}).catch(e=>setStatus(String(e)))}>重新加载</button></p>)}
          {activeSection === "expression" && <div className="settings-page">
            <SettingsGroup title="关联知识库" description={knowledge ? `项目「${knowledge.project_name}」的对话与思考将从勾选的知识库收集资料，保存后下一轮生效。` : '选择当前项目使用的知识库，可同时关联多个。'}>
              {!projectId ? <p className="settings-knowledge-hint">项目尚未就绪，请关闭设置后重试。</p> : knowledgeError ? <div className="settings-knowledge-hint" role="alert">{knowledgeError}<button type="button" className="settings-text-button" onClick={() => setKnowledgeRetry(n => n + 1)}>重新加载</button></div> : !knowledge ? <p className="settings-knowledge-hint" role="status">正在读取知识库…</p> : <>
                <div className="settings-knowledge-list" role="group" aria-label="项目关联知识库">
                  {knowledge.instances.map(instance => <label key={instance.id} className={`settings-knowledge-option${knowledgeIds.includes(instance.id) ? ' is-selected' : ''}`}>
                    <input type="checkbox" checked={knowledgeIds.includes(instance.id)} onChange={event => setKnowledgeIds(ids => event.target.checked ? [...ids, instance.id] : ids.filter(id => id !== instance.id))} />
                    <span><strong>{instance.name}</strong><small>{instance.card_count} 张卡片{instance.active ? ' · 当前知识库' : ''}</small></span>
                  </label>)}
                  {knowledgeIds.filter(id => !knowledge.instances.some(i => i.id === id)).map(id => <label key={id} className="settings-knowledge-option"><input type="checkbox" checked onChange={() => setKnowledgeIds(ids => ids.filter(value => value !== id))} /><span><strong>已不可用的知识库</strong><small>{id} · 取消勾选后保存</small></span></label>)}
                </div>
                <p className="settings-knowledge-hint">{knowledgeIds.length ? `已选择 ${knowledgeIds.length} 个知识库` : '未关联知识库：回答将不检索库内资料。'}。关联用于读取资料，编译仍写入当前知识库。</p>
              </>}
            </SettingsGroup>
            <ExpressionSettings
            value={stylePrompt} defaultValue={settings?.default_style_prompt ?? ""} onChange={setStylePrompt}
            onRestore={() => { setStylePrompt(settings?.default_style_prompt ?? ""); setStatus("已恢复默认模板，保存后生效"); }}
          /></div>}
        </fieldset>

        <footer className="settings-footer">
          <div className={`settings-footer__status${status?.startsWith("保存失败") || status?.startsWith("加载失败") ? " is-error" : ""}`} aria-live="polite">
            {status ?? (!settings ? "正在读取设置…" : connectionError || (isDirty ? "有尚未保存的更改" : "所有更改均已保存"))}
          </div>
          <div className="settings-footer__actions">
            <button className="settings-button settings-button--secondary" type="button" onClick={onClose}>取消</button>
            <button className="settings-button settings-button--primary" type="button"
              disabled={!settings || settings.model_settings_version !== 2 || saving || !isDirty || Boolean(connectionError)} onClick={() => void save()}>
              {saving ? "正在保存…" : "保存更改"}
            </button>
          </div>
        </footer>
      </div>
    </section>
  </div>;
}

function GeneralSettings({ username, onUsernameChange, loading }: { username: string; onUsernameChange: (value: string) => void; loading: boolean }) {
  return <div className="settings-page">
    <AppearancePicker />
    <SettingsGroup title="个人信息" description="用于页面中的称呼与本地会话标识。">
      <SettingsField label="显示名称" hint="只影响当前 Nexo 知识库中的显示，不会上传为公开资料。">
        <input value={username} maxLength={40} disabled={loading} onChange={(event) => onUsernameChange(event.target.value)} />
      </SettingsField>
    </SettingsGroup>
    <SettingsGroup title="保存范围" description="Nexo 的知识内容与程序设置分开保存。">
      <InfoRow title="当前知识库" value="本地" description="模型连接、处理偏好和表达风格保存在当前应用的本地设置中。" />
      <InfoRow title="知识事实来源" value="Markdown" description="卡片与 Buffer 仍以知识库中的 Markdown 为语义事实来源。" />
    </SettingsGroup>
  </div>;
}


function ExpressionSettings(props: { value: string; defaultValue: string; onChange: (value: string) => void; onRestore: () => void }) {
  return <div className="settings-page">
    <SettingsGroup title="回答风格" description="这里适合写稳定、可复用的表达偏好；具体任务要求仍应直接在对话中说明。"
      action={<button className="settings-text-button" type="button" disabled={props.value === props.defaultValue} onClick={props.onRestore}>恢复默认</button>}>
      <textarea className="settings-prompt-editor" aria-label="思维体表达风格提示词" value={props.value}
        onChange={(event) => props.onChange(event.target.value)} placeholder="例如：结论先行；区分事实、推断与建议；引用相关知识卡片。" spellCheck={false} />
      <div className="settings-editor-meta"><span>保存后从下一轮对话开始生效</span><span>{props.value.length} 字</span></div>
    </SettingsGroup>
  </div>;
}

function SettingsGroup({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return <section className="settings-group"><header><div><h3>{title}</h3><p>{description}</p></div>{action}</header><div className="settings-group__body">{children}</div></section>;
}

function SettingsField({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <label className="settings-field"><span className="settings-field__label">{label}</span>{children}<span className="settings-field__hint">{hint}</span></label>;
}

function InfoRow({ title, value, description }: { title: string; value: string; description: string }) {
  return <div className="settings-info-row"><div><strong>{title}</strong><p>{description}</p></div><span>{value}</span></div>;
}

function SettingsIcon({ kind }: { kind: SettingsSection }) {
  if (kind === "general") return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" /><path d="m19 13.4 1.2 1-.9 2.2-1.6-.1a7.5 7.5 0 0 1-1.2 1.2l.1 1.6-2.2.9-1-1.2a7 7 0 0 1-1.7 0l-1 1.2-2.2-.9.1-1.6a7.5 7.5 0 0 1-1.2-1.2l-1.6.1-.9-2.2 1.2-1a7 7 0 0 1 0-1.7l-1.2-1 .9-2.2 1.6.1a7.5 7.5 0 0 1 1.2-1.2l-.1-1.6 2.2-.9 1 1.2a7 7 0 0 1 1.7 0l1-1.2 2.2.9-.1 1.6a7.5 7.5 0 0 1 1.2 1.2l1.6-.1.9 2.2-1.2 1a7 7 0 0 1 0 1.7Z" /></svg>;
  if (kind === "model") return <svg viewBox="0 0 24 24" aria-hidden><path d="m9.2 14.8-1.4 1.4a3.3 3.3 0 0 1-4.7-4.7l3-3a3.3 3.3 0 0 1 4.7 0" /><path d="m14.8 9.2 1.4-1.4a3.3 3.3 0 0 1 4.7 4.7l-3 3a3.3 3.3 0 0 1-4.7 0" /><path d="m8.7 15.3 6.6-6.6" /></svg>;
  if (kind === "knowledge") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="6" cy="12" r="2.2" /><circle cx="17.5" cy="6" r="2.2" /><circle cx="17.5" cy="18" r="2.2" /><path d="m8 11 7.5-4M8 13l7.5 4" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden><path d="M5 5.5h14v10H9l-4 3v-13Z" /><path d="M9 9h6M9 12h4" /></svg>;
}

function ShieldIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3.5 19 6v5.3c0 4.2-2.8 7.5-7 9.2-4.2-1.7-7-5-7-9.2V6l7-2.5Z" /><path d="m9.4 12 1.7 1.7 3.6-3.8" /></svg>;
}

function CloseIcon() { return <svg viewBox="0 0 24 24" aria-hidden><path d="m7 7 10 10M17 7 7 17" /></svg>; }
