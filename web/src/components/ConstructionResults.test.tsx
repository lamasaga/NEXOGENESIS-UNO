import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConstructionResults} from './ConstructionResults';
import type {UnoJob} from '../api/client';

it('成果仅来自正式发布收据，草稿不计数，同一卡片重复回执不重复展示',()=>{
  const outcome={id:'a',title:'价格机制',kind:'relation' as const};
  const job={receipts:[{staged:true,construction_outcomes:[{id:'draft',title:'未发布草稿',kind:'card'}]},{construction_outcomes:[outcome]},{construction_outcomes:[outcome]}]} as unknown as UnoJob;
  const html=renderToStaticMarkup(<ConstructionResults job={job} onOpenCard={()=>{}}/>);
  expect(html).not.toContain('未发布草稿');expect(html.match(/价格机制/g)).toHaveLength(1);expect(html).toContain('涉及 1 张卡片');
});

it('关系编织失败时分开已结算成果与未写入候选',()=>{
  const rounds=Array.from({length:6},(_,index)=>({round:index+1,batch_index:index,phase:'isolated' as const,focus_ids:['card-'+(index+1)],status:index===3?'reviewed-independent':'published',published:index===3?[]:['card-'+(index+1)]}));
  const job={status:'ended',batch_index:6,batches:Array.from({length:7},(_,index)=>['card-'+(index+1),'endpoint']),relation_weaving:{contract:'incremental-relation-weaving-v1',rounds},construction_results:{3:{'card-4':{id:'card-4',status:'unchanged',note:'没有可靠关系，保留独立。'}}},last_error:{message:'关系端点超出范围。'},direct_work:{6:{repair:{decisions:[{id:'card-7',status:'proposed',note:'待发布',changes:{relations:[{target:'endpoint',type:'example',note:'中国城市经验作为框架例证。'}]}}]}}},receipts:[]} as unknown as UnoJob;
  const html=renderToStaticMarkup(<ConstructionResults job={job} onOpenCard={()=>{}}/>);
  expect(html).toContain('已结算 6 轮');expect(html).toContain('5 轮产生正式关系写入');expect(html).toContain('1 轮比较后未建立关系');
  expect(html).toContain('第 7 轮未结算，没有写入正式知识');expect(html).toContain('前 6 轮已保存成果不受影响');
  expect(html).toContain('保留的未发布候选');expect(html).toContain('card-7 —例证→ endpoint');
});

it('随机关系发现明确显示无候选轮次没有调用模型',()=>{
  const job={status:'completed',batch_index:0,batches:[],relation_weaving:{contract:'random-focus-semantic-retrieval-v2',rounds:[
    {round:1,phase:'random',attempt:1,focus_ids:['focus'],status:'no-selection',published:[]}
  ]},receipts:[]} as unknown as UnoJob;
  const html=renderToStaticMarkup(<ConstructionResults job={job} onOpenCard={()=>{}}/>);
  expect(html).toContain('1 轮未召回候选且未调用模型');expect(html).toContain('未召回候选 · 未调用模型');
});

it('关系编织显示换端点重试与有界尝试结束',()=>{
  const job={status:'partial',batch_index:1,batches:[['focus','a'],['focus','b']],relation_weaving:{contract:'incremental-relation-weaving-v1',rounds:[
    {round:1,batch_index:0,phase:'isolated',attempt:1,focus_ids:['focus'],status:'deferred',published:[]},
    {round:2,batch_index:1,phase:'isolated',attempt:2,focus_ids:['focus'],status:'deferred-exhausted',published:[]}
  ]},construction_results:{0:{focus:{id:'focus',status:'deferred',note:'第一组端点不足。'}},1:{focus:{id:'focus',status:'deferred',note:'第二组端点仍不足。'}}},receipts:[]} as unknown as UnoJob;
  const html=renderToStaticMarkup(<ConstructionResults job={job} onOpenCard={()=>{}}/>);
  expect(html).toContain('2 轮明确延期');expect(html).toContain('更换端点后继续');expect(html).toContain('两组端点均未通过，保留待办');expect(html).toContain('本焦点第 2 次有界尝试');
});
