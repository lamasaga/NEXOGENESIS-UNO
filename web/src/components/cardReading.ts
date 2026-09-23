export const TYPE_LABELS:Record<string,string>={conflict:'争议',entity:'实体',case:'案例',concept:'概念',method:'方法',mechanism:'机制',model:'模型',claim:'观点',phenomenon:'现象',undetermined:'未定',domain:'领域',source:'原文'};
export function cardTypeLabel(card:{type?:string}):string{return TYPE_LABELS[card.type??'']??card.type??'未分类';}

export function readableCardBody(body: string): string {
  return body.replace(/(?:<!--|&lt;!--|&#60;!--)\s*unit\s*:[\s\S]*?(?:-->|--&gt;|--&#62;)/gi, "");
}
export function readableCardExcerpt(excerpt: string): string {
  // Older running hosts may already have removed Markdown punctuation from comments.
  return readableCardBody(excerpt).replace(/<!\s*unit\s*:\s*[a-z][a-z0-9 _-]*/gi, "");
}
export interface ReaderFrame { x: number; y: number; width: number; height: number; }
export function fitReaderFrame(frame: ReaderFrame, viewport: { width: number; height: number }): ReaderFrame {
  const margin = 8;
  const width = Math.min(Math.max(320, frame.width), Math.max(0, viewport.width - margin * 2));
  const height = Math.min(Math.max(240, frame.height), Math.max(0, viewport.height - margin * 2));
  return { width, height,
    x: Math.max(margin, Math.min(frame.x, viewport.width - width - margin)),
    y: Math.max(margin, Math.min(frame.y, viewport.height - height - margin)),
  };
}
export function initialReaderFrame(index = 0): ReaderFrame {
  const viewport = typeof window === "undefined" ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight };
  return fitReaderFrame({ x: viewport.width - 760 - index * 28, y: 64 + index * 28, width: 720, height: Math.min(900, viewport.height - 100) }, viewport);
}
