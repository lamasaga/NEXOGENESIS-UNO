import { resolveKnowledgeRef } from './project-knowledge.js';
import { HttpError, json, readJsonBody } from './rpc.js';
import { HarnessGateway } from '../../nexogenesis-tools/lib/harness/gateway.js';

export async function handleCardWrite(req, res, root, id) {
  if (!id.startsWith('kb:')) throw new HttpError(400, '保存必须绑定打开卡片时的知识库。');
  const target = resolveKnowledgeRef(root, id), body = await readJsonBody(req);
  if (!/^[a-z0-9-]{8,80}$/i.test(body.request_id ?? '')) throw new HttpError(400, '保存请求标识无效。');
  try {
    return json(res, 200, new HarnessGateway(target.root).writeReaderEntry({
      key: `reader/${target.id}/${body.request_id}`, card_id: target.id, author: 'user', operation: body.operation,
      text: body.text, expected_revision: body.expected_revision,
      ...(body.operation === 'note' ? { note_id: body.note_id, expected_note_revision: body.expected_note_revision, anchor: body.anchor ?? null } : {})
    }));
  } catch (error) {
    const status = ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'WRITE_LOCK_BUSY'].includes(error.code) ? 409 : 400;
    const message = error.code === 'REVISION_CONFLICT' ? '这张卡片或笔记已在别处更新。你的草稿已保留，请查看最新内容后再保存。' : error.code === 'WRITE_LOCK_BUSY' ? '知识库正在保存其他内容，请稍后重试。你的草稿已保留。' : error.message;
    throw Object.assign(new HttpError(status, message), { code: error.code });
  }
}
