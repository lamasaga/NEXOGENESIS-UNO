import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {locateQuote} from '../packages/nexogenesis-tools/lib/uno/quote-locator.js';

const quote='要点：自由市场会出现更高的工资';
const pdfText='要点：自\n由市场会出现\n更高的工资';
const length=text=>Array.from(text).length;

test('中文PDF行换行只影响排版：保存精确原句和原文Unicode位置',()=>{
  const prefix='😀引言：',source=prefix+pdfText+'。';
  const match=locateQuote(source,quote);
  assert.equal(match.quote,pdfText);assert.equal(match.submitted_quote,quote);assert.equal(match.match_kind,'layout-equivalent');
  assert.equal(match.start,length(prefix));assert.equal(match.end,length(prefix+pdfText));
  assert.equal(Array.from(source).slice(match.start,match.end).join(''),match.quote);
  assert.equal(locateQuote('自由市场','自 由\n市场').quote,'自由市场');
});
test('Latin和数字边界保留，不删非空白字、标点或否定词，也不做兼容字符转换',()=>{
  for(const [source,requested] of [['now here','nowhere'],['1 234','1234'],['收入 10 元','收入10元'],
    ['本章不支持普遍结论','本章支持普遍结论'],['工资没有上涨','工资上涨'],['自-由市场','自由市场'],['价格，工资','价格工资'],['Ａ股','A股'],['Market','market']])
    assert.equal(locateQuote(source,requested),null,`${source} must not become ${requested}`);
  assert.equal(locateQuote('now\n\t here','now here').quote,'now\n\t here');
  assert.equal(locateQuote('工资\n不会上涨','工资不会上涨').quote,'工资\n不会上涨');
});

test('emoji与增补汉字不破坏Unicode偏移，不能用半个surrogate匹配整个字符',()=>{
  const match=locateQuote('😀😀\n𠀀\n市场','𠀀市场');
  assert.equal(match.start,3);assert.equal(match.end,7);assert.equal(match.quote,'𠀀\n市场');
  assert.equal(locateQuote('😀市场','\uDE00'),null);
});

test('重复原句只定位实际交付的那一处；未知位置的旧片段不能擅自选第一处',()=>{
  const source=pdfText+'。未交付的间隔。'+pdfText,prefix=source.slice(0,source.lastIndexOf(pdfText));
  const match=locateQuote(source,quote,{intervals:[[length(prefix),length(source)]]});
  assert.equal(match.start,length(prefix));assert.equal(match.quote,pdfText);
  assert.equal(locateQuote(source,pdfText,{layoutEquivalent:false,unique:true}),null);
});

test('标准化不能跨过未交付空白或把分离阅读区间拼成完整证据',()=>{
  assert.equal(locateQuote('自由\n市场','自由市场',{intervals:[[0,2],[3,5]]}),null);
  assert.equal(locateQuote('自由\n市场','自由市场',{intervals:[]}),null);
  assert.equal(locateQuote('自由\n市场','自由市场',{intervals:[[0,4]]}),null);
  assert.equal(locateQuote('自由\n市场','自由市场',{intervals:[[0,5]]}).quote,'自由\n市场');
});
