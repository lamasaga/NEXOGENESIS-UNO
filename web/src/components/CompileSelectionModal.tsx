import { useEffect, useRef, useState } from "react";
import { fetchInboxDocuments, type InboxDocument } from "../api/client";

interface Props {
  onClose: () => void;
  onConfirm: (sources: string[]) => void;
  mode?: "compile" | "theme_compile";
}

const TYPE_LABELS: Record<InboxDocument["doc_type"], string> = {
  text: "文本",
  pdf: "PDF",
  epub: "EPUB",
  other: "其他格式",
};

const TYPE_MARKS: Record<InboxDocument["doc_type"], string> = {
  text: "T",
  pdf: "P",
  epub: "E",
  other: "·",
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function CompileSelectionModal({ onClose, onConfirm, mode = "compile" }: Props) {
  const [documents, setDocuments] = useState<InboxDocument[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    fetchInboxDocuments()
      .then(({ documents: loaded }) => {
        if (cancelled) return;
        setDocuments(loaded);
        if (loaded.length === 1) setSelected([loaded[0].path]);
      })
      .catch((reason) => {
        if (!cancelled) setError(`Inbox 读取失败：${reason}`);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className="flex max-h-[82vh] w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-white/[0.1] bg-zinc-950 shadow-2xl shadow-black/60"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compile-selection-title"
      >
        <header className="flex items-start justify-between gap-5 px-6 pb-4 pt-5">
          <div>
            <span className="text-[11px] font-semibold tracking-[0.16em] text-sky-300/80">{mode === "theme_compile" ? "THEME COMPILE" : "COMPILE"} · INBOX</span>
            <h2 id="compile-selection-title" className="mt-1.5 text-[18px] font-semibold text-zinc-100">{mode === "theme_compile" ? "选择同一主题的一组图书" : "这次编译哪份材料？"}</h2>
            <p className="mt-1.5 text-[13px] leading-5 text-zinc-400">{mode === "theme_compile" ? "选择 2–30 份相关材料；Agent 会建立章节来源层，再跨书聚合知识卡。" : "本次只处理你选中的一份材料，其他文件继续留在 Inbox。"}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="rounded-md px-2 py-1 text-[14px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400/60"
            aria-label="关闭材料选择"
            onClick={onClose}
          >✕</button>
        </header>

        <div className="min-h-48 overflow-y-auto border-y border-white/[0.07] px-6 py-4">
          {documents === null && !error && (
            <div className="grid min-h-40 place-items-center text-[13px] text-zinc-500">正在读取 Inbox…</div>
          )}
          {error && (
            <div className="grid min-h-40 place-items-center text-center text-[13px] leading-6 text-amber-200">{error}</div>
          )}
          {documents?.length === 0 && !error && (
            <div className="grid min-h-40 place-content-center gap-2 text-center">
              <strong className="text-[14px] font-medium text-zinc-200">Inbox 里还没有材料</strong>
              <span className="text-[12px] leading-5 text-zinc-500">请先使用左侧“Add 材料”放入需要编译的文档。</span>
            </div>
          )}
          {documents && documents.length > 0 && (
            <div className="space-y-2" role={mode === "theme_compile" ? "group" : "radiogroup"} aria-label="可编译材料">
              <div className="pb-1 text-[11px] text-zinc-500">Inbox 中有 {documents.length} 份材料</div>
              {documents.map((document) => {
                const checked = selected.includes(document.path);
                return (
                  <button
                    key={document.path}
                    type="button"
                    role={mode === "theme_compile" ? "checkbox" : "radio"}
                    aria-checked={checked}
                    onClick={() => setSelected((current) => mode === "theme_compile"
                      ? current.includes(document.path) ? current.filter((path) => path !== document.path) : current.length < 30 ? [...current, document.path] : current
                      : [document.path])}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-[border-color,background-color,transform] active:scale-[0.995] ${checked ? "border-sky-300/45 bg-sky-300/[0.09]" : "border-white/[0.07] bg-zinc-900/70 hover:border-white/[0.14] hover:bg-zinc-900"}`}
                  >
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border text-[12px] font-semibold ${checked ? "border-sky-300/25 bg-sky-300/10 text-sky-200" : "border-white/[0.08] bg-white/[0.025] text-zinc-500"}`} aria-hidden>
                      {TYPE_MARKS[document.doc_type]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-[13px] font-medium text-zinc-200" title={document.path}>{document.path}</strong>
                      <small className="mt-1 block text-[11px] text-zinc-500">{TYPE_LABELS[document.doc_type]} · {formatSize(document.size)}</small>
                    </span>
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold ${checked ? "border-sky-300 bg-sky-300 text-slate-950" : "border-white/[0.16] text-transparent"}`} aria-hidden>✓</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-4 px-6 py-4">
          <span className="text-[11px] text-zinc-500">{selected.length ? `已选择 ${selected.length} 份材料` : mode === "theme_compile" ? "请选择至少两份材料" : "请选择一份材料"}</span>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg border border-white/[0.1] px-4 py-2 text-[12px] text-zinc-400 transition-colors hover:border-white/[0.2] hover:text-zinc-200" onClick={onClose}>取消</button>
            <button
              type="button"
              disabled={(mode === "theme_compile" ? selected.length < 2 : selected.length !== 1) || Boolean(error)}
              className="rounded-lg border border-sky-300/45 bg-sky-700 px-4 py-2 text-[12px] font-medium text-white transition-[background-color,transform,opacity] hover:bg-sky-600 active:scale-[0.98] disabled:cursor-default disabled:opacity-35"
              onClick={() => { if (selected.length) onConfirm(selected); }}
            >{mode === "theme_compile" ? "开始主题编译" : "开始编译"}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
