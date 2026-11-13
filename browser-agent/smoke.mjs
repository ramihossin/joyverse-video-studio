import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const out="browser-agent-output"; await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const responses=[],failures=[],errors=[],downloads=[];
page.on("response",async r=>{if(!/api|generate|video|task|captcha|challenge/i.test(r.url()))return;let b="";try{b=(await r.text()).slice(0,1400)}catch{}responses.push({url:r.url(),method:r.request().method(),status:r.status(),body:b})});
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>errors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
page.on("download",async d=>{const p=await d.path();downloads.push({name:d.suggestedFilename(),path:p,url:d.url()})});
const inspect=()=>page.evaluate(()=>({url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,5000),controls:[...document.querySelectorAll("input,textarea,select,button,[role=button]")].map(e=>({tag:e.tagName.toLowerCase(),type:e.getAttribute("type"),id:e.id||null,placeholder:e.getAttribute("placeholder"),text:(e.innerText||e.textContent||"").trim().slice(0,120),value:"value"in e?e.value:null,disabled:"disabled"in e?e.disabled:null}))}));
try{
 await page.goto("https://www.freevideoai.org/",{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(2500);
 const initial=await inspect();
 await page.screenshot({path:`${out}/freevideoai-before.png`,fullPage:true});
 const textarea=page.locator("textarea").first();
 if(await textarea.count()) await textarea.fill("A tiny turquoise cartoon dragon with golden wings gently waves in a bright colorful flower garden, polished 3D animation, one simple continuous action, warm light, friendly preschool style.");
 const ready=await inspect();
 await writeFile(`${out}/freevideoai-before.json`,JSON.stringify({initial,ready},null,2));
 console.log("READY",JSON.stringify({url:ready.url,text:ready.text.slice(0,1800),controls:ready.controls},null,2));
 if(/captcha|verification|checking your browser|access denied/i.test(ready.text)){
  await writeFile(`${out}/freevideoai-blocked.json`,JSON.stringify({ready,responses,failures,errors},null,2));
 } else {
  const b=page.getByRole("button",{name:/generate for free/i}).first();
  if(await b.count()&&await b.isEnabled()){
   await b.click();
   const start=Date.now();
   while(Date.now()-start<90000){
    await page.waitForTimeout(3000);
    const state=await inspect();
    const videos=await page.locator("video").evaluateAll(v=>v.map(x=>({src:x.currentSrc||x.src,readyState:x.readyState,duration:x.duration})));
    if(videos.some(v=>v.src&&v.readyState>=2)||/download/i.test(state.text)){
     await page.screenshot({path:`${out}/freevideoai-after.png`,fullPage:true});
     await writeFile(`${out}/freevideoai-result.json`,JSON.stringify({state,videos,responses,failures,errors,downloads},null,2));break;
    }
   }
  }
 }
 await page.screenshot({path:`${out}/freevideoai-final.png`,fullPage:true});
 await writeFile(`${out}/freevideoai-final.json`,JSON.stringify({final:await inspect(),responses,failures,errors,downloads},null,2));
}catch(e){await writeFile(`${out}/freevideoai-error.txt`,String(e?.stack||e));console.error(e);process.exitCode=1}
finally{await browser.close()}
