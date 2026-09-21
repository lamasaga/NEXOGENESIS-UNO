/**
 * RPC bridge for the /api compatibility layer.
 *
 * The compatibility layer's prefix routes (registered by this plugin) shadow
 * the stock `/api` RPC gateway via longest-prefix matching. Business handlers
 * therefore cannot rely on the gateway's own browser-trust fence — each
 * handler must apply {@link assertTrustedRequest} itself. Once trusted, a
 * handler calls the native gateway's public fetch carrier in process when
 * apiProxy is mounted. Embedded/older hosts without that service retain the
 * loopback HTTP path. Both paths use the native wire schemas and business
 * handlers; no direct session-method dispatch or automatic retry is allowed.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHostname } from "./fence.js";

export const CSRF_HEADER = "x-nexogenesis-csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** One compatibility-layer request error, carrying the gateway's error body. */
export class RpcCallError extends Error {
	constructor(method, error) {
		super(`rpc ${method}: ${error?.message ?? "unknown error"}`);
		this.name = "RpcCallError";
		this.method = method;
		this.code = error?.code ?? "internal";
		this.details = error?.details ?? {};
	}
}

/**
 * Enforce the browser-trust fence for one compatibility-layer request. The
 * stock gateway requires loopback (or declared trusted) Host; our shadow
 * routes bypass it, so we reproduce the check at the same boundary.
 * @param req - the incoming node:http request.
 * @param trustedHosts - authorities accepted beyond loopback.
 * @returns the parsed authority when trusted; throws 403 otherwise.
 */
export function assertTrustedRequest(req, trustedHosts = [], { csrfToken } = {}) {
	const host = req.headers.host;
	let authority;
	try {
		authority = new URL(`http://${host}`);
	} catch {
		authority = void 0;
	}
	const hostname = authority?.hostname;
	if (hostname === void 0) throw new HttpError(403, "forbidden");
	const hostLower=host?.toLowerCase(),hostnameLower=hostname.toLowerCase();
	const trustedHost = isLoopbackHostname(hostname)
		|| trustedHosts.some((entry) => {
			const candidate=entry.toLowerCase();
			return candidate===hostLower||(!candidate.includes(':')&&candidate===hostnameLower);
		});
	if (!trustedHost) throw new HttpError(403, "forbidden");

	const origin = singleHeader(req.headers.origin);
	const referer = singleHeader(req.headers.referer);
	const fetchSite = singleHeader(req.headers["sec-fetch-site"])?.toLowerCase();
	if (fetchSite === "cross-site") throw new HttpError(403, "cross-site request rejected");
	if (origin !== void 0) assertSameAuthority(origin, host, "origin");
	else if (referer !== void 0) assertSameAuthority(referer, host, "referer");

	const method = String(req.method ?? "GET").toUpperCase();
	if (!SAFE_METHODS.has(method) && csrfToken !== void 0) {
		const supplied = singleHeader(req.headers[CSRF_HEADER]);
		if (!safeTokenEqual(supplied, csrfToken)) throw Object.assign(new HttpError(403, "missing or invalid local request token"), {code:'LOCAL_TOKEN_INVALID'});
		const contentType = singleHeader(req.headers["content-type"]);
		const pathname = new URL(req.url ?? "/", "http://local").pathname;
		const expected = pathname === "/api/inbox" ? /^multipart\/form-data(?:\s*;|$)/i
			: pathname === "/api/speech/transcribe" ? /^audio\/wav(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i;
		if (contentType === void 0 || !expected.test(contentType)) {
			throw new HttpError(415, pathname === "/api/inbox" ? "需要 multipart/form-data"
				: pathname === "/api/speech/transcribe" ? "需要 audio/wav 录音" : "需要 application/json 请求体");
		}
	}
}

function singleHeader(value) {
	if (typeof value === "string" && value !== "") return value;
	if (Array.isArray(value) && value.length === 1 && value[0] !== "") return value[0];
	return void 0;
}

function assertSameAuthority(value, host, label) {
	let parsed;
	try { parsed = new URL(value); } catch { throw new HttpError(403, `invalid ${label}`); }
	if (!["http:", "https:"].includes(parsed.protocol) || parsed.host.toLowerCase() !== String(host).toLowerCase()) {
		throw new HttpError(403, `cross-origin ${label} rejected`);
	}
}

function safeTokenEqual(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Minimal HTTP error carrying a status code for route handlers. */
export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

/**
 * Call one RPC method through the native fetch carrier, with HTTP compatibility.
 * A failed create/prompt can already have taken effect; never retry or switch
 * transports after dispatch. Browser trust checks remain at the route boundary.
 * @param ctx - plugin context (apiProxy, or webServer for HTTP compatibility).
 * @param method - wire method name, e.g. "session.create".
 * @param payload - business payload.
 * @returns the business value (result.ok branch).
 */
export async function rpcCall(ctx, method, payload) {
	const available = typeof ctx.get === "function" ? ctx.get("apiProxy") : ctx.apiProxy;
	// Embedded hosts may provide only events/respond. Such a partial surface
	// cannot serve session RPCs and must retain the existing HTTP carrier.
	const api = typeof available?.sessions?.list === "function" ? available : null;
	const transport = api ? "in-process" : "http";
	let res;
	try {
		const carrier = api ? await nativeCarrier(ctx, api) : null;
		// The local carrier only uses the path; it never opens this URL.
		const url = `${api ? "http://localhost" : `http://127.0.0.1:${ctx.webServer.port}`}/api/${method}`;
		const init = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "client-request",
				rpcId: randomUUID(),
				method,
				payload: payload ?? {}
			})
		};
		res = carrier ? await carrier.fetch(url, init) : await fetch(url, init);
	} catch (error) {
		throw transportFailure(method, transport, error);
	}
	let body;
	try { body = await res.json(); }
	catch (error) {
		if (error instanceof SyntaxError) body = null;
		else throw transportFailure(method, transport, error);
	}
	if (body === null || body.type !== "server-response") {
		throw new RpcCallError(method, { code: "internal", message: `${transport} gateway replied ${res.status}`, details: { method, transport, status: res.status } });
	}
	if (!body.result?.ok) throw new RpcCallError(method, body.result?.error);
	return body.result.value;
}

const nativeCarriers = new WeakMap();

function transportFailure(method, transport, error) {
	const transportCode = safeTransportCode(error);
	return new RpcCallError(method, {
		code: "transport",
		message: `${transport} transport failed (${transportCode})`,
		details: { method, transport, transport_code: transportCode }
	});
}

/** Resolve against the running host, never a second bundled DSH dependency. */
async function nativeCarrier(ctx, api) {
	let pending = nativeCarriers.get(api);
	if (!pending) {
		pending = (async () => {
			const name = "@deepseek-ai/dsh-host-apiproxy";
			const loader = ctx.get?.("loader");
			const entry = loader && [...loader.entries()].find(item => item.options.name === name && !item.options.disabled);
			let native;
			if (entry) native = await entry.parent.tree.import(name);
			else {
				if (!process.argv[1]) throw Object.assign(new Error("native host entrypoint missing"), { code: "UNO_RPC_CARRIER_UNAVAILABLE" });
				const requireHost = createRequire(resolve(process.argv[1]));
				native = await import(pathToFileURL(requireHost.resolve(name)).href);
			}
			if (typeof native.toFetchHandler !== "function") throw Object.assign(new Error("native fetch carrier missing"), { code: "UNO_RPC_CARRIER_UNAVAILABLE" });
			return native.toFetchHandler(api);
		})();
		nativeCarriers.set(api, pending);
	}
	try { return await pending; }
	catch (error) { nativeCarriers.delete(api); throw error; }
}

/** Report only safe machine codes. Raw causes may contain credentials or URLs. */
function safeTransportCode(error) {
	const seen = new Set();
	const pending = [error];
	while (pending.length && seen.size < 8) {
		const item = pending.shift();
		if (!item || typeof item !== "object" || seen.has(item)) continue;
		seen.add(item);
		if (typeof item.code === "string" && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(item.code)) return item.code;
		if (item.cause) pending.push(item.cause);
		if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
	}
	return "RPC_TRANSPORT_ERROR";
}

/** Read a JSON request body with a sane cap (1 MiB for M1 endpoints). */
export async function readJsonBody(req, maxBytes = 1024 * 1024) {
	const contentType = singleHeader(req.headers["content-type"]);
	if (contentType === void 0 || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
		throw new HttpError(415, "需要 application/json 请求体");
	}
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		received += chunk.length;
		if (received > maxBytes) throw new HttpError(413, "request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid json body");
	}
}

/** Write a JSON response. */
export function json(res, status, value) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

/** Write an SSE frame. */
export function sse(res, value) {
	if(res.destroyed || res.writableEnded)return;
	res.write(`data: ${JSON.stringify(value)}\n\n`);
}
