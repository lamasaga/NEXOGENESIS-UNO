import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { anchorPosition, highlighted } from './readerAnnotations';
import type { ReaderAnchor } from '../api/client';
const anchor:ReaderAnchor={block:'原句所在段落',block_start:0,quote:'原句',start:0,end:2,before:'前段\n\n',after:'\n\n后段'};
describe('personal annotation anchors',()=>{
  it('relocates a unique unchanged paragraph after surrounding edits',()=>expect(anchorPosition('新增段落\n\n原句所在段落\n\n后段',anchor)).toBe(6));
  it('leaves changed or ambiguous paragraphs unplaced',()=>{expect(anchorPosition('原句已改动',anchor)).toBeNull();expect(anchorPosition('原句所在段落\n原句所在段落',anchor)).toBeNull();});
  it('uses surrounding evidence to distinguish identical paragraphs',()=>expect(anchorPosition('原句所在段落\n\n前段\n\n原句所在段落\n\n后段',anchor)).toBe(12));
  it('highlights text spanning emphasis without destroying links or markup',()=>{const html=renderToStaticMarkup(<p>{highlighted(<>不同的<strong>动机</strong>，也可能。</>,[{start:2,end:5}])}</p>);expect(html).toContain('<strong><mark>动机</mark></strong>');expect(html).toContain('<mark>的</mark>');});
});
