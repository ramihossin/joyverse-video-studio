import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const out="pika-ui-inspection";
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const errors=[];
page.on("pageerror",e=>errors.push(String(e?.message||e).slice(0,500)));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text().slice(0,500))});
try{
 await page.goto("https://pika-labs-pika-h3-flex.hf.space",{waitUntil:"domcontentloaded",timeout:90000});
 await page.waitForTimeout(9000);
 const state=await page.evaluate(()=>({
  url:location.href,title:document.title,
  text:(document.body?.innerText||"").slice(0,12000),
  frames:[...document.querySelectorAll("iframe")].map(f=>({src:f.src,title:f.title})),
  fields:[...document.querySelectorAll("input,textarea,select,button,[role=button]")].map(e=>({
   tag:e.tagName.toLowerCase(),type:e.type||null,id:e.id||null,name:e.name||null,
   placeholder:e.getAttribute("placeholder"),aria:e.getAttribute("aria-label"),
   label:e.labels?.[0]?.innerText||null,
   text:(e.innerText||e.textContent||"").trim().slice(0,120),
   value:"value"in e?String(e.value).slice(0,100):null,
   disabled:"disabled"in e?e.disabled:null
  })).slice(0,150)
 }));
 await page.screenshot({path:out+"/pika-space.png",fullPage:true});
 console.log("PIKA_UI",JSON.stringify({state,errors},null,2));
}catch(e){console.error("INSPECT_ERROR",String(e?.stack||e));process.exitCode=1}
finally{await browser.close()}
