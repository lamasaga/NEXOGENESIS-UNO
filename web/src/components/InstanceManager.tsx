import { useEffect, useRef, useState } from "react";
import type { KnowledgeInstanceList, KnowledgeInstanceSummary } from "../api/client";

interface Props {
  value: KnowledgeInstanceList;
  busy?: boolean;
  onSwitch: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onRegister: (path: string, name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function InstanceManager({ value, busy = false, onSwitch, onCreate, onRegister, onRename, onRemove }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "register" | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("keydown", escape); };
  }, [open]);

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    setPending(key); setNotice(null);
    try { await action(); setNotice(success); setEditing(null); setRemoving(null); }
    catch (error) { setNotice(errorText(error)); }
    finally { setPending(null); }
  };

  const resetForm = () => { setMode(null); setName(""); setPath(""); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || (mode === "register" && !path.trim())) return;
    const submittedName = name.trim();
    await run(mode === "create" ? "create" : "register", async () => {
      if (mode === "create") await onCreate(submittedName);
      else await onRegister(path.trim(), submittedName);
      resetForm();
    }, mode === "create" ? `已创建“${submittedName}”。` : `已登记“${submittedName}”。`);
  };

  return <div className="instance-manager" ref={root}>
    <button type="button" className="instance-manager__trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}>管理实例</button>
    {!open ? null : <section className="instance-manager__popover" role="dialog" aria-label="知识图谱实例管理">
      <header><div><strong>知识图谱实例</strong><p>每个实例保留独立的卡片、图谱、任务与对话。</p></div><button type="button" onClick={() => setOpen(false)}>关闭</button></header>
      {mode ? <form className="instance-manager__form" onSubmit={(event) => void submit(event)}>
        <label>{mode === "create" ? "实例名称" : "显示名称"}<input value={name} maxLength={80} placeholder="例如：项目资料库" onChange={(event) => setName(event.target.value)} /></label>
        {mode === "register" ? <label>已有实例目录<input value={path} placeholder="D:\\Knowledge\\project-notes" onChange={(event) => setPath(event.target.value)} /></label> : <small>将在本应用的 instances 目录创建一套空白 Markdown 知识目录。</small>}
        <div><button type="submit" disabled={pending !== null || !name.trim() || (mode === "register" && !path.trim())}>{mode === "create" ? "创建" : "登记"}</button><button type="button" onClick={resetForm}>取消</button></div>
      </form> : <div className="instance-manager__toolbar"><button type="button" onClick={() => { setMode("create"); setNotice(null); }}>新建实例</button><button type="button" onClick={() => { setMode("register"); setNotice(null); }}>登记已有目录</button></div>}
      <div className="instance-manager__list">{value.instances.map((instance) => <InstanceRow key={instance.id} instance={instance} busy={busy || pending !== null} editing={editing === instance.id} removing={removing === instance.id} onEdit={() => { setEditing(instance.id); setRemoving(null); setName(instance.name); }} onCancel={() => { setEditing(null); setRemoving(null); }} onSwitch={() => void run(instance.id, () => onSwitch(instance.id), `已切换到“${instance.name}”。`)} onRename={() => void run(instance.id, () => onRename(instance.id, name.trim()), "名称已更新。")} onStartRemove={() => { setRemoving(instance.id); setEditing(null); }} onRemove={() => void run(instance.id, () => onRemove(instance.id), "已移出本机登记，目录内容保持不变。")} name={name} setName={setName} />)}</div>
      {notice ? <p className="instance-manager__notice" role="status">{notice}</p> : null}
    </section>}
  </div>;
}

function InstanceRow({ instance, busy, editing, removing, onEdit, onCancel, onSwitch, onRename, onStartRemove, onRemove, name, setName }: {
	instance: KnowledgeInstanceSummary; busy: boolean; editing: boolean; removing: boolean; onEdit: () => void; onCancel: () => void;
	onSwitch: () => void; onRename: () => void; onStartRemove: () => void; onRemove: () => void; name: string; setName: (value: string) => void;
}) {
  return <article className={`instance-manager__item${instance.active ? " is-active" : ""}`}>
    <div><strong>{instance.name}</strong>{instance.active ? <span>当前</span> : null}<small>{instance.card_count} 张卡片 · {instance.legacy ? "兼容目录" : "独立实例"}</small></div>
    {editing ? <div className="instance-manager__edit"><input aria-label="实例名称" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /><button type="button" disabled={busy || !name.trim()} onClick={onRename}>保存</button><button type="button" onClick={onCancel}>取消</button></div> : removing ? <div className="instance-manager__remove"><small>只移出本应用登记，磁盘中的知识目录不会删除。</small><button type="button" disabled={busy} onClick={onRemove}>确认移出</button><button type="button" onClick={onCancel}>取消</button></div> : <div className="instance-manager__actions">{!instance.active ? <button type="button" disabled={busy} onClick={onSwitch}>切换</button> : null}<button type="button" disabled={busy} onClick={onEdit}>改名</button>{!instance.active ? <button type="button" disabled={busy} onClick={onStartRemove}>移出</button> : null}</div>}
  </article>;
}
