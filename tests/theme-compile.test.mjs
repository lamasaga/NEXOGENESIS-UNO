import test from 'node:test';
import assert from 'node:assert/strict';
import {pipelineStageForMessage,compileCommand} from '../packages/nexogenesis-web-host/lib/chat.js';
import {COMPILE_HINTS,parseCompileCommand} from '../packages/nexogenesis-tools/lib/compile-options.js';
// Former theme compilation execution has been removed. Every supported alias
// must enter the same book picker without native legacy pipeline dispatch.
for(const command of ['/compile','/编译','/主题编译','/theme-compile'])test(command+' routes to the current book picker',async()=>{
 assert.equal(pipelineStageForMessage(command),undefined);
 assert.deepEqual(await compileCommand({},'',parseCompileCommand(command),{}),{action:'select_compile_sources',notes:''});
});
test('compile hints expose the five explicit equal-weight knowledge directions',()=>{
 assert.deepEqual(COMPILE_HINTS.map(item=>item.label),['自由式编译','实体与案例','机制与方法','观念与争议','概念与模型']);
 assert.equal(new Set(COMPILE_HINTS.map(item=>item.id)).size,COMPILE_HINTS.length);
 for(const item of COMPILE_HINTS)assert.ok(item.prompt.length>=30,`${item.label} should carry an actionable visible prompt`);
});
