import { describe, expect, it, vi } from "vitest";
import { ownedStreamHandlers, ownsConversation } from "./ownership";

describe("conversation window ownership", () => {
  it("rejects A → B → A results from an earlier navigation", () => {
    expect(ownsConversation(1, 3, "a", "a")).toBe(false);
    expect(ownsConversation(3, 3, "a", "a")).toBe(true);
    expect(ownsConversation(3, 3, "a", "b")).toBe(false);
  });
  it("guards every stream frame, including errors, choices and write proposals", () => {
    let current = true;
    const callback = vi.fn();
    const callbacks = { onDelta: callback, onDone: callback, onError: callback, onFrameError: callback, onStep: callback, onSources: callback, onConfirmRequest: callback, onCandidateRequest: callback, onChoiceRequest: callback, onPipelineStatus: callback };
    const handlers = ownedStreamHandlers(() => current, callbacks);
    handlers.onDelta("current"); expect(callback).toHaveBeenCalledWith("current");
    current = false;
    for (const handler of Object.values(handlers)) handler("late" as never);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
