import { useSyncExternalStore } from "react";

export type Appearance = "dark-blue" | "warm-white";
export const APPEARANCE_KEY = "uno:appearance:v1";
const CHANGE_EVENT = "uno-appearance-change";

export function getAppearance(): Appearance {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "warm-white"
    ? "warm-white" : "dark-blue";
}

export function subscribeAppearance(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

function applyAppearance(value: Appearance): void {
  document.documentElement.dataset.theme = value;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setAppearance(value: Appearance): boolean {
  applyAppearance(value);
  try { localStorage.setItem(APPEARANCE_KEY, value); return true; }
  catch { return false; }
}

export function initializeAppearance(): void {
  window.addEventListener("storage", event => {
    if (event.storageArea === localStorage && (event.key === APPEARANCE_KEY || event.key === null)) {
      applyAppearance(event.newValue === "warm-white" ? "warm-white" : "dark-blue");
    }
  });
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, getAppearance, () => "dark-blue");
}
