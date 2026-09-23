import test from 'node:test';
import assert from 'node:assert/strict';
import { isContentSafetyRejection } from '../packages/nexogenesis-tools/lib/content-safety.js';
import { classifyCompileFailure } from '../packages/nexogenesis-web-host/lib/compile-recovery.js';

test('content safety recognizes explicit provider rejections, not generic 400 or account errors',()=>{
  for(const error of [{code:'MODEL_CONTENT_REJECTED'},{kind:'content-filter'},{error:{code:'content_filter'}},
    new Error('400 {"error":{"type":"invalid_request_error","message":"The request was rejected because it was considered high risk"}}')]){
    assert.equal(isContentSafetyRejection(error),true);
    assert.deepEqual(classifyCompileFailure(error),{category:'content_safety',automatic_recovery:false,retryable:false});
  }
  for(const message of ['400 invalid_request_error: missing field','401 Unauthorized','429 rate limit','500 engine overloaded','模型响应未完整结束：连接中断','This investment has high risk'])
    assert.equal(isContentSafetyRejection(new Error(message)),false);
  assert.equal(classifyCompileFailure({code:'MODEL_CONTENT_REJECTED'},true).category,'execution_stop');
});
