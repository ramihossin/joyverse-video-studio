import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const out="browser-agent-output"; await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const responses=[],failures=[],errors=[];
page.on("response",async r=>{if(!/api|generate|video|task|captcha|challenge/i.test(r.url()))return;let b="";try{b=(await r.text()).slice(0,1200)}catch{}responses.push({url:r.url(),method:r.request().method(),status:r.status(),body:b})});
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>errors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
try {
 await page.goto("https://yovid.ai/ai-video-generator/text-to-video",{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(2000);
 const before=await page.evaluate(()=>({
  title:document.title,url:location.href,text:(document.body?.innerText||"").slice(0,5000),
  controls:[...document.querySelectorAll("input,textarea,select,button,[role=button],[role=radio],[role=tab]")].map(e=>({
   tag:e.tagName.toLowerCase(),type:e.getAttribute("type"),name:e.getAttribute("name"),id:e.id||null,role:e.getAttribute("role"),
   placeholder:e.getAttribute("placeholder"),ariaLabel:e.getAttribute("aria-label"),
   text:(e.innerText||e.textContent||"").trim().slice(0,140),
   value:"value"in e?e.value:null,disabled:"disabled"in e?e.disabled:null,
   options:e.tagName==="SELECT"?[...e.options].map(o=>({value:o.value,text:(o.textContent||"").trim()})):undefined
  })),
  videos:[...document.querySelectorAll("video")].map(v=>({src:v.currentSrc||v.src, poster:v.poster, controls:v.controls})),
  forms:[...document.forms].map(f=>({action:f.action,method:f.method,count:f.elements.length}))
 }));
 await page.screenshot({path:`${out}/yovid-composer-inspection.png`,fullPage:true});
 await writeFile(`${out}/yovid-composer-inspection.json`,JSON.stringify({before,responses,failures,errors},null,2));
 console.log(JSON.stringify({title:before.title,url:before.url,text:before.text,controls:before.controls,videos:before.videos,forms:before.forms,responses,failures,errors},null,2));
} catch(e) {
 await writeFile(`${out}/yovid-inspection-error.txt`,String(e?.stack||e));console.error(e);process.exitCode=1;
} finally {await browser.close()}
