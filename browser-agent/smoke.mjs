import { chromium } from "playwright";
import { mkdir, writeFile, stat } from "node:fs/promises";

const out="browser-agent-output";
await mkdir(out,{recursive:true});
const prompt="Polished 3D animated family-friendly preschool scene. Adam, a cheerful small cartoon character with brown hair and a bright blue outfit, stands on a mossy path in a magical musical forest. Adam gently waves to the camera. Beside him, Zeno, a tiny turquoise dragon with a cream-colored belly, large amber eyes, small golden horns and golden wings, gives one happy wing flutter. Glowing flowers sway softly and tiny musical sparkles drift through the air. Bright saturated colors, warm gentle lighting, friendly expressive faces, smooth slow camera push-in, consistent character design, one continuous shot, no words, no subtitles, no logo.";
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const network=[], failures=[], pageErrors=[], consoleErrors=[];
page.on("request",r=>{if(r.method()==="POST"||/api|generate|video|task/i.test(r.url()))network.push({kind:"request",url:r.url(),method:r.method(),body:r.postData()||""})});
page.on("response",async r=>{if(r.request().method()!=="POST"&&!/api|generate|video|task/i.test(r.url()))return;let body="";try{body=(await r.text()).slice(0,2000)}catch{}network.push({kind:"response",url:r.url(),method:r.request().method(),status:r.status(),body})});
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>pageErrors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")consoleErrors.push(m.text())});
const evidence={target:"https://moveframe.app/ai-video-generator-no-sign-up/",prompt,startedAt:new Date().toISOString(),browser:"Playwright + Chromium on GitHub-hosted Linux runner",actions:[]};
try{
 await page.goto(evidence.target,{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(1800);
 await page.getByRole("button",{name:/no photo\? type a scene/i}).click();
 await page.waitForTimeout(700);
 const promptBox=page.locator("textarea").first();
 await promptBox.waitFor({state:"visible",timeout:10000});
 await promptBox.fill(prompt);
 for(const label of ["5s","16:9","Standard","Silent","Normal"]){
   const button=page.getByRole("button",{name:label,exact:true});
   if(await button.count()) { await button.click(); evidence.actions.push("selected "+label); }
 }
 const before=await page.evaluate(()=>({
   text:(document.body?.innerText||"").slice(0,3000),
   buttons:[...document.querySelectorAll("button")].filter(b=>/^(Make my video|5s|10s|9:16|16:9|1:1|Standard|HD|Max|Silent|Sound \+5|Auto camera|Still|Zoom in|Pan|Orbit|Subtle|Normal|Lively)$/.test((b.innerText||"").trim().replace(/\s+/g," "))).map(b=>({text:(b.innerText||"").trim(),disabled:b.disabled,ariaPressed:b.getAttribute("aria-pressed"),dataState:b.getAttribute("data-state"),className:String(b.className).slice(0,180)})),
   textarea:document.querySelector("textarea")?.value||""
 }));
 evidence.preSubmit=before;
 if(!before.text.includes("free, no watermark")&&!/first video free/i.test(before.text)) throw new Error("Free first-video entitlement was not visible; refusing to submit.");
 if(before.text.includes("verify you are human")||before.text.includes("Security verification")) throw new Error("Security verification appeared; stopping without bypass.");
 const submit=page.getByRole("button",{name:/make my video/i});
 if(await submit.isDisabled()) throw new Error("Generate button is disabled.");
 await page.screenshot({path:`${out}/moveframe-before-submit.png`,fullPage:true});
 const started=Date.now();
 await submit.click();
 evidence.actions.push("clicked Make my video once");
 evidence.submittedAt=new Date().toISOString();
 let lastState={};
 let challenge=false;
 let blocked=false;
 while(Date.now()-started<180000){
   await page.waitForTimeout(4000);
   lastState=await page.evaluate(()=>{
     const v=document.querySelector("video");
     const links=[...document.querySelectorAll("a,button")].map(e=>({tag:e.tagName,text:(e.innerText||e.getAttribute("aria-label")||"").trim().slice(0,100),href:e.href||null,disabled:"disabled"in e?e.disabled:null})).filter(x=>/download|save|mp4|result/i.test(x.text+" "+(x.href||"")));
     return {text:(document.body?.innerText||"").slice(0,5500),videoSrc:v?.currentSrc||v?.src||v?.querySelector("source")?.src||null,readyState:v?.readyState??null,duration:v?.duration??null,links};
   });
   evidence.lastState=lastState;
   if(/verify you are human|security verification|captcha|turnstile/i.test(lastState.text)){challenge=true;break;}
   if(/sign in|log in|create an account/i.test(lastState.text)&&!lastState.videoSrc){blocked=true;break;}
   if(lastState.videoSrc||lastState.links.some(x=>x.href&&/\.mp4|download/i.test(x.href))||lastState.links.some(x=>/download/i.test(x.text)&&x.disabled===false)) break;
   if(/failed|could not generate|something went wrong|try again/i.test(lastState.text)&&Date.now()-started>12000) break;
 }
 evidence.network=network; evidence.failures=failures; evidence.pageErrors=pageErrors; evidence.consoleErrors=consoleErrors;
 evidence.result=challenge?"Stopped at the site's security verification without bypass.":blocked?"The site requested an account; no login was attempted.":"Generation result observed or timed out.";
 await page.screenshot({path:`${out}/moveframe-after-submit.png`,fullPage:true});
 let videoUrl=lastState.videoSrc||null;
 if(!videoUrl){
   const link=lastState.links.find(x=>x.href&&/\.mp4|download/i.test(x.href));
   if(link) videoUrl=link.href;
 }
 if(videoUrl&&!videoUrl.startsWith("blob:")){
   const response=await page.request.get(videoUrl,{timeout:60000});
   evidence.downloadStatus=response.status();
   evidence.downloadContentType=response.headers()["content-type"]||"";
   if(response.ok()){
     const bytes=Buffer.from(await response.body());
     await writeFile(`${out}/joyverse-moveframe-test.mp4`,bytes);
     evidence.downloadedFile="joyverse-moveframe-test.mp4";
     evidence.fileSize=bytes.length;
     evidence.mp4Signature=bytes.subarray(4,8).toString();
   }
 } else {
   const dl=page.getByRole("button",{name:/download/i});
   if(await dl.count() && await dl.first().isEnabled()){
     try{
       const promise=page.waitForEvent("download",{timeout:20000});
       await dl.first().click();
       const d=await promise;
       await d.saveAs(`${out}/joyverse-moveframe-test.mp4`);
       evidence.downloadedFile="joyverse-moveframe-test.mp4";
       evidence.downloadSuggestedFilename=d.suggestedFilename();
       evidence.fileSize=(await stat(`${out}/joyverse-moveframe-test.mp4`)).size;
     }catch(e){e.downloadError=String(e)}
   }
 }
 if(evidence.downloadedFile){
   const bytes=await (await import("node:fs/promises")).readFile(`${out}/joyverse-moveframe-test.mp4`);
   evidence.mp4Signature=bytes.subarray(4,8).toString();
   evidence.validMp4Container=evidence.mp4Signature==="ftyp"&&bytes.length>20000;
   evidence.result=evidence.validMp4Container?"A valid MP4 container was downloaded.":"A file was downloaded but MP4 validation failed.";
 }
 await writeFile(`${out}/moveframe-generation-evidence.json`,JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({result:evidence.result,downloadedFile:evidence.downloadedFile,fileSize:evidence.fileSize,validMp4Container:evidence.validMp4Container,lastState:evidence.lastState,network:evidence.network,failures,pageErrors,consoleErrors},null,2));
 if(!evidence.validMp4Container) process.exitCode=2;
}catch(error){
 evidence.error=String(error?.stack||error); evidence.network=network; evidence.failures=failures; evidence.pageErrors=pageErrors; evidence.consoleErrors=consoleErrors;
 await page.screenshot({path:`${out}/moveframe-generation-error.png`,fullPage:true}).catch(()=>{});
 await writeFile(`${out}/moveframe-generation-evidence.json`,JSON.stringify(evidence,null,2));
 console.error(evidence.error); process.exitCode=1;
}finally{await browser.close()}
