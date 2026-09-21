import { join, resolve } from "node:path";
import { isQuickThinkingRunning } from "./quick-thinking.js";
import { isUnoJobRunning, hasUnoJobRunning } from "./uno-jobs.js";
import {
	activateKnowledgeInstance, configureInstanceContext, createKnowledgeInstance,
	ensureInstanceRegistry, instanceSummary, registerExistingKnowledgeInstance,
	renameKnowledgeInstance, unregisterKnowledgeInstance
} from "../../nexogenesis-tools/lib/instances/registry.js";
import { getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { HttpError, json, readJsonBody, rpcCall } from "./rpc.js";
import { readMeta, setMetaInstanceId } from "./meta.js";

export function registryPathFromConfig(config) {
	return resolve(config.instanceRegistry || join(config.appRoot || config.projectRoot || process.cwd(), ".nexogenesis", "instances.json"));
}

function registry(config) {
	return ensureInstanceRegistry(registryPathFromConfig(config), config.projectRoot || config.appRoot || process.cwd());
}

export function instanceListPayload(config) {
	const current = registry(config);
	return { active_instance_id: current.active_instance_id, instances: current.instances.map((instance) => instanceSummary(instance, current.active_instance_id)) };
}

function instanceError(error, fallbackStatus = 400) {
	const message = error instanceof Error ? error.message : String(error);
	return new HttpError(/不存在/.test(message) ? 404 : fallbackStatus, message);
}

export async function handleInstancesGet(_ctx, _req, res, _trustedHosts, config) {
	json(res, 200, instanceListPayload(config));
}

export async function handleInstanceCreate(_ctx, req, res, _trustedHosts, config) {
	const body = await readJsonBody(req);
	try {
		const created = createKnowledgeInstance(registryPathFromConfig(config), join(resolve(config.appRoot || config.projectRoot || process.cwd()), "knowledge-bases"), body.name);
		const current = registry(config);
		json(res, 201, { active_instance_id: current.active_instance_id, instance: instanceSummary(created, current.active_instance_id) });
	} catch (error) { throw instanceError(error); }
}

export async function handleInstanceRegister(_ctx, req, res, _trustedHosts, config) {
	const body = await readJsonBody(req);
	try {
		const registered = registerExistingKnowledgeInstance(registryPathFromConfig(config), body.path, body.name);
		const current = registry(config);
		json(res, 201, { active_instance_id: current.active_instance_id, instance: instanceSummary(registered, current.active_instance_id) });
	} catch (error) { throw instanceError(error); }
}

export async function handleInstanceRename(_ctx, req, res, _trustedHosts, config, instanceId) {
	const body = await readJsonBody(req);
	try {
		renameKnowledgeInstance(registryPathFromConfig(config), instanceId, body.name);
		const current = registry(config);
		const renamed = current.instances.find((instance) => instance.id === instanceId);
		json(res, 200, { active_instance_id: current.active_instance_id, instance: instanceSummary(renamed, current.active_instance_id) });
	} catch (error) { throw instanceError(error); }
}

export async function handleInstanceUnregister(_ctx, req, res, _trustedHosts, config, instanceId) {
	await readJsonBody(req);
	try {
		unregisterKnowledgeInstance(registryPathFromConfig(config), instanceId);
		json(res, 200, { ...instanceListPayload(config), removed_instance_id: instanceId, disk_content_retained: true });
	} catch (error) { throw instanceError(error); }
}

async function assertNoActiveInstanceWork(ctx, projectRoot) {
  if(hasUnoJobRunning(projectRoot))throw new HttpError(409,"当前知识库仍在编译或审核，请先暂停。");
	const meta = readMeta();
	const sessions = (await rpcCall(ctx, "session.list", {})).items ?? [];
	for (const session of sessions) {
		if (!meta.conversations[session.sessionId] || meta.deleted[session.sessionId] === true) continue;
		if (session.running === true || isQuickThinkingRunning(session.sessionId) || isUnoJobRunning(session.sessionId)) {
			const ext = meta.conversations[session.sessionId];
			throw new HttpError(409, `“${ext.title ?? session.projections?.values?.title ?? "未命名对话"}”${ext.native_question ? "正在等待你的选择" : "仍在执行"}。请在“任务与待办”中处理或暂停后切换。`);
		}
		const state = getCognitiveRuntime(projectRoot).current(session.sessionId);
		if (state?.run.status === "running" && Date.now() - Date.parse(state.run.updated_at) < 30000) throw new HttpError(409, "有任务正在启动或接续，请稍后重试；可在“任务与待办”查看。");
	}
}

export async function handleInstanceSwitch(ctx, req, res, _trustedHosts, config, projectRoot) {
	const body = await readJsonBody(req);
	const instanceId = typeof body.instance_id === "string" ? body.instance_id : "";
	if (!instanceId) throw new HttpError(400, "缺少 instance_id");
	const current = registry(config);
	if (!current.instances.some((instance) => instance.id === instanceId)) throw new HttpError(404, `知识实例不存在：${instanceId}`);
	await assertNoActiveInstanceWork(ctx, projectRoot);
	try {
		const active = activateKnowledgeInstance(registryPathFromConfig(config), instanceId);
		setMetaInstanceId(active.id);
		json(res, 200, { active_instance_id: active.id, instance: instanceSummary(active, active.id) });
	} catch (error) { throw instanceError(error); }
}
