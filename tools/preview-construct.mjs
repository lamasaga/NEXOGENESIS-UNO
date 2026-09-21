/** Read-only UI QA: node tools/preview-construct.mjs (never forwards mutations). */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { prepareConstruct } from "../packages/nexogenesis-web-host/lib/construct.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "web/dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:3085");
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "只读预览：不会启动真实任务或修改知识。" })); return;
    }
    if (url.pathname === "/api/pipeline/construct/prepare") {
      const settings = await fetch("http://127.0.0.1:3093/api/settings").then(r => r.json());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(prepareConstruct(root, settings.pipeline_authority))); return;
    }
    if (url.pathname.startsWith("/api/")) {
      // Event feeds are intentionally inert; all other requests remain read-only.
      if (url.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(); return; }
      const upstream = await fetch(`http://127.0.0.1:3093${url.pathname}${url.search}`);
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer())); return;
    }
    const path = resolve(dist, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!path.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(body);
  } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ detail: error.message })); }
}).listen(3085, "127.0.0.1", () => console.log("Read-only construct UI preview: http://127.0.0.1:3085"));
