import test from 'node:test';
import assert from 'node:assert/strict';
import {pipelineStageForMessage,compileCommand} from '../packages/nexogenesis-web-host/lib/chat.js';
import {parseCompileCommand} from '../packages/nexogenesis-tools/lib/compile-options.js';
// Former theme compilation execution has been removed. Every supported alias
// must enter the same book picker without native legacy pipeline dispatch.
for(const command of ['/compile','/编译','/主题编译','/theme-compile'])test(command+' routes to the current book picker',async()=>{
 assert.equal(pipelineStageForMessage(command),undefined);
 assert.deepEqual(await compileCommand({},'',parseCompileCommand(command),{}),{action:'select_compile_sources',notes:''});
});
