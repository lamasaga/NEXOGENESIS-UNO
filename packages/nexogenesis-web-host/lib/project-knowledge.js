import { currentInstanceRegistry, instanceSummary } from '../../nexogenesis-tools/lib/instances/registry.js';
import { readMeta, writeMeta, conversationExt } from './meta.js';
import { HttpError, json, readJsonBody } from './rpc.js';
import { collectThinkingContext } from './thinking-routes.js';

function projectRecord(id) {
  const project = readMeta().projects[id];
  if (!project) throw new HttpError(404, '项目不存在');
  return project;
}

export function projectKnowledge(root, projectId) {
  const project = projectRecord(projectId), registry = currentInstanceRegistry(root);
  return { project_id: project.id, project_name: project.name,
    knowledge_instance_ids: project.knowledge_instance_ids ?? [registry.active_instance_id],
    instances: registry.instances.map(i => instanceSummary(i, registry.active_instance_id)) };
}

export function saveProjectKnowledge(root, projectId, ids) {
  const project = projectRecord(projectId), registry = currentInstanceRegistry(root);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !registry.instances.some(i => i.id === id))) {
    throw new HttpError(400, '请选择已登记的知识库；列表可能已变化，请重新打开设置。');
  }
  project.knowledge_instance_ids = [...new Set(ids)];
  writeMeta();
  return projectKnowledge(root, projectId);
}

export async function handleProjectKnowledge(req, res, root, projectId) {
  if (req.method === 'GET') return json(res, 200, projectKnowledge(root, projectId));
  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    return json(res, 200, saveProjectKnowledge(root, projectId, body.knowledge_instance_ids));
  }
  throw new HttpError(405, 'method not allowed');
}

export const knowledgeRef = (instanceId, id) => `kb:${instanceId}:${id}`;
export function resolveKnowledgeRef(root, id) {
  if (!id.startsWith('kb:')) return { root, id, scope: null };
  const match = /^kb:([a-z0-9_-]+):(.+)$/i.exec(id);
  const instance = match && currentInstanceRegistry(root).instances.find(i => i.id === match[1]);
  if (!instance) throw new HttpError(404, '引用的知识库已移除或不存在');
  return { root: instance.root, id: match[2], scope: instance.id };
}

/** Snapshot the selection at turn start; never silently substitute an unavailable library. */
export function conversationKnowledge(root, conversationId) {
  const project = readMeta().projects[conversationExt(conversationId).project_id];
  if (!project || project.knowledge_instance_ids === undefined) return null;
  const registry = currentInstanceRegistry(root);
  return project.knowledge_instance_ids.map(id => {
    const instance = registry.instances.find(i => i.id === id);
    if (!instance) throw new HttpError(409, '关联知识库已移除，请在思维体表达中重新选择。');
    return instance;
  });
}

export async function collectProjectKnowledge(root, query, route, libraries, retrieve = collectThinkingContext) {
  if (libraries === null) return retrieve(root, query, route);
  const groups = await Promise.all(libraries.map(async library => {
    const packets = await retrieve(library.root, query, route);
    return packets.map(packet => ({ ...packet, id: knowledgeRef(library.id, packet.id),
      knowledge_base: { id: library.id, name: library.name },
      title: `${packet.title} · ${library.name}`,
      links: (packet.links ?? []).map(link => ({ ...link, from: knowledgeRef(library.id, link.from), to: knowledgeRef(library.id, link.to) })) }));
  }));
  // Interleave local rankings so the first library cannot consume the whole context.
  const result = []; let remaining = 22000 - 2;
  for (let index = 0; groups.some(group => index < group.length); index++) {
    for (const group of groups) {
      const item = group[index]; if (!item) continue;
      const size = JSON.stringify(item).length + (result.length ? 1 : 0);
      if (size > remaining) continue;
      result.push(item); remaining -= size;
    }
  }
  return result;
}
