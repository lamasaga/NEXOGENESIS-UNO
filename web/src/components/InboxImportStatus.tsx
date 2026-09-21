import type { InboxUploadProgress } from "../api/client";
import "./inboxImportStatus.css";

export function InboxImportStatus({progress, busy, libraryName, onRetry, onClose, onStop}: {
  progress: InboxUploadProgress; busy: boolean; libraryName: string; onRetry: () => void; onClose: () => void; onStop?:()=>void;
}) {
  return <section className="inbox-import-status" aria-label="材料导入进度" aria-busy={busy}>
    <header><div><strong>{busy ? "正在导入材料" : progress.failed.length ? "部分材料需要核对或重试" : "材料已就绪"}</strong><small>{libraryName} · 原始材料</small></div>
      {!busy && <button type="button" onClick={onClose} aria-label="关闭导入结果">×</button>}
      {busy&&onStop&&<button type="button" onClick={onStop}>停止剩余导入</button>}
    </header>
    <div role="status" aria-live="polite"><p>已核对 {progress.completed} / {progress.total} 个文件</p>
      <progress max={progress.total || 1} value={progress.completed} aria-label="文件导入完成数量" />
      <div className="inbox-import-counts"><span>新导入 <b>{progress.saved}</b></span><span>相同内容已存在 <b>{progress.existing}</b></span><span>待处理 <b>{progress.failed.length}</b></span></div>
    </div>
    {progress.failed.length > 0 && <details><summary>查看失败、待核对或尚未发送的文件（{progress.failed.length}）</summary><ul>{progress.failed.map(({file, detail}, index) => <li key={index}><strong>{file.name}</strong><span>{detail}</span></li>)}</ul></details>}
    <footer>{busy ? <small>正在分批保存，请保持页面打开。每批最多 24 个文件；大文件会单独上传，单文件最多 256 MiB。</small> : <><small>导入只保存原文；回执丢失不代表未保存。重试时会核对同名内容。</small>{progress.failed.length > 0 && <button type="button" onClick={onRetry}>核对并重试待处理文件</button>}</>}</footer>
  </section>;
}
