import test from "node:test";
import assert from "node:assert/strict";
import { probeModelConnection, handleSettingsTest } from "../packages/nexogenesis-web-host/lib/settings-test.js";
import { handleSettingsGet } from "../packages/nexogenesis-web-host/lib/settings.js";
import { normalizeModelSettings } from "../packages/nexogenesis-tools/lib/model-providers.js";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

const config = (provider = "deepseek", extra = {}) => normalizeModelSettings({provider, ...extra});
function context(initial = config(), entries = []) {
  const keys = new Map(entries), reads = [];
  return { keys, reads, settings: { get: () => initial, update: () => assert.fail("test must not save settings") },
    credentials: { resolve: async ref => { reads.push(ref); return { value: keys.get(ref) }; },
      describe: async ref => ({configured: keys.has(ref)}), set: () => assert.fail("test must not save credentials") } };
}
const models = ids => Response.json({data:ids.map(id=>({id}))});

test("读取当前草稿与对应密钥，单次请求且不改保存配置", async () => {
  const ctx=context(config(), [["MOONSHOT_API_KEY","saved-kimi-key"]]); const requests=[];
  const result=await probeModelConnection(ctx,config("kimi"),{fetchImpl:async(url,init)=>{
    requests.push({url,...init}); return models(["kimi-k3","kimi-k3","future-model"]);
  }});
  assert.equal(requests.length,1);assert.equal(requests[0].url,"https://api.moonshot.cn/v1/models");
  assert.equal(requests[0].method,"GET");assert.equal(requests[0].body,undefined);assert.equal(requests[0].redirect,"error");
  assert.equal(requests[0].headers.authorization,"Bearer saved-kimi-key");
  assert.deepEqual(ctx.reads,["MOONSHOT_API_KEY"]);assert.equal(ctx.settings.get().provider,"deepseek");
  assert.deepEqual(result.models,["future-model","kimi-k3"]);assert.equal(result.model_listed,true);
  assert.match(result.message,/尚未验证实际回答能力/);assert.ok(!JSON.stringify(result).includes("saved-kimi-key"));
});

test("未保存密钥只用于本次测试，套餐目录地址独立且不激活原生路由",async()=>{
  const ctx=context();
  const result=await probeModelConnection(ctx,{...config("kimi_code_plan",{model:"kimi-for-coding-highspeed"}),api_key:"draft-code-key"},{
    fetchImpl:async(url,init)=>{assert.equal(url,"https://api.kimi.com/coding/v1/models");assert.equal(init.headers.authorization,"Bearer draft-code-key");return models(["kimi-for-coding-highspeed"]);}});
  assert.equal(result.model_listed,true);assert.deepEqual(ctx.reads,[]);assert.equal(ctx.keys.size,0);
});

test("自定义地址更换时不得将旧密钥发到新地址",async()=>{
  const ctx=context(config("custom",{base_url:"https://old.example/v1",model:"local"}),[["NEXO_CUSTOM_API_KEY","old-key"]]);
  const input=config("custom",{base_url:"https://new.example/v1",model:"local"});
  await assert.rejects(probeModelConnection(ctx,input,{fetchImpl:()=>assert.fail("must not send")}),/重新输入密钥/);
  assert.deepEqual(ctx.reads,[]);
  await probeModelConnection(ctx,{...input,api_key:"new-key"},{fetchImpl:async(_url,init)=>{assert.equal(init.headers.authorization,"Bearer new-key");return models(["local"]);}});
});

test("切换回已保存自定义服务可复用该端点密钥，尾斜线不改变目标",async()=>{
  const stored=config("custom",{base_url:"http://127.0.0.1:1234/v1",model:"local"});
  const ctx=context({...config(),provider_configs:{custom:stored}},[["NEXO_CUSTOM_API_KEY","local-key"]]);
  const result=await probeModelConnection(ctx,{...stored,base_url:stored.base_url+"/"},{fetchImpl:async(url)=>{assert.equal(url,"http://127.0.0.1:1234/v1/models");return models(["local"]);}});
  assert.equal(result.model_listed,true);
});

test("空模型可以先读目录；不自动替换目录中没有的专属型号",async()=>{
  const ctx=context();const fetchImpl=async()=>models(["public"]);
  const empty=await probeModelConnection(ctx,{...config("custom",{base_url:"https://local.example/v1",model:""}),api_key:"key"},{fetchImpl});
  assert.equal(empty.model,"");assert.equal(empty.model_listed,false);
  const absent=await probeModelConnection(ctx,{...config(),model:"private",api_key:"key"},{fetchImpl});
  assert.equal(absent.model,"private");assert.match(absent.message,/未列出所选模型/);
});

test("缺密钥、非法地址与不支持的套餐型号在网络请求前拒绝",async()=>{
  const fetchImpl=()=>assert.fail("must not send"),ctx=context();
  await assert.rejects(probeModelConnection(ctx,config(),{fetchImpl}),/API Key/);
  for(const base_url of ["http://remote.example/v1","https://secret:pass@example.org/v1","https://example.org/v1/chat/completions","https://example.org/v1?api_key=x"]){
    await assert.rejects(probeModelConnection(ctx,{...config("custom",{base_url,model:"test"}),api_key:"key"},{fetchImpl}));
  }
  await assert.rejects(probeModelConnection(ctx,{...config("kimi_code_plan",{model:"fake"}),api_key:"key"},{fetchImpl}),/尚未接入/);
});

test("网络与供应商失败不回显响应正文、密钥或网络错误中的秘密",async()=>{
  const ctx=context(),input={...config(),api_key:"secret-api-key"};
  for(const status of [401,403,404,429,500]){
    await assert.rejects(probeModelConnection(ctx,input,{fetchImpl:async()=>new Response("secret-api-key",{status})}),
      e=>!e.message.includes("secret-api-key")&&e.message.includes("HTTP "+status));
  }
  await assert.rejects(probeModelConnection(ctx,input,{fetchImpl:async()=>{throw new Error("secret-api-key");}}),e=>!e.message.includes("secret-api-key")&&/无法连接/.test(e.message));
});

test("模型目录必须是有效有限响应，不接受HTML、错误格式与超大内容",async()=>{
  const ctx=context(),input={...config(),api_key:"key"};
  for(const body of ["<html>login</html>",JSON.stringify({models:["a"]}),"x".repeat(1_000_001)]){
    await assert.rejects(probeModelConnection(ctx,input,{fetchImpl:async()=>new Response(body)}),/目录|Base URL/);
  }
  const ids=Array.from({length:502},(_,i)=>"model-"+i);
  const result=await probeModelConnection(ctx,{...input,model:"model-501"},{fetchImpl:async()=>models([...ids,"bad\nid","key-echo"])});
  assert.equal(result.models.length,500);assert.equal(result.truncated,true);assert.equal(result.model_listed,true);
  assert.ok(!result.models.includes("bad\nid"));assert.ok(!result.models.includes("key-echo"));
});

test("超时和主动取消终止单次请求，不自动重试",async()=>{
  const ctx=context(),input={...config(),api_key:"key"};let calls=0;
  const fetchImpl=async(_url,{signal})=>{calls++;return new Promise((_,reject)=>{if(signal.aborted)reject(new Error("aborted"));else signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});});};
  await assert.rejects(probeModelConnection(ctx,input,{fetchImpl,timeoutMs:10}),/取消|15 秒/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(probeModelConnection(ctx,input,{fetchImpl,signal:controller.signal}),/取消|15 秒/);
  assert.equal(calls,2);
});

test("测试能力公开但不回显任何凭据",async()=>{
  const ctx=context(config(),[["DEEPSEEK_API_KEY","saved-secret"]]);
  const res={writeHead(){},end(body){this.body=JSON.parse(body);}};
  await handleSettingsGet(ctx,{},res);
  assert.equal(res.body.connection_test_version,1);assert.ok(!JSON.stringify(res.body).includes("saved-secret"));
});

test("API 同时只允许一个测试，结束后可再试",async()=>{
  const ctx=context(), original=globalThis.fetch;let release, entered;
  const started=new Promise(resolve=>{entered=resolve;});
  globalThis.fetch=async()=>{entered();return new Promise(resolve=>{release=()=>resolve(models(["deepseek-v4-flash"]));});};
  const request=()=>Object.assign(Readable.from([Buffer.from(JSON.stringify({...config(),api_key:"key"}))]),{headers:{"content-type":"application/json"}});
  const response=()=>Object.assign(new EventEmitter(),{writeHead(){},end(body){this.data=JSON.parse(body);}});
  try{
    const res=response(),running=handleSettingsTest(ctx,request(),res);await started;
    await assert.rejects(handleSettingsTest(ctx,request(),response()),/已有连接测试/);
    release();await running;assert.equal(res.data.model_listed,true);
    globalThis.fetch=async()=>models(["deepseek-v4-flash"]);
    await handleSettingsTest(ctx,request(),response());
  }finally{globalThis.fetch=original;}
});
