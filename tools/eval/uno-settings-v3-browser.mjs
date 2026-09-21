import { chromium } from 'file:///C:/Users/MECHREVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { mkdirSync,writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const output=new URL('../../.nexogenesis/uno-v3-browser/',import.meta.url);mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
async function open(base){await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'知识处理',exact:true}).click();await page.getByLabel('知识处理长期偏好').waitFor();}
try{
 await open('http://127.0.0.1:5393');
 await page.getByLabel('知识处理长期偏好').fill('合成验证：保留作者观点、关键案例与反对意见。'+Date.now());
 await page.getByLabel('审核后的发布方式').selectOption('manual');
 await page.getByRole('button',{name:'保存更改',exact:true}).click();await page.getByText('更改已保存',{exact:true}).waitFor();
 let pref=await page.request.get('http://127.0.0.1:5393/api/uno/preferences').then(r=>r.json());assert.equal(pref.delivery,'manual');assert.match(pref.prompt,/关键案例/);
 await page.getByLabel('知识处理长期偏好').fill('这条修改应被取消');await page.getByRole('button',{name:'取消',exact:true}).click();
 await open('http://127.0.0.1:5393');assert.equal(await page.getByLabel('知识处理长期偏好').inputValue(),pref.prompt);
 await page.screenshot({path:new URL('settings-desktop.png',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:new URL('settings-mobile.png',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'取消',exact:true}).click();
 const second=await page.evaluate(async()=>{const {token}=await fetch('/api/security/session').then(r=>r.json());const headers={'Content-Type':'application/json','X-Nexogenesis-CSRF':token};const response=await fetch('/api/instances',{method:'POST',headers,body:JSON.stringify({name:'偏好隔离测试库'})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));await fetch('/api/instances/switch',{method:'POST',headers,body:JSON.stringify({instance_id:value.instance.id})});return value.instance.id;});
 await open('http://127.0.0.1:5393');assert.equal(await page.getByLabel('知识处理长期偏好').inputValue(),'');
 // Formal UNO: render and read only. No user preference or knowledge writes.
 await open('http://127.0.0.1:3093');assert.ok(await page.getByText('主知识库',{exact:true}).count());
 await page.screenshot({path:new URL('uno-live-settings.png',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
 assert.deepEqual(errors,[]);const result={passed:true,checks:['preferences-save','cancel-keeps-saved','manual-delivery','library-isolation','desktop','390px','formal-UNO-readonly'],second,errors};writeFileSync(new URL('result.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){await page.screenshot({path:new URL('failure.png',output).pathname.replace(/^\/([A-Z]:)/,'$1')});throw e;}finally{await browser.close();}
