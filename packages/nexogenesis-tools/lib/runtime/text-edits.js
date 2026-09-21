/** Deterministic text operations. No eval, fuzzy replacement or knowledge writes. */
export function applyTextEdits(body, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 32) throw Error('局部修改需要 1–32 项 edits');
  let text = body;
  for (const edit of edits) {
    if (typeof edit.old_text !== 'string' || !edit.old_text || typeof edit.new_text !== 'string') throw Error('每项修改需要非空 old_text 和 new_text');
    const at = text.indexOf(edit.old_text);
    if (at < 0 || text.indexOf(edit.old_text, at + 1) >= 0) throw Error('修改原句不存在或不唯一，请补充上下文后重试；没有应用本组修改');
    text = text.slice(0, at) + edit.new_text + text.slice(at + edit.old_text.length);
  }
  return text;
}

export function textBlocks(text) {
  const result = []; let offset = 0;
  for (const part of text.split(/(\n\s*\n)/)) {
    const length = Array.from(part).length;
    if (part.trim()) result.push({id: `b${result.length + 1}`, start: offset, end: offset + length, text: part});
    offset += length;
  }
  return result;
}

export function resolveExclusions(body, {exclude_ranges = [], exclude_blocks = [], exclude_quotes = []}) {
  const blocks = textBlocks(body);
  const ranges = [...exclude_ranges];
  for (const item of exclude_blocks) {
    const block = blocks.find(b => b.id === item.id);
    if (!block || !item.reason?.trim()) throw Error('删除块需要当前版本中存在的块 ID 和理由');
    ranges.push({start: block.start, end: block.end, quote: block.text, reason: item.reason});
  }
  for (const item of exclude_quotes) {
    if (!item.quote || !item.reason?.trim()) throw Error('删除片段需要完整原句和理由');
    const at = body.indexOf(item.quote);
    if (at < 0 || body.indexOf(item.quote, at + 1) >= 0) throw Error('删除原句不存在或不唯一，请使用块 ID 或补充上下文');
    const start = Array.from(body.slice(0, at)).length;
    ranges.push({start, end: start + Array.from(item.quote).length, ...item});
  }
  return ranges;
}

/** Bounded literal excerpts; query hits and explicit qualifications both get a chance.
 * These are retrieval heuristics, never a claim that all counterevidence was found. */
export function selectPassages(text, terms, budget=1800) {
  if(text.length<=budget)return {text,truncated:false,spans:[{start:0,end:text.length}],offset_unit:'UTF-16 code units'};
  const separator='\n[…中间省略…]\n',words=[...new Set(terms.map(t=>String(t).toLowerCase()).filter(Boolean))],lower=text.toLowerCase();
  const candidates=[];
  // Repeated occurrences can carry a qualification that the first occurrence lacks.
  for(const word of words){let at=0;for(let n=0;n<8;n++){at=lower.indexOf(word,at);if(at<0)break;candidates.push({at,priority:1});at+=word.length;}}
  for(const match of text.matchAll(/反例|不适用|仅限|除非|但是|然而|适用条件|限制|边界|\bhowever\b|\bonly if\b/giu)){
    const nearby=lower.slice(Math.max(0,match.index-160),match.index+400);
    candidates.push({at:match.index,priority:words.some(w=>nearby.includes(w))?4:2});
  }
  candidates.sort((a,b)=>b.priority-a.priority||a.at-b.at);
  const alignStart=n=>n>0&&/[\uDC00-\uDFFF]/.test(text[n])?n-1:n;
  const alignEnd=n=>n>0&&/[\uD800-\uDBFF]/.test(text[n-1])?n-1:n;
  const spans=[{start:0,end:alignEnd(Math.min(240,Math.floor(budget/5)))}];let remaining=budget-spans[0].end;
  for(const {at} of candidates){
    if(remaining<=separator.length+60||spans.some(s=>at>=s.start&&at<s.end))continue;
    const length=Math.min(620,remaining-separator.length),start=alignStart(Math.max(spans[0].end,at-Math.min(140,Math.floor(length/3)))),end=alignEnd(Math.min(text.length,start+length));
    if(spans.some(s=>start<s.end&&end>s.start))continue;
    spans.push({start,end});remaining-=end-start+separator.length;
  }
  if(spans.length===1)spans[0].end=alignEnd(budget);
  spans.sort((a,b)=>a.start-b.start);
  return {text:spans.map(s=>text.slice(s.start,s.end)).join(separator),truncated:true,spans,offset_unit:'UTF-16 code units'};
}
