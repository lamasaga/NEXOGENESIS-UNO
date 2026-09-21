const SPACE = /^\s$/u;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

// No case folding, punctuation removal, Unicode compatibility normalization or
// edits to non-whitespace characters. Latin/digit word boundaries stay present.
function mappedText(source, layoutEquivalent) {
  const chars=Array.from(source),parts=[],starts=[],ends=[];
  const push=(text,start,end)=>{parts.push(text);for(let n=0;n<text.length;n++){starts.push(start);ends.push(end);}};
  for(let i=0;i<chars.length;){
    if(layoutEquivalent&&SPACE.test(chars[i])){
      let end=i+1;while(end<chars.length&&SPACE.test(chars[end]))end++;
      if(!(i>0&&end<chars.length&&CJK.test(chars[i-1])&&CJK.test(chars[end])))push(' ',i,end);
      i=end;
    }else{push(chars[i],i,i+1);i++;}
  }
  return {chars,text:parts.join(''),starts,ends};
}

/**
 * Locate an unchanged quotation, tolerating only whitespace layout differences.
 * Returned offsets count Unicode code points in the ORIGINAL source. The full
 * original span must fit inside one delivered interval; whitespace gaps are not
 * silently credited. Repeated text resolves to the first delivered occurrence,
 * or is rejected with unique:true when its location cannot be established.
 */
export function locateQuote(source, quote, {intervals,layoutEquivalent=true,unique=false}={}) {
  if(typeof source!=='string'||typeof quote!=='string'||!quote.trim())return null;
  const haystack=mappedText(source,layoutEquivalent),needle=mappedText(quote,layoutEquivalent).text;
  if(!needle)return null;
  const delivered=intervals===undefined?[[0,haystack.chars.length]]:intervals;
  if(!Array.isArray(delivered))return null;
  let cursor=0,found=null;
  while(cursor<=haystack.text.length-needle.length){
    const at=haystack.text.indexOf(needle,cursor);if(at<0)break;cursor=at+1;
    const start=haystack.starts[at],end=haystack.ends[at+needle.length-1];
    if(!delivered.some(row=>Array.isArray(row)&&Number.isInteger(row[0])&&Number.isInteger(row[1])&&row[0]<=start&&row[1]>=end))continue;
    const exact=haystack.chars.slice(start,end).join('');
    // Reject a match beginning inside a surrogate pair, rather than widening it.
    if(mappedText(exact,layoutEquivalent).text!==needle)continue;
    const match={quote:exact,start,end,offset_unit:'Unicode characters',match_kind:exact===quote?'exact':'layout-equivalent',
      ...(exact===quote?{}:{submitted_quote:quote})};
    if(!unique)return match;
    if(found)return null;
    found=match;
  }
  return found;
}
