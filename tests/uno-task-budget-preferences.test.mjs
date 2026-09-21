import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_PREFERENCES,freezePreferences,readPreferences,savePreferences,validatePreferences} from '../packages/nexogenesis-tools/lib/uno/preferences.js';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'uno-task-budget-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,freeze:input=>freezePreferences(root,input,'unknown',root),file:join(root,'.nexogenesis/knowledge-processing.json')};}
const profile={orchestration_profile:'bounded-workflow-v1'};

test('bounded 单任务可冻结 4、6、2000 次预算，不改全局默认或创建设置文件',async t=>{
 const f=fixture(t);for(const budget_calls of [4,6,2000])assert.equal((await f.freeze({...profile,budget_calls})).preferences.budget_calls,budget_calls);
 assert.equal(readPreferences(f.root).budget_calls,120);assert.equal(existsSync(f.file),false);
});
test('历史、execution_profile 与近似名称均保留最少10次，不能误开单任务例外',async t=>{
 const f=fixture(t);for(const flags of [{},{execution_profile:'evidence-pack-v1'},{orchestration_profile:'bounded-workflow-v2'}])await assert.rejects(f.freeze({...flags,budget_calls:6}),/10–2000/);
 assert.equal((await f.freeze({budget_calls:10})).preferences.budget_calls,10);
});
test('bounded 预算仍必须为 4..2000 整数，拒绝字符串、null、非有限值',async t=>{
 const f=fixture(t);for(const budget_calls of [3,2001,4.5,'6',null,NaN,Infinity])await assert.rejects(f.freeze({...profile,budget_calls}),/4–2000/);
});
test('保存全局偏好始终至少10次，即使输入附带 bounded profile 也不能降低',t=>{
 const f=fixture(t);savePreferences(f.root,{...readPreferences(f.root),budget_calls:150});const before=readFileSync(f.file);
 assert.throws(()=>savePreferences(f.root,{...readPreferences(f.root),...profile,budget_calls:4}),/10–2000/);
 assert.throws(()=>validatePreferences({...DEFAULT_PREFERENCES,...profile,budget_calls:6}),/10–2000/);
 assert.deepEqual(readFileSync(f.file),before);assert.equal(readPreferences(f.root).budget_calls,150);
});
test('单任务小预算仍执行清理、交付与图片选项验证，不跳过其他字段',async t=>{
 const f=fixture(t);for(const fields of [{cleaning:'unknown'},{compile_quality:'maximum'},{delivery:'publish'},{external_images:'false'}])await assert.rejects(f.freeze({...profile,budget_calls:6,...fields}),/知识处理选项无效/);
 await assert.rejects(f.freeze({...profile,budget_calls:6,notes:'x'.repeat(128001)}),/传输大小限制/);
 assert.equal(existsSync(f.file),false);
});
test('未覆盖预算时继承已保存值；本次4次与其他选项只存在于冻结任务中',async t=>{
 const f=fixture(t);const saved=savePreferences(f.root,{...readPreferences(f.root),budget_calls:180,cleaning:'retain',compile_quality:'refine-each-card-v1'}),before=readFileSync(f.file);
 assert.equal((await f.freeze(profile)).preferences.budget_calls,180);
 const result=await f.freeze({...profile,budget_calls:4,delivery:'manual',compile_quality:'standard'});assert.equal(result.preferences.budget_calls,4);assert.equal(result.preferences.delivery,'manual');assert.equal(result.preferences.cleaning,'retain');assert.equal(result.preferences.compile_quality,'standard');assert.equal(result.settings_revision,saved.revision);
 assert.deepEqual(readFileSync(f.file),before);
});
