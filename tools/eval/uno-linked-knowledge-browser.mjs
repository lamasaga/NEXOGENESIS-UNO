// Browser plugin not available. Exercise real isolated host APIs with bundled Playwright.
import { chromium } from 'file:///C:/Users/MECHREVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const origin='http://127.0.0.1:5393', fixture=await fetch('http://127.0.0.1:5394/fixture').then(r=>r.json());
const token=await fetch(origin+'/api/security/session').then(r=>r.json()).then(v=>v.token);
async function api(url,method='GET',body){const r=await fetch(origin+url,{method,headers:{'Content-Type':'application/json','X-Nexogenesis-CSRF':token},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();}
await api('/api/projects');const project=(await api('/api/projects')).projects[0];
let instances=await api('/api/instances');
if(instances.instances.length===1){await api('/api/instances','POST',{name:'组织与制度'});await api('/api/instances','POST',{name:'历史与案例'});}
instances=await api('/api/instances');
await api(`/api/projects/${project.id}/knowledge`,'PUT',{knowledge_instance_ids:[instances.active_instance_id]});
const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
async function open(){await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'思维体表达',exact:true}).click();await page.getByRole('group',{name:'项目关联知识库'}).waitFor();}
try{
 await page.goto(origin,{waitUntil:'networkidle'});assert.equal(await page.title(),'NEXOGENESIS-UNO');await open();
 const group=page.getByRole('group',{name:'项目关联知识库'});
 await group.getByRole('checkbox',{name:/组织与制度/}).check();await group.getByRole('checkbox',{name:/历史与案例/}).check();
 await page.screenshot({path:fixture.root+'/linked-desktop.png'});
 await page.getByRole('button',{name:'保存更改',exact:true}).click();await page.getByText('更改已保存',{exact:true}).waitFor();
 assert.equal((await api(`/api/projects/${project.id}/knowledge`)).knowledge_instance_ids.length,3);
 await page.getByRole('button',{name:'关闭设置',exact:true}).click();await open();assert.equal(await group.getByRole('checkbox',{checked:true}).count(),3);
 await group.getByRole('checkbox',{name:/历史与案例/}).uncheck();await page.getByRole('button',{name:'取消',exact:true}).click();await open();assert.equal(await group.getByRole('checkbox',{checked:true}).count(),3);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:fixture.root+'/linked-mobile.png'});
 const layout=await page.evaluate(()=>{const shell=document.querySelector('.settings-shell'),content=document.querySelector('.settings-content');return {viewport:innerWidth,backgroundScrollWidth:document.documentElement.scrollWidth,settingsWidth:shell.getBoundingClientRect().width,contentWidth:content.clientWidth,contentScrollWidth:content.scrollWidth}}); assert.ok(layout.settingsWidth<=390 && layout.contentScrollWidth<=layout.contentWidth);
 for(const box of await group.getByRole('checkbox').all())await box.uncheck();
 await page.getByText(/未关联知识库：回答将不检索库内资料/).waitFor();
 await page.getByRole('button',{name:'保存更改',exact:true}).click();await page.getByText('更改已保存',{exact:true}).waitFor();
 await page.reload({waitUntil:'networkidle'});await open();assert.equal(await group.getByRole('checkbox',{checked:true}).count(),0);
 assert.deepEqual((await api(`/api/projects/${project.id}/knowledge`)).knowledge_instance_ids,[]);
 assert.equal(await page.locator('vite-error-overlay').count(),0);assert.deepEqual(errors,[]);
 const result={passed:true,checks:['project API persistence','multiple selection','cancel','reopen','empty selection','reload','desktop','390px','console'],errors,layout,root:fixture.root};
 writeFileSync(fixture.root+'/linked-browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){await page.screenshot({path:fixture.root+'/linked-failure.png'});console.error((await page.locator('body').innerText()).slice(-2500));throw e;}finally{await browser.close();}
