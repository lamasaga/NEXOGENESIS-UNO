import type { ChatStreamHandlers } from "../api/client";

/** Ignore every late stream frame after the user leaves its navigation generation. */
export function ownedStreamHandlers(isCurrent: () => boolean, handlers: ChatStreamHandlers): ChatStreamHandlers {
  return Object.fromEntries(Object.entries(handlers).map(([key, handler]) => [
    key, (...args: unknown[]) => { if (isCurrent()) (handler as (...values: unknown[]) => void)(...args); },
  ])) as unknown as ChatStreamHandlers;
}

export function ownsConversation(version: number, currentVersion: number, id: string | null, currentId: string | null) {
  return version === currentVersion && id === currentId;
}
