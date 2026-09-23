export function normalizeConversationTitle(value) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || ["新会话", "新对话"].includes(text)) return "";
  const characters = Array.from(text);
  return characters.length > 32 ? characters.slice(0, 31).join("") + "…" : text;
}
