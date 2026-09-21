import { CornersIn, CornersOut } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { isDefaultForces, type GraphForces } from "./forceSettings";
import "./graphControls.css";

interface Props {
  forces: GraphForces;
  onChange: (key: keyof GraphForces, value: number) => void;
  onReset: () => void;
  status: "ready" | "adjusting" | "error";
  onRetry: () => void;
  focusMode: boolean;
  onFocusModeChange: (active: boolean) => void;
}

const FORCE_CONTROLS: ReadonlyArray<{ key: keyof GraphForces; label: string }> = [
  { key: "gravity", label: "集中引力" },
  { key: "repulsion", label: "节点斥力" },
  { key: "linkAttraction", label: "连线吸引力" },
  { key: "domainCohesion", label: "领域聚合" },
];

export function GraphControls({ forces, onChange, onReset, status, onRetry, focusMode, onFocusModeChange }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const focusModeLabel = focusMode ? "退出纯享模式" : "进入纯享模式";
  return (
    <div className="graph-control-stack">
      <section className={"graph-controls" + (open ? " is-open" : "")} aria-label="图谱调节">
        <div className="graph-controls__toolbar">
          <button type="button" className="graph-controls__toggle"
            aria-label={open ? "收起图谱调节" : "展开图谱调节"}
            title={open ? "收起图谱调节" : "展开图谱调节"}
            aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M3 6h5m4 0h9M3 12h11m4 0h3M3 18h3m4 0h11" />
              <circle cx="10" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="8" cy="18" r="2" />
            </svg>
          </button>
          {open && <div className="graph-controls__actions">
            {status === "error" && <button type="button" onClick={onRetry} title="调整未完成，重试" aria-label="重试图谱调整">↻</button>}
            <button type="button" disabled={isDefaultForces(forces)} onClick={onReset} title="恢复默认" aria-label="恢复默认">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M4 9a8 8 0 1 1 0 6M4 3v6h6" />
              </svg>
            </button>
          </div>}
        </div>
        <div id={id} className="graph-controls__body" hidden={!open}>
          {FORCE_CONTROLS.map(({ key, label }) => (
            <div className="graph-controls__control" key={key}>
              <div className="graph-controls__heading">
                <label htmlFor={id + key}>{label}</label>
                <output htmlFor={id + key}>{forces[key].toFixed(1)}</output>
              </div>
              <input id={id + key} type="range" min={0} max={4} step={0.1}
                value={forces[key]}
                aria-valuetext={forces[key].toFixed(1)}
                onChange={event => onChange(key, Number(event.target.value))} />
            </div>
          ))}
        </div>
        <span className="graph-controls__status" role="status">{status === "adjusting" ? "正在调整" : status === "error" ? "调整未完成，可重试" : ""}</span>
      </section>
      <button type="button" className="graph-focus-toggle"
        aria-label={focusModeLabel}
        title={focusModeLabel}
        aria-pressed={focusMode}
        onClick={() => onFocusModeChange(!focusMode)}>
        {focusMode ? <CornersIn size={18} weight="regular" aria-hidden /> : <CornersOut size={18} weight="regular" aria-hidden />}
      </button>
    </div>
  );
}
