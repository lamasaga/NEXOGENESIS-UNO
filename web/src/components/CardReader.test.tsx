import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { CardMarkdown, CardReader, CardSources, sourceReaderId, cardMarkdownUrl } from "./CardReader";
import { readableCardBody, readableCardExcerpt, fitReaderFrame } from "./cardReading";

describe("CardMarkdown", () => {
  const bufferBase='05-Buffer/books/'+'a'.repeat(64)+'/'+'b'.repeat(64),bufferUnit=bufferBase+'/units/c0002-p003.md';
  const base='03-Archive/books/'+'a'.repeat(64)+'/'+'b'.repeat(64),unit=base+'/units/c0002-p003.md';
  it('opens split Buffer units as book evidence and scopes extracted images',()=>{
    expect(sourceReaderId(bufferUnit+'#char-20-80','finance')).toBe('kb:finance:book:'+bufferUnit+':0');
    const html=renderToString(<CardSources sources={[bufferUnit]} libraryId="finance" onNavigate={()=>{}}/>);
    expect(html).toContain('阅读单元 2.3');
    const image=bufferBase+'/assets/001-figure.png';
    expect(cardMarkdownUrl(image,'finance')).toBe('/api/uno/assets?ref='+encodeURIComponent(image)+'&library_id=finance');
    expect(renderToString(<CardMarkdown body={`![图一](${image})`} libraryId="finance"/>)).toContain(encodeURIComponent(image));
    for(const unsafe of [bufferBase+'/catalog.md',bufferBase+'/units/../../catalog.md',bufferBase+'/assets/..'])expect(sourceReaderId(unsafe)).toBeNull();
    for(const unsafe of [bufferUnit,bufferBase+'/catalog.md',bufferBase+'/assets/../catalog.md'])expect(cardMarkdownUrl(unsafe)).toBe('');
  });
  it('links archived book units to a scoped original-text reader and preserves old Buffer navigation',()=>{
    expect(sourceReaderId(unit,'finance')).toBe('kb:finance:book:'+unit+':0');
    expect(sourceReaderId(unit+'#chars=20-80')).toBe('book:'+unit+':0');
    expect(sourceReaderId('05-Buffer/_index/source.md','finance')).toBe('kb:finance:buffer:05-Buffer/_index/source.md:0');
    const html=renderToString(<CardSources sources={[unit]} libraryId="finance" onNavigate={()=>{}}/>);
    expect(html).toContain('<button');expect(html).toContain('阅读单元 2.3');expect(html).not.toContain('a'.repeat(64));
    expect(sourceReaderId(base+'/units/../../catalog.md')).toBeNull();
    expect(sourceReaderId(base+'/catalog.md')).toBeNull();
  });
  it('renders original PDF and archived images with their knowledge-library scope and page fragment',()=>{
    const pdf='03-Archive/books/'+'a'.repeat(64)+'/original.pdf',picture=base+'/assets/001-figure.png';
    const html=renderToString(<CardMarkdown libraryId="finance" body={`[查看原书](../${pdf}#page=12)\n\n![图一](${picture})`}/>);
    expect(html).toContain(encodeURIComponent(pdf));expect(html).toContain('library_id=finance#page=12');expect(html).toContain(encodeURIComponent(picture));
    expect(renderToString(<CardSources sources={[pdf]} libraryId="finance" onNavigate={()=>{}}/>)).toContain('查看归档原书');
    for(const unsafe of [base+'/../secret.md',base+'/units/c0001-p001.md','03-Archive/books/../../01-Cards/secret.md','javascript:alert(1)'])expect(cardMarkdownUrl(unsafe)).toBe('');
  });
  it("hides raw and escaped unit markers without removing the knowledge or formulas", () => {
    const body = "## 核心思想\n\n<!-- unit: core-thesis -->\n\n融资改变选择。\n\n&lt;!-- unit: boundary --&gt;\n\n条件为 x < 3。";
    const html = renderToString(<CardMarkdown body={body} />);
    expect(html).not.toContain("unit:");
    expect(html).toContain("融资改变选择");
    expect(html).toContain("x &lt; 3");
    expect(readableCardBody(body)).toContain("## 核心思想");
    expect(readableCardExcerpt("核心思想 <! unit: core thesis 每轮繁荣。" )).toBe("核心思想 每轮繁荣。");
  });

  it("keeps a resized or moved window reachable after shrinking the viewport", () => {
    const frame = fitReaderFrame({ x: 1100, y: 600, width: 720, height: 800 }, { width: 390, height: 844 });
    expect(frame.x).toBeGreaterThanOrEqual(8);
    expect(frame.y).toBeGreaterThanOrEqual(8);
    expect(frame.x + frame.width).toBeLessThanOrEqual(382);
    expect(frame.y + frame.height).toBeLessThanOrEqual(836);
  });
  it("renders card bodies as GitHub-flavored Markdown", () => {
    const html = renderToString(
      <CardMarkdown body={"## 机制\n\n- 证据\n\n| 维度 | 内容 |\n| --- | --- |\n| A | B |"} />
    );

    expect(html).toContain("<h2>");
    expect(html).toContain("<li>");
    expect(html).toContain("<table>");
  });

  it("keeps each opened card in its own reader panel", () => {
    const html = renderToString(<CardReader cardIds={["card-a", "card-b"]} onClose={() => {}} />);

    expect(html).toContain('aria-label="正在阅读的知识卡片"');
    expect(html).toContain('class="card-reader-layer"');
    expect((html.match(/aria-label="关闭此卡片"/g) ?? [])).toHaveLength(2);
    expect((html.match(/title="拖动知识卡片"/g) ?? [])).toHaveLength(2);
  });
});
