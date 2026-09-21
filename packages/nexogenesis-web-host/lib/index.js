/**
 * nexogenesis-web-host — the fusion layer between the Nexogenesis web surface
 * and the DeepSeek Harness (DSH) host.
 *
 * Roles (see docs/history/pre-uno/2026-08-30-项目定位、愿景与总体架构.md):
 *  1. Provide the `webRuntime` service ({ lanAddresses, trustedHosts }) — the
 *     stock `connection` row injects it, so without it the /api RPC gateway
 *     never mounts.
 *  2. Mount @deepseek-ai/dsh-host-frontend-static over the webserver fallback
 *     seat, serving the Nexogenesis dist (path is deployment config).
 *  3. Register the /api compatibility layer routes (prefix routes win over the
 *     stock /api prefix by longest-prefix match). M1: settings, projects,
 *     conversations, chat (+ stream). M2+: pipeline, graph, cards, inbox,
 *     write, candidates, events.
 *  4. Register the web-surface prompt section and print the URL line.
 */
import { networkInterfaces } from "node:os";
import { applicationIdentity } from "./application.js";
import { randomBytes } from "node:crypto";
import { join, resolve as resolvePath } from "node:path";
import z from "@deepseek-ai/schemastery";
import * as FrontendStatic from "@deepseek-ai/dsh-host-frontend-static";
import { HttpError, assertTrustedRequest, json } from "./rpc.js";
import { conversationPersonaInstruction, handleSettingsGet, handleSettingsPut, registerSettingsNamespace } from "./settings.js";
import { handleSettingsTest } from "./settings-test.js";
import { registerModelAdapter } from "./model-adapter.js";
import { registerUnoSessionEvents } from "./session-events.js";
import { registerPromptInspector, handlePromptInspector } from './prompt-inspector.js';
import {
	handleConversationCreate, handleConversationDelete, handleConversationGet,
	handleConversationPatch, handleProjectsGet, handleProjectsPost
} from "./projects.js";
import { handleChat, handleChatCancel, handleChatStream } from "./chat.js";
import { handleProjectKnowledge } from './project-knowledge.js';
import { handleCardGet, handleCardList, handleGraphGet, handleGraphOverviewGet } from "./graph.js";
import { LAYOUT_VERSION } from "./layout.js";
import { handleEventsGet, handlePipelineConversation, handlePipelineConversationReset, handlePipelineJob,
	handlePipelineStatus, handlePipelineStop } from "./pipeline.js";
import { handleConstructPrepare } from "./construct.js";
import { cancelUnoShutdown, handleUnoApi, hasAnyUnoJobRunning, prepareUnoShutdown, unoShutdownPrepared } from "./uno-jobs.js";
import { COMPILE_HEALTH } from "./book-compile.js";
import { STRATEGY_CONSTRUCTION_PROFILE, STRATEGY_CONSTRUCTION_WORKFLOW, CONSTRUCTION_STRATEGY_CONTRACT,
	CONSTRUCTION_REVIEW_POLICY } from '../../nexogenesis-tools/lib/uno/construction-strategy.js';
import { RELATION_WEAVING_CONTRACT, RELATION_WEAVING_ENDPOINT_RETRIEVAL,
	RELATION_WEAVING_FOCUS_SELECTION, RELATION_WEAVING_MAX_FOCUS_ATTEMPTS } from '../../nexogenesis-tools/lib/uno/construction-weaving.js';
import { CONSTRUCTION_JSON_TAIL_RECOVERY, CONSTRUCTION_RESPONSE_RECOVERY_CONTRACT } from './construction-request.js';
import { CONSTRUCTION_REPAIR_SCOPE_CONTRACT } from './construction-service.js';
import { createSpeechService, handleSpeechApi } from "./speech.js";
import { handleConversationControl } from "./conversation-control.js";
import { handleCandidatePrepare, handleWriteConfirm } from "./write.js";
import { handleInboxList, handleInboxUpload } from "./inbox.js";
import { handleReplay, handleSimulate } from "./simulate.js";
import { handleCognitiveInteractionAnswer, handleCognitiveRunGet, handleCognitiveRunResume, handleCognitiveRunSteer, handleCognitiveSessionGet, handleCognitiveSessionSteer } from "./cognition.js";
import { handleInstanceCreate, handleInstanceRegister, handleInstanceRename, handleInstancesGet, handleInstanceSwitch, handleInstanceUnregister } from "./instances.js";
import { configureInstanceContext, subscribeActiveInstance } from "../../nexogenesis-tools/lib/instances/registry.js";
import { conversationExt, setMetaInstanceId } from "./meta.js";
import { observeWork, handleWorkGet, handleNativeAnswer, handleWorkStop, instanceMutationsInFlight, withInstanceMutation } from "./work.js";

/** Stable Cordis plugin name. */
const name = "nexogenesis-web-host";
/** Services required before the web runtime can mount. */
const inject = ["webServer", "settings", "credentials", "sessions"];
/** Runtime service that the `connection` row injects for trusted hosts. */
const WEB_RUNTIME_SERVICE = "webRuntime";

const Config = z.object({
	dist: z.string().required(),
	/** Application root and local instance registry stay fixed while active knowledge changes. */
	appRoot: z.string().default(() => process.cwd()),
	/** Working directory for sessions created by this surface. */
	projectRoot: z.string().default(() => process.cwd()),
	instanceRegistry: z.string().default(""),
	printUrl: z.boolean().default(true),
	surfaceContext: z.boolean().default(true),
	trustedHosts: z.array(String).default([])
});

/** Environment variable naming the canonical local URL of this Web GUI. */
const DSH_WEB_URL = "DSH_WEB_URL";
const LOOPBACK_HOST = "127.0.0.1";
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = "0.0.0.0";

/**
 * Resolve one LAN-trust snapshot from the active server bind, mirroring the
 * stock web-app implementation (the connection row consumes this shape).
 */
function resolveLanTrust(bindHost, extra) {
	const lanAddresses = bindHost === ALL_INTERFACES_HOST
		? Object.values(networkInterfaces()).flat()
			.filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal)
			.map((iface) => iface.address)
		: [];
	return {
		lanAddresses,
		trustedHosts: [...lanAddresses, ...extra]
	};
}

/** Resolve the canonical loopback URL from the active Web server. */
function localWebUrl(ctx) {
	const port = ctx.get("webServer")?.port;
	if (port === void 0) throw new Error("nexogenesis-web-host: webServer service missing while resolving Web runtime");
	return `http://${LOOPBACK_HOST}:${String(port)}`;
}

/** Model-visible orientation and acceptance boundary for this fused surface. */
function webSurfacePrompt(webUrl) {
	return `You are interacting with the user through the NEXOGENESIS-UNO web UI at ${webUrl}. This development version retains the existing chat, knowledge graph, material-processing and write-approval capabilities while the unified workflow is being implemented. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this UI. The browser provides no implicit DOM, route, or screenshot context.`;
}

/** Decode the request pathname (query string excluded). */
function pathnameOf(req) {
	return new URL(req.url ?? "/", "http://x").pathname;
}

/** Wrap a handler with trust fencing and uniform JSON error responses. */
function guarded(trustedHosts, csrfToken, fn, { instanceMutation = true } = {}) {
	return async (req, res) => {
		try {
			assertTrustedRequest(req, trustedHosts, { csrfToken });
			if (instanceMutation) await withInstanceMutation(req, () => fn(req, res));
			else await fn(req, res);
		} catch (error) {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			const status = error instanceof HttpError ? error.status : 500;
			const message = error instanceof Error ? error.message : String(error);
			json(res, status, { detail: message });
		}
	};
}

/**
 * Mount the /api compatibility layer routes.
 * Prefix routes are matched longest-prefix-first against the stock `/api`
 * RPC gateway, so each registered prefix shadows only its own subtree.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 * @param projectRoot - normalized session working directory.
 */
function mountRoutes(ctx, config, projectRoot) {
	ctx.effect(() => subscribeActiveInstance((instance) => { projectRoot = instance.root; }));
	ctx.effect(() => registerPromptInspector(ctx, () => projectRoot));
	ctx.inject(["apiProxy"], (workCtx) => workCtx.effect(() => observeWork(workCtx, () => projectRoot)));
	const csrfToken = randomBytes(32).toString("base64url");
	const guard = (fn) => guarded(config.trustedHosts, csrfToken, fn);
	// Speech uses no knowledge state. Its potentially long model load must not hold the instance mutation lock.
	const speech = createSpeechService(config.appRoot);
	ctx.effect(() => () => speech.dispose(), "nexogenesis-web-host: speech worker");
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix", path: "/api/speech",
		handler: guarded(config.trustedHosts, csrfToken, (req, res) => handleSpeechApi(speech, req, res), { instanceMutation: false })
	}), "nexogenesis-web-host: /api/speech");
	ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/prompt-inspector', handler: guard((req, res) => handlePromptInspector(req, res, projectRoot)) }), 'nexogenesis-web-host: prompt inspector');
	ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/api/uno", handler: guard((req,res) => handleUnoApi(ctx,req,res,projectRoot,config.appRoot)) }), "nexogenesis-web-host: /api/uno");
	ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/api/runtime", handler: guard(async (req, res) => {
		const rest = pathnameOf(req).slice("/api/runtime".length);
		if (req.method === "POST" && rest === "/prepare-stop") {
			// The current prepare-stop request itself owns one mutation slot. Any
			// additional slot is a create/resume/write already past HTTP admission.
			const state = prepareUnoShutdown({ pendingMutations:Math.max(0,instanceMutationsInFlight()-1) });
			if (!state.ready) throw new HttpError(409, "仍有编译或建构任务正在创建或执行；请先在 UNO 中暂停任务，服务未停止。");
			return json(res, 200, state);
		}
		if (req.method === "POST" && rest === "/cancel-stop") return json(res, 200, cancelUnoShutdown());
		throw new HttpError(404, "not found");
	}) }), "nexogenesis-web-host: safe runtime stop");
	ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/api/work", handler: guard(async (req, res) => {
		const rest = pathnameOf(req).slice("/api/work".length);
		if (req.method === "GET" && !rest) return handleWorkGet(ctx, req, res, config.trustedHosts, projectRoot);
		const match = /^\/([^/]+)\/(answer|stop)$/.exec(rest);
		if (req.method === "POST" && match) return (match[2] === "answer" ? handleNativeAnswer : handleWorkStop)(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(match[1]));
		throw new HttpError(404, "not found");
	}) }), "nexogenesis-web-host: /api/work");

	// Same-origin frontend bootstrap. Cross-origin pages cannot read this response,
	// while every unsafe request must echo the short-lived token in a custom header.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/security/session",
		handler: guard(async (req, res) => {
			if (req.method !== "GET") throw new HttpError(405, "method not allowed");
			res.setHeader("cache-control", "no-store");
			json(res, 200, { token: csrfToken });
		})
	}), "nexogenesis-web-host: /api/security/session");

	// Health probe (exact route, no body).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/health",
		handler: guard(async (_req, res) => {
			json(res, 200, {
				ok: true,
				service: "nexogenesis-web-host",
				application: applicationIdentity(config.appRoot ?? projectRoot),
				operations: {
					active_uno_job: hasAnyUnoJobRunning(),
					stop_prepared: unoShutdownPrepared()
				},
				capabilities: {
					prompt_inspector: 1,
					construct_setup: true,
					thinking_setup: true,
					uno_thinking_routes: 1,
					uno_intent_routing: 1,
					uno_knowledge_workflows: 1,
                    uno_agent_selection: 1,
                    uno_agent_foundation: 1,
					uno_runtime_contract: 2,
					safe_runtime_stop: 1,
                    uno_request_context: 1,
                    ...COMPILE_HEALTH,
                    local_speech_input: 1,
					uno_compile_agent: 3,
					analysis_delivery_v2: true,
					analysis_delivery_trial: process.env.NEXO_CONVERSATION_V2 !== "0",
					conversation_discussion: true,
					native_steering: true,
					pipeline_conversation_reset: true,
					work_lifecycle: true,
					work_lifecycle_version: 3,
					conversation_controls_version: 1,
					uno_conversation_lifecycle: 1,
					uno_task_start_requests: 1,
					graph_layout_version: LAYOUT_VERSION,
					pipeline_idle_recovery: true,
					conversation_message_hygiene: true,
						uno_session_events: 1,
						uno_construction_service: 1,
						construction_profile: STRATEGY_CONSTRUCTION_PROFILE,
						construction_workflow: STRATEGY_CONSTRUCTION_WORKFLOW,
						construction_strategy_contract: CONSTRUCTION_STRATEGY_CONTRACT,
						construction_review_policy: CONSTRUCTION_REVIEW_POLICY,
						construction_repair_scope: CONSTRUCTION_REPAIR_SCOPE_CONTRACT,
						uno_relation_weaving: 1,
						relation_weaving_contract: RELATION_WEAVING_CONTRACT,
						relation_weaving_focus_selection: RELATION_WEAVING_FOCUS_SELECTION,
						relation_weaving_endpoint_retrieval: RELATION_WEAVING_ENDPOINT_RETRIEVAL,
						relation_weaving_max_focus_attempts: RELATION_WEAVING_MAX_FOCUS_ATTEMPTS,
						construction_json_recovery: CONSTRUCTION_JSON_TAIL_RECOVERY,
						construction_response_recovery: CONSTRUCTION_RESPONSE_RECOVERY_CONTRACT,
					conversation_internal_event_filter: true,
					general_knowledge_identity: true,
					talk_retrieval_gating: true,
					kimi_code_plan: true,
					kimi_code_plan_builtin_adapter: true,
					knowledge_instances: true,
					project_knowledge_links: 1
				}
			});
		})
	}), "nexogenesis-web-host: /api/health");

	// Settings.
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/settings",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/settings".length);
			if (req.method === "POST" && rest === "/test") return handleSettingsTest(ctx, req, res);
			if (rest !== "" && rest !== "/") throw new HttpError(404, "not found");
			if (req.method === "GET") await handleSettingsGet(ctx, req, res, config.trustedHosts);
			else if (req.method === "PUT") await handleSettingsPut(ctx, req, res, config.trustedHosts);
			else throw new HttpError(405, "method not allowed");
		})
	}), "nexogenesis-web-host: /api/settings");

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/instances",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/instances".length);
			if (req.method === "GET" && (rest === "" || rest === "/")) return handleInstancesGet(ctx, req, res, config.trustedHosts, config);
			if (req.method === "POST" && (rest === "" || rest === "/")) return handleInstanceCreate(ctx, req, res, config.trustedHosts, config);
			if (req.method === "POST" && (rest === "/register" || rest === "/register/")) return handleInstanceRegister(ctx, req, res, config.trustedHosts, config);
			if (req.method === "POST" && (rest === "/switch" || rest === "/switch/")) return handleInstanceSwitch(ctx, req, res, config.trustedHosts, config, projectRoot);
			const id = /^\/([^/]+)\/?$/.exec(rest);
			if (id && req.method === "PATCH") return handleInstanceRename(ctx, req, res, config.trustedHosts, config, decodeURIComponent(id[1]));
			if (id && req.method === "DELETE") return handleInstanceUnregister(ctx, req, res, config.trustedHosts, config, decodeURIComponent(id[1]));
			throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/instances");

	// Projects.
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/projects",
		handler: guard(async (req, res) => {
			const match = /^\/api\/projects\/([^/]+)\/knowledge$/.exec(pathnameOf(req));
			if (match) return handleProjectKnowledge(req, res, projectRoot, decodeURIComponent(match[1]));
			if (req.method === "GET") await handleProjectsGet(ctx, req, res, config.trustedHosts, projectRoot);
			else if (req.method === "POST") await handleProjectsPost(ctx, req, res, config.trustedHosts);
			else throw new HttpError(405, "method not allowed");
		})
	}), "nexogenesis-web-host: /api/projects");

	// Conversations (POST create; /:id GET / PATCH / DELETE).
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/conversations",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/conversations".length);
			if (req.method === "POST" && (rest === "" || rest === "/")) {
				await handleConversationCreate(ctx, req, res, config.trustedHosts, projectRoot);
				return;
			}
			if (rest.startsWith("/")) {
				const id = decodeURIComponent(rest.slice(1));
				if (req.method === "GET") await handleConversationGet(ctx, req, res, config.trustedHosts, id, projectRoot);
				else if (req.method === "PATCH") await handleConversationPatch(ctx, req, res, config.trustedHosts, id);
				else if (req.method === "DELETE") await handleConversationDelete(ctx, req, res, config.trustedHosts, id, projectRoot);
				else throw new HttpError(405, "method not allowed");
				return;
			}
			throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/conversations");

	// Graph (knowledge-body snapshot).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/graph",
		handler: guard(async (req, res) => {
			if (req.method !== "GET") throw new HttpError(405, "method not allowed");
			await handleGraphGet(ctx, req, res, config.trustedHosts, projectRoot);
		})
	}), "nexogenesis-web-host: /api/graph");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/graph/overview",
		handler: guard(async (req, res) => {
			if (req.method !== "GET") throw new HttpError(405, "method not allowed");
			await handleGraphOverviewGet(ctx, req, res, config.trustedHosts, projectRoot);
		})
	}), "nexogenesis-web-host: /api/graph/overview");

	// Cards (GET /api/cards/:id).
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/cards",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/cards".length);
			if (req.method === "GET" && (rest === "" || rest === "/")) {
				await handleCardList(ctx, req, res, config.trustedHosts, projectRoot);
				return;
			}
			if (req.method === "GET" && rest.startsWith("/")) {
				await handleCardGet(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(rest.slice(1)));
				return;
			}
			throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/cards");

	// Pipeline (status / job / :stage/conversation / jobs/:id/stop).
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/pipeline",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/pipeline".length);
			if (req.method === "GET" && rest === "/construct/prepare") {
				await handleConstructPrepare(ctx, req, res, config.trustedHosts, projectRoot);
				return;
			}
			if (req.method === "GET" && (rest === "/status" || rest === "/status/")) {
				await handlePipelineStatus(ctx, req, res, config.trustedHosts, projectRoot);
				return;
			}
			if (req.method === "GET" && (rest === "/job" || rest === "/job/")) {
				await handlePipelineJob(ctx, req, res, config.trustedHosts, projectRoot);
				return;
			}
			const resetMatch = /^\/(compile|theme_compile|digest|construct)\/conversation\/reset\/?$/.exec(rest);
			if (req.method === "POST" && resetMatch) {
				await handlePipelineConversationReset(ctx, req, res, config.trustedHosts, projectRoot, resetMatch[1]);
				return;
			}
			const stageMatch = /^\/(compile|theme_compile|digest|construct)\/conversation\/?$/.exec(rest);
			if (req.method === "POST" && stageMatch) {
				await handlePipelineConversation(ctx, req, res, config.trustedHosts, projectRoot, stageMatch[1]);
				return;
			}
			const stopMatch = /^\/jobs\/([^/]+)\/stop\/?$/.exec(rest);
			if (req.method === "POST" && stopMatch) {
				await handlePipelineStop(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(stopMatch[1]));
				return;
			}
			throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/pipeline");

	// Events (EventSource keep-alive).
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/cognition/sessions",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/cognition/sessions".length);
			const control = /^\/([^/]+)\/control\/?$/.exec(rest);
			if (req.method === "POST" && control) {
				await handleConversationControl(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(control[1]));
				return;
			}
			const steer = /^\/([^/]+)\/steer\/?$/.exec(rest);
			if (req.method === "POST" && steer) {
				await handleCognitiveSessionSteer(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(steer[1]));
				return;
			}
			const one = /^\/([^/]+)\/?$/.exec(rest);
			if (req.method === "GET" && one) {
				await handleCognitiveSessionGet(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(one[1]));
				return;
			}
			throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/cognition/sessions");

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/cognition/interactions",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/cognition/interactions".length);
			const response = /^\/([^/]+)\/respond\/?$/.exec(rest);
			if (req.method === "POST" && response) {
				await handleCognitiveInteractionAnswer(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(response[1]));
				return;
			}
			throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/cognition/interactions");

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/events",
		handler: guard(async (req, res) => {
			if (req.method !== "GET") throw new HttpError(405, "method not allowed");
			await handleEventsGet(ctx, req, res, config.trustedHosts);
		})
	}), "nexogenesis-web-host: /api/events");

	// CognitiveRun inspection and in-loop steering.
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/cognition/runs",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/cognition/runs".length);
			const resume = /^\/([^/]+)\/resume\/?$/.exec(rest);
			if (req.method === "POST" && resume) {
				await handleCognitiveRunResume(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(resume[1]));
				return;
			}
			const steer = /^\/([^/]+)\/steer\/?$/.exec(rest);
			if (req.method === "POST" && steer) {
				await handleCognitiveRunSteer(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(steer[1]));
				return;
			}
			const one = /^\/([^/]+)\/?$/.exec(rest);
			if (req.method === "GET" && one) {
				await handleCognitiveRunGet(ctx, req, res, config.trustedHosts, projectRoot, decodeURIComponent(one[1]));
				return;
			}
			throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/cognition/runs");

	// Write approval + candidates.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/write/confirm",
		handler: guard(async (req, res) => {
			if (req.method !== "POST") throw new HttpError(405, "method not allowed");
			await handleWriteConfirm(ctx, req, res, config.trustedHosts, projectRoot);
		})
	}), "nexogenesis-web-host: /api/write/confirm");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/candidates/prepare",
		handler: guard(async (req, res) => {
			if (req.method !== "POST") throw new HttpError(405, "method not allowed");
			await handleCandidatePrepare(ctx, req, res, config.trustedHosts);
		})
	}), "nexogenesis-web-host: /api/candidates/prepare");

	// Inbox upload (multipart).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/inbox",
		handler: guard(async (req, res) => {
			if (req.method === "GET") {
				await handleInboxList(ctx, req, res, config.trustedHosts, projectRoot);
				return;
			}
			if (req.method === "POST") {
				await handleInboxUpload(ctx, req, res, config.trustedHosts, projectRoot);
				return;
			}
			throw new HttpError(405, "method not allowed");
		})
	}), "nexogenesis-web-host: /api/inbox");

	// Simulate / replay (demo modes).
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/simulate",
		handler: guard(async (req, res) => {
			if (req.method !== "POST") throw new HttpError(405, "method not allowed");
			await handleSimulate(ctx, req, res, config.trustedHosts);
		})
	}), "nexogenesis-web-host: /api/simulate");

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/replay",
		handler: guard(async (req, res) => {
			if (req.method !== "GET") throw new HttpError(405, "method not allowed");
			await handleReplay(ctx, req, res, config.trustedHosts);
		})
	}), "nexogenesis-web-host: /api/replay");

	// Chat (POST /api/chat, POST /api/chat/stream, POST /api/chat/cancel).
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/api/chat",
		handler: guard(async (req, res) => {
			const rest = pathnameOf(req).slice("/api/chat".length);
			if (req.method !== "POST") throw new HttpError(405, "method not allowed");
			if (rest === "/stream") await handleChatStream(ctx, req, res, config.trustedHosts, projectRoot);
			else if (rest === "/cancel") await handleChatCancel(ctx, req, res, config.trustedHosts, projectRoot);
			else if (rest === "" || rest === "/") await handleChat(ctx, req, res, config.trustedHosts, projectRoot);
			else throw new HttpError(404, "not found");
		})
	}), "nexogenesis-web-host: /api/chat");
}

/**
 * Mount the fusion runtime: webRuntime service, Nexogenesis dist, routes,
 * surface prompt, shell variable, and the URL line.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
async function apply(ctx, config) {
	await registerUnoSessionEvents(ctx);
	// Normalize the configured dist path to native separators: the
	// frontend-static traversal fence compares with `path.sep`, so a
	// forward-slash config on Windows would 403 every request.
	const distIndex = resolvePath(config.dist);
	const appRoot = resolvePath(config.appRoot);
	config.appRoot = appRoot;
	config.instanceRegistry = config.instanceRegistry ? resolvePath(config.instanceRegistry) : resolvePath(join(appRoot, ".nexogenesis", "instances.json"));
	const active = configureInstanceContext({ registryPath: config.instanceRegistry, fallbackRoot: resolvePath(config.projectRoot) });
	const projectRoot = active.root;
	setMetaInstanceId(active.id);
	ctx.effect(() => subscribeActiveInstance((instance) => setMetaInstanceId(instance.id)));
	const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts);
	ctx.provide(WEB_RUNTIME_SERVICE, runtime);
	ctx.plugin(FrontendStatic, { distIndex });
	registerSettingsNamespace(ctx);
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.systemPrompt.section({
			name: "app:conversation-persona",
			order: -97,
			text: context => conversationExt(context?.agent?.session?.id)?.uno_job_id ? "" : conversationPersonaInstruction(promptCtx)
		});
	});
	registerModelAdapter(ctx);
	mountRoutes(ctx, config, projectRoot);
	if (config.surfaceContext) {
		ctx.inject(["systemPrompt"], (promptCtx) => {
			promptCtx.systemPrompt.section({
				name: "app:nexogenesis-surface",
				order: -98,
				text: () => webSurfacePrompt(localWebUrl(promptCtx))
			});
		});
		ctx.inject(["shellEnv"], (runtimeCtx) => {
			runtimeCtx.shellEnv.register({
				name: "nexogenesis-web-runtime",
				variables: { [DSH_WEB_URL]: { description: "Canonical local URL of the Nexogenesis web UI serving this session." } },
				resolve: () => ({ [DSH_WEB_URL]: localWebUrl(runtimeCtx) })
			});
		});
	}
	if (config.printUrl) {
		const printUrl = () => {
			const lanCandidate = runtime.lanAddresses[0];
			const port = ctx.webServer.port;
			console.log(`nexogenesis web: ${localWebUrl(ctx)}${lanCandidate === void 0 ? "" : ` (LAN: http://${lanCandidate}:${String(port)})`}`);
		};
		const settled = ctx.get("loader")?.await();
		if (settled === void 0) printUrl();
		else settled.then(() => {
			if (ctx.get("webServer") !== void 0) printUrl();
		}, () => {});
	}
}

export { Config, WEB_RUNTIME_SERVICE, apply, inject, localWebUrl, mountRoutes, name, resolveLanTrust };
