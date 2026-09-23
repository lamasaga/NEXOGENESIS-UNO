import { useState } from "react";
import { setAppearance, useAppearance, type Appearance } from "../../appearance";
import "./appearance.css";

const OPTIONS: { value: Appearance; label: string; detail: string }[] = [
  { value: "dark-blue", label: "暗蓝", detail: "沉静的深色界面" },
  { value: "warm-white", label: "暖白", detail: "柔和的纸感底色" },
];

export function AppearancePicker() {
  const appearance = useAppearance();
  const [saved, setSaved] = useState(true);
  return <section className="settings-group">
    <header><div><h3 id="appearance-title">界面配色</h3><p>点选即生效，自动记住此浏览器的选择。</p></div></header>
    <div className="appearance-options" role="radiogroup" aria-labelledby="appearance-title">
      {OPTIONS.map(option => <label key={option.value} className="appearance-option" data-preview={option.value}>
        <input type="radio" name="appearance" value={option.value} checked={appearance === option.value}
          onChange={() => setSaved(setAppearance(option.value))} />
        <span className="appearance-preview" aria-hidden="true"><i /><span><b /><b /><em /></span></span>
        <span className="appearance-option__copy"><strong>{option.label}</strong><small>{option.detail}</small></span>
        <span className="appearance-option__check" aria-hidden="true">{appearance === option.value ? "✓" : ""}</span>
      </label>)}
    </div>
    {!saved && <p className="appearance-notice" role="status">配色已切换；浏览器存储不可用，刷新后可能恢复默认。</p>}
  </section>;
}
