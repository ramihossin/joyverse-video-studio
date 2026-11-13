import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const out="browser-agent-output"; await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const responses=[],failures=[],errors=[];
page.on("response",async r=>{if(!/api|generate|video|task|captcha|challenge/i.test(r.url()))return;let b="";try{b=(await r.text()).slice(0,1600)}catch{}responses.push({url:r.url(),method:r.request().method(),status:r.status(),body:b})});
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>errors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
const inspect=()=>page.evaluate(()=>{
 const desc=e=>({tag:e.tagName.toLowerCase(),type:e.getAttribute("type"),name:e.getAttribute("name"),id:e.id||null,role:e.getAttribute("role"),placeholder:e.getAttribute("placeholder"),ariaLabel:e.getAttribute("aria-label"),text:(e.innerText||e.textContent||"").trim().slice(0,180),value:"value"in e?e.value:null,disabled:"disabled"in e?e.disabled:null,options:e.tagName==="SELECT"?[...e.options].map(o=>({value:o.value,text:(o.textContent||"").trim()})):undefined});
 return {title:document.title,url:location.href,text:(document.body?.innerText||"").slice(0,5000),controls:[...document.querySelectorAll("input,textarea,select,button,[role=button],[role=radio],[role=tab]")].map(desc),forms:[...document.forms].map(f=>({action:f.action,method:f.method,controls:f.elements.length}))};
});
try{
 await page.goto("https://moveframe.app/ai-video-generator-no-sign-up/",{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(1800);
 const before=await inspect();
 const toggle=page.getByRole("button",{name:/no photo\? type a scene/i});
 await toggle.click();
 await page.waitForTimeout(1000);
 const after=await inspect();
 await page.screenshot({path:`${out}/moveframe-text-mode.png`,fullPage:true});
 await writeFile(`${out}/moveframe-text-mode.json`,JSON.stringify({before,after,responses,failures,errors},null,2));
 console.log(JSON.stringify({beforeControls:before.controls,afterControls:after.controls,afterText:after.text.slice(0,3000),responses,failures,errors},null,2));
}catch(e){await writeFile(`${out}/moveframe-text-mode-error.txt`,String(e?.stack||e));console.error(e);process.exitCode=1}
finally{await browser.close()}
