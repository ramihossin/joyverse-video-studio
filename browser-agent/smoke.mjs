import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
const out="browser-agent-output"; await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const responses=[],failures=[],errors=[],downloads=[];
page.on("response",async r=>{if(!/api|generate|video|task|captcha|challenge/i.test(r.url()))return;let b="";try{b=(await r.text()).slice(0,1600)}catch{}responses.push({url:r.url(),method:r.request().method(),status:r.status(),body:b})});
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>errors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
page.on("download",async d=>{const path=await d.path();downloads.push({suggestedFilename:d.suggestedFilename(),path,url:d.url()})});
const inspect=()=>page.evaluate(()=>{
 const controls=[...document.querySelectorAll("input,textarea,select,button,[role=button]")].map(e=>({
  tag:e.tagName.toLowerCase(),type:e.getAttribute("type"),id:e.id||null,name:e.getAttribute("name"),
  placeholder:e.getAttribute("placeholder"),aria:e.getAttribute("aria-label"),
  text:(e.innerText||e.textContent||"").trim().slice(0,120),
  value:"value" in e?e.value:null,disabled:"disabled" in e?e.disabled:null,
  options:e.tagName==="SELECT"?[...e.options].map(o=>({value:o.value,text:(o.textContent||"").trim()})):undefined
 }));
 return {url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,5000),controls};
});
try{
 await page.goto("https://openmaker.si/free-text-to-video/",{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(2500);
 const initial=await inspect();
 await page.screenshot({path:`${out}/openmaker-before.png`,fullPage:true});
 const prompt=page.locator("textarea").first();
 if(await prompt.count()) await prompt.fill("A cheerful turquoise dragon with small golden wings gently waves beside a colorful flower garden, bright friendly 3D cartoon animation, smooth camera movement, one continuous simple action.");
 const ready=await inspect();
 await writeFile(`${out}/openmaker-before.json`,JSON.stringify({initial,ready},null,2));
 console.log("FORM_READY",JSON.stringify({url:ready.url,controls:ready.controls,text:ready.text.slice(0,2200)},null,2));
 const button=page.getByRole("button",{name:/generate video/i}).first();
 if(await button.count() && await button.isEnabled()){
  await button.click();
  const started=Date.now();
  while(Date.now()-started<90000){
   await page.waitForTimeout(3000);
   const status=await inspect();
   const video=await page.locator("video").evaluateAll(v=>v.map(x=>({src:x.currentSrc||x.src,readyState:x.readyState,duration:x.duration})));
   if(video.some(v=>v.src && v.readyState>=2) || /download/i.test(status.text)){
    await page.screenshot({path:`${out}/openmaker-after.png`,fullPage:true});
    await writeFile(`${out}/openmaker-result.json`,JSON.stringify({status,video,responses,failures,errors,downloads},null,2));
    break;
   }
   if(/verification|captcha|access denied|rate limit|sign in|log in/i.test(status.text)){
    await page.screenshot({path:`${out}/openmaker-blocked.png`,fullPage:true});
    await writeFile(`${out}/openmaker-blocked.json`,JSON.stringify({status,responses,failures,errors},null,2));
    break;
   }
  }
 }
 await page.screenshot({path:`${out}/openmaker-final.png`,fullPage:true});
 await writeFile(`${out}/openmaker-final.json`,JSON.stringify({final:await inspect(),responses,failures,errors,downloads},null,2));
}catch(e){await writeFile(`${out}/openmaker-error.txt`,String(e?.stack||e));console.error(e);process.exitCode=1}
finally{await browser.close()}
