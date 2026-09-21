import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_FORCES } from "./forceSettings";
import { GraphControls } from "./GraphControls";

describe("GraphControls", () => {
  it("offers pure graph mode directly below the force controls", () => {
    const html = renderToString(<GraphControls forces={DEFAULT_FORCES} onChange={() => undefined}
      onReset={() => undefined} status="ready" onRetry={() => undefined}
      focusMode={false} onFocusModeChange={() => undefined} />);

    expect(html).toContain('aria-label="图谱调节"');
    expect(html).toContain('>领域聚合</label>');
    expect(html).toContain('aria-label="进入纯享模式"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("keeps an explicit exit control visible while pure graph mode is active", () => {
    const html = renderToString(<GraphControls forces={DEFAULT_FORCES} onChange={() => undefined}
      onReset={() => undefined} status="ready" onRetry={() => undefined}
      focusMode onFocusModeChange={() => undefined} />);

    expect(html).toContain('aria-label="退出纯享模式"');
    expect(html).toContain('aria-pressed="true"');
  });
});
