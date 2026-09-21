import {describe,expect,it} from 'vitest';
import {deferCurrentQueueItem,queueProgress,type UnoUnassignedQueueState} from './unassignedQueue';

function queue(overrides:Partial<UnoUnassignedQueueState>={}):UnoUnassignedQueueState{
  return {version:2,libraryId:'library-1',mode:'recompile',targets:[
    {id:'a',kind:'unassigned',revision:'r-a'},
    {id:'b',kind:'repair',revision:'r-b'},
    {id:'c',kind:'repair',revision:'r-c'},
  ],index:1,currentJobId:'job-b',currentRequestId:'request-b',status:'running',
    results:[{cardId:'a',jobId:'job-a',status:'completed',detail:'done'}],message:'running',startedAt:'2026-09-19T00:00:00.000Z',...overrides};
}

describe('unassigned card queue progress',()=>{
  it('reports the current card and keeps partial settlements visible',()=>{
    const state=queue({index:2,results:[
      {cardId:'a',jobId:'job-a',status:'completed',detail:'done'},
      {cardId:'b',jobId:'job-b',status:'partial',detail:'needs attention'},
    ]});
    expect(queueProgress(state)).toEqual({completed:2,total:3,remaining:1,currentCardId:'c',attention:1});
  });

  it('允许保留当前失败项并继续下一项，避免重复打开同一停点',()=>{
    const paused=queue({index:1,currentJobId:'job-b',status:'paused',results:[{cardId:'a',jobId:'job-a',status:'completed',detail:'完成'}]});
    const next=deferCurrentQueueItem(paused);
    expect(next).toMatchObject({index:2,currentJobId:null,currentRequestId:null,status:'running'});
    expect(next.results.at(-1)).toMatchObject({cardId:'b',jobId:'job-b',status:'partial'});
    expect(next.message).toContain('准备处理 3 / 3');
  });

  it('clamps completed queues instead of exposing a phantom next card',()=>{
    expect(queueProgress(queue({index:3,currentJobId:null,status:'completed',results:[
      {cardId:'a',jobId:'job-a',status:'completed',detail:'done'},
      {cardId:'b',jobId:'job-b',status:'completed',detail:'done'},
      {cardId:'c',jobId:'job-c',status:'completed',detail:'done'},
    ]}))).toEqual({completed:3,total:3,remaining:0,currentCardId:null,attention:0});
  });
});
