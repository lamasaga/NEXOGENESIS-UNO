/** Isolated UI QA: settings/credentials live only in memory; real mutations are never forwarded. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { handleSettingsGet, handleSettingsPut } from "../packages/nexogenesis-web-host/lib/settings.js";

const dist = fileURLToPath(new URL("../web/dist/", import.meta.url)).replace(/[\\/]$/, "");
const namespaces = { nexogenesis: { provider: "deepseek", model: "deepseek-v4-flash" }, "llm-pi-ai": {} };
const keys = new Map();
const ctx = {
  settings: { get: name => namespaces[name], update: async (name, patch) => { namespaces[name] = { ...namespaces[name], ...patch }; } },
  credentials: { describe: async name => ({ configured: keys.has(name) }), set: async (name, key) => { keys.set(name, key); } },
};
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:3091");
    if (url.pathname === "/api/settings" && req.method === "GET") return await handleSettingsGet(ctx, req, res);
    if (url.pathname === "/api/settings" && req.method === "PUT") return await handleSettingsPut(ctx, req, res);
    if (req.method !== "GET") { res.writeHead(405); res.end('{"detail":"隔离预览禁止启动任务或修改知识。"}'); return; }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": preview\n\n"); return; }
      const upstream = await fetch(`http://127.0.0.1:3093${url.pathname}${url.search}`);
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer())); return;
    }
    const path = resolve(dist, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!path.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(body);
  } catch (error) { res.writeHead(error.status ?? 500, { "content-type": "application/json" }); res.end(JSON.stringify({ detail: error.message })); }
}).listen(3091, "127.0.0.1", () => console.log("In-memory model settings QA: http://127.0.0.1:3091 (never enter real keys)"));
