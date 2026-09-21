import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const QUICK_MESSAGE_EVENT = "nexo/quick-message";

/**
 * DSH rc.6 accepts plugin events on append, but rejects them on cold restore.
 * Until it exposes a plugin event registry, declare only UNO's understood
 * transcript event in the host's exported catalog. Never rewrite old logs or
 * allow arbitrary unknown events. Keep the declaration for the process lifetime:
 * other native readers may still need it after this web plugin is unloaded.
 */
export async function registerUnoSessionEvents(ctx, entrypoint = process.argv[1]) {
  const loader = ctx.get("loader");
  const entry = loader && [...loader.entries()].find(e => e.options.name === "@deepseek-ai/dsh-session" && !e.options.disabled);
  // Reuse the native plugin's own import context. Bare embedded/test hosts can
  // resolve from their entrypoint; never resolve from this plugin's dependencies.
  let native;
  if (entry) native = await entry.parent.tree.import(entry.options.name);
  else {
    if (!entrypoint) throw new Error("UNO session compatibility requires the native host entrypoint");
    const requireHost = createRequire(resolve(entrypoint));
    native = await import(pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-session")).href);
  }
  if (!(native.KNOWN_SESSION_EVENT_TYPES instanceof Set)
      || typeof native.SessionStore !== "function"
      || !(ctx.get("sessions") instanceof native.SessionStore)) {
    throw new Error("UNO session compatibility does not match the running native session store");
  }
  native.KNOWN_SESSION_EVENT_TYPES.add(QUICK_MESSAGE_EVENT);
}
