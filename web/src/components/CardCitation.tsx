import { Children, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { defaultUrlTransform } from "react-markdown";

const CARD_CITATION_PATTERN = /\[\[card:([^\]|]+)(?:\|([^\]\r\n]+))?\]\]/g;
const CARD_CITATION_PROTOCOL = "nexo-card:";

/**
 * 将模型输出的可审计卡片标记转换为 Markdown 链接。
 *
 * 约定：[[card:卡片 id|给用户看的卡片标题]]。保留完整标题用于引用提示，
 * 正文呈现使用每条回答内的短编号；原始 id 仍供 CardReader 打开使用。
 */
export function cardCitationMarkdown(markdown: string): string {
  return markdown.replace(CARD_CITATION_PATTERN, (whole, rawId: string, rawTitle: string | undefined) => {
    const cardId = rawId.trim();
    const title = (rawTitle ?? cardId).trim();
    if (!cardId || !title) return whole;
    return `[${escapeMarkdownLabel(title)}](${CARD_CITATION_PROTOCOL}${encodeURIComponent(cardId)})`;
  });
}

export function cardIdFromCitationHref(href: string | undefined): string | null {
  if (!href?.startsWith(CARD_CITATION_PROTOCOL)) return null;
  try {
    const cardId = decodeURIComponent(href.slice(CARD_CITATION_PROTOCOL.length)).trim();
    return cardId || null;
  } catch {
    return null;
  }
}

export function citationUrlTransform(url: string): string | null {
  return cardIdFromCitationHref(url) ? url : defaultUrlTransform(url);
}

export function cardCitationNumbers(markdown: string): Map<string, number> {
  const numbers = new Map<string, number>();
  const prose = markdown.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, "").replace(/`[^`\n]*`/g, "");
  for (const match of prose.matchAll(CARD_CITATION_PATTERN)) {
    const id = match[1].trim();
    if (id && (match[2] ?? id).trim() && !numbers.has(id)) numbers.set(id, numbers.size + 1);
  }
  return numbers;
}

function labelText(children: ReactNode): string {
  return Children.toArray(children).map((child): string => isValidElement<{ children?: ReactNode }>(child)
    ? labelText(child.props.children) : String(child)).join("");
}

export function CardCitationLink({ href, children, onOpenCard, citationNumber }: {
  href?: string;
  children?: ReactNode;
  onOpenCard?: (cardId: string) => void;
  citationNumber?: number;
}) {
  const tooltipId = useId();
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => setAnchor(null);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => { window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss); };
  }, [anchor]);
  const cardId = cardIdFromCitationHref(href);
  if (!cardId) return <a href={href}>{children}</a>;
  const title = labelText(children) || cardId;
  const label = citationNumber ? `[${citationNumber}]` : "[↗]";
  const show = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    setAnchor({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      ...(window.innerHeight - rect.bottom > 120 ? { top: rect.bottom + 8 } : { bottom: window.innerHeight - rect.top + 8 }),
    });
  };
  const tooltip = anchor && typeof document !== "undefined" ? createPortal(
    <span id={tooltipId} role="tooltip" className="card-citation-tooltip" style={anchor}>{title}</span>, document.body
  ) : null;
  const accessibleLabel = `${citationNumber ? `依据 ${citationNumber}，` : ""}${onOpenCard ? "阅读知识卡片：" : "知识卡片："}${title}`;
  return <>
    {onOpenCard ? <button type="button" className="md-card-citation" data-card-id={cardId}
      aria-label={accessibleLabel} aria-describedby={anchor ? tooltipId : undefined}
      onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={() => setAnchor(null)}
      onFocus={(event) => show(event.currentTarget)} onBlur={() => setAnchor(null)}
      onKeyDown={(event) => { if (event.key === "Escape") { setAnchor(null); event.stopPropagation(); } }}
      onClick={() => { setAnchor(null); onOpenCard(cardId); }}>{label}</button>
      : <span className="md-card-citation" title={title} aria-label={accessibleLabel}>{label}</span>}
    {tooltip}
  </>;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\[\]]/g, "\\$&");
}
