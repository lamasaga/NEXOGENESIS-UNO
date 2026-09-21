/** UNO knowledge records. New records use one primary type plus domain memberships. */
import { CARD_TYPES, CARD_TYPE_LABELS } from './uno/card-classification.js';
export const LINK_LABELS = { specialization:"细分",supplement:"补充",contrast:"对照",challenge:"质疑",analogy:"类比",example:"例证",application:"应用",related:"相关（历史）",boundary:"边界（历史）",background:"背景（历史）" };
const legacyTags = { claim: "观点", model: "模型", method: "方法", phenomenon: "现象", entity: "人物", conflict: "争议", domain: "领域" };
export function displayType(meta) {
  if (CARD_TYPES.includes(meta.type) || meta.type === 'domain') return meta.type;
  if (!Array.isArray(meta.tags)) return meta.type ?? "unknown";
  if(meta.tags.includes('实体'))return 'entity';
  if(meta.tags.includes('机制'))return 'model';
  for (const [type, tag] of Object.entries(legacyTags)) if (meta.tags.includes(tag)) return type;
  return "claim";
}
export function displayTypeLabel(meta) { return CARD_TYPE_LABELS[displayType(meta)] ?? (displayType(meta)==='domain'?'领域':'未分类'); }
export function safeId(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value); }
// Existing knowledge uses Chinese and punctuation in stable IDs. Keep task IDs
// strict, while validating card IDs as one safe Windows filename component.
export function safeCardId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && !/[\\/:*?"<>|\x00-\x1f]/.test(value) && !/[. ]$/.test(value)
    && !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(value);
}
export function normalTitle(title) { return String(title).normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, ""); }
export function titleSimilarity(a, b) {
  a = normalTitle(a); b = normalTitle(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 8 || Math.min(a.length, b.length) / Math.max(a.length, b.length) < .88) return 0;
  const pairs = s => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const x = pairs(a), y = pairs(b);
  return 2 * [...x].filter(p => y.has(p)).length / (x.size + y.size);
}
export function nearTitles(title, cards) {
  return [...cards].map(([id, card]) => ({ id, title: card.meta?.title ?? card.title, similarity: titleSimilarity(title, card.meta?.title ?? card.title) }))
    .filter(c => c.similarity >= .92).sort((a,b) => b.similarity - a.similarity).slice(0, 4);
}
export function checkLink(link) {
  if (!link || typeof link.source !== "string" || typeof link.target !== "string" || link.source === link.target || !Object.hasOwn(LINK_LABELS, link.type)) throw new Error("联系需要不同的合法端点与已支持的用途。");
  if (typeof link.note !== "string" || link.note.trim().length < 8 || link.note.length > 300 || /[\x00-\x1f]/.test(link.note)) throw new Error("联系理由需要 8–300 个单行字符，说明值得一起查看的具体原因。");
  return { source: link.source, target: link.target, type: link.type, note: link.note.trim() };
}
