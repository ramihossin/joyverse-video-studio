import { chromium } from "playwright";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";

const out="browser-agent-output"; await mkdir(out,{recursive:true});
const prompt="A polished 3D animated preschool fantasy scene in a magical musical forest. Adam, a cheerful cartoon character with soft brown hair and a bright blue outfit, stands on a mossy path and gives a friendly wave. Beside him, Zeno, a tiny turquoise dragon with a cream belly, large amber eyes, small golden horns and golden wings, makes one joyful wing flutter. Glowing flowers gently sway and tiny golden musical sparkles float between colorful trees. Bright saturated colors, warm soft lighting, expressive friendly faces, smooth gentle camera push-in, clean high-quality 3D children's animation, one continuous shot, no text, no subtitles, no logo.";
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const network=[],failures=[],pageErrors=[],consoleErrors=[];
page.on("request",r=>{if(r.method()==="POST"||/api\/video|generate|task/i.test(r.url()))network.push({kind:"request",url:r.url(),method:r.method(),body:r.postData()||""})});
page.on("response",async r=>{if(r.request().method()!=="POST"&&!/api\/video|generate|task/i.test(r.url()))return;let b="";try{b=(await r.text()).slice(0,2500)}catch{}network.push({kind:"response",url:r.url(),method:r.request().method(),status:r.status(),body:b})});
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>pageErrors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")consoleErrors.push(m.text())});
const evidence={target:"https://yovid.ai/ai-video-generator/text-to-video",prompt,startedAt:new Date().toISOString(),browser:"Playwright + Chromium on GitHub-hosted Linux runner",actions:[]};
async function state(){
 return await page.evaluate(()=>({
  text:(document.body?.innerText||"").slice(0,5500),
  title:document.title,url:location.href,
  prompt:document.querySelector("textarea")?.value||"",
  buttons:[...document.querySelectorAll("button")].map(b=>({text:(b.innerText||b.textContent||"").trim().replace(/\s+/g," ").slice(0,120),disabled:b.disabled,ariaDisabled:b.getAttribute("aria-disabled"),title:b.title,id:b.id||null})).filter(b=>/create|generate|wait|second|free|download|cancel|retry/i.test(b.text+" "+(b.title||""))),
  videos:[...document.querySelectorAll("video")].map(v=>({src:v.currentSrc||v.src||"",poster:v.poster||"",parent:(v.parentElement?.innerText||"").slice(0,300)})),
  links:[...document.querySelectorAll("a")].map(a=>({text:(a.innerText||"").trim(),href:a.href})).filter(x=>/download|mp4/i.test(x.text+" "+x.href))
 }));
}
try{
 await page.goto(evidence.target,{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(1800);
 const box=page.locator("textarea").first();
 await box.waitFor({state:"visible",timeout:12000});
 await box.fill(prompt);
 evidence.actions.push("entered text-only prompt");
 const initial=await state();
 evidence.initialState=initial;
 evidence.existingVideoUrls=initial.videos.map(v=>v.src).filter(Boolean);
 if(!/Seedance 2\.0 Mini/.test(initial.text)||!/4s/.test(initial.text)||!/480p/.test(initial.text)||!/16:9/.test(initial.text)){
  throw new Error("Unexpected free-trial settings; refusing to submit.");
 }
 if(/verify you are human|security verification|captcha|turnstile/i.test(initial.text)){
  throw new Error("Security verification displayed; stopped without bypass.");
 }
 await page.screenshot({path:`${out}/yovid-before-cooldown.png`,fullPage:true});
 evidence.actions.push("observed a 90-second guest cooldown from the public page; waiting once without reloading");
 await page.waitForTimeout(96000);
 const afterWait=await state();
 evidence.afterWaitState=afterWait;
 await page.screenshot({path:`${out}/yovid-after-cooldown.png`,fullPage:true});
 if(/verify you are human|security verification|captcha|turnstile/i.test(afterWait.text)){
  throw new Error("Security verification appeared after cooldown; stopped without bypass.");
 }
 const create=page.getByRole("button",{name:/create for free/i}).first();
 if(!(await create.count())) throw new Error("Create for Free control is not present.");
 if(await create.isDisabled()) throw new Error("Create for Free remains disabled after the cooldown; no request submitted.");
 evidence.actions.push("clicked Create for Free exactly once");
 evidence.submittedAt=new Date().toISOString();
 const clickTime=Date.now();
 await create.click();
 let last=await state();
 let started=false, blocked=false, rejected=false;
 while(Date.now()-clickTime<180000){
  await page.waitForTimeout(4000);
  last=await state(); evidence.lastState=last;
  const body=last.text||"";
  if(/verify you are human|security verification|captcha|turnstile/i.test(body)){blocked=true;break;}
  if(/sign in|log in|create an account/i.test(body)&&!/no sign-up/i.test(body)){blocked=true;break;}
  if(/queued|queue position|generating|rendering|processing|estimated time|cancel generation/i.test(body)){started=true;}
  const freshVideo=last.videos.some(v=>v.src&&!evidence.existingVideoUrls.includes(v.src));
  const freshDownload=last.links.some(x=>x.href&&!/javascript:/.test(x.href)&&/\.mp4|download/i.test(x.href));
  if(freshVideo||freshDownload||started) {
    if(freshVideo||freshDownload) break;
  }
  if(/not enough credits|no credits|trial.*used|limit reached|try again later|too many requests|not eligible/i.test(body)){rejected=true;break;}
 }
 evidence.network=network; evidence.failures=failures; evidence.pageErrors=pageErrors; evidence.consoleErrors=consoleErrors;
 evidence.status=blocked?"Stopped at verification/account prompt":rejected?"Provider rejected the free attempt":started?"Generation queue or processing started":"No generation state observed before timeout";
 evidence.lastState=last;
 await page.screenshot({path:`${out}/yovid-after-submit.png`,fullPage:true});
 const fresh=last.videos.find(v=>v.src&&!evidence.existingVideoUrls.includes(v.src));
 const link=last.links.find(x=>x.href&&!/javascript:/.test(x.href)&&/\.mp4|download/i.test(x.href));
 let url=fresh?.src||link?.href||null;
 if(url&&url.startsWith("blob:")){
   const dl=page.getByRole("button",{name:/download/i}).last();
   if(await dl.count()&&await dl.isEnabled()){
    const p=page.waitForEvent("download",{timeout:30000});await dl.click();const d=await p;
    await d.saveAs(`${out}/joyverse-yovid.mp4`);
    evidence.downloadedFile="joyverse-yovid.mp4"; evidence.downloadSuggestedFilename=d.suggestedFilename();
   }
 }else if(url){
   const resp=await page.request.get(url,{timeout:60000});
   evidence.downloadHTTP=resp.status();evidence.downloadContentType=resp.headers()["content-type"]||"";
   if(resp.ok()){
    const data=Buffer.from(await resp.body());
    await writeFile(`${out}/joyverse-yovid.mp4`,data);
    evidence.downloadedFile="joyverse-yovid.mp4";evidence.fileSize=data.length;
   }
 } else {
   const buttons=page.getByRole("button",{name:/download/i});
   if(await buttons.count()){
    for(let i=0;i<await buttons.count();i++){
     if(await buttons.nth(i).isEnabled()){
      try{const p=page.waitForEvent("download",{timeout:15000});await buttons.nth(i).click();const d=await p;await d.saveAs(`${out}/joyverse-yovid.mp4`);evidence.downloadedFile="joyverse-yovid.mp4";evidence.downloadSuggestedFilename=d.suggestedFilename();break}catch{}
     }
    }
   }
 }
 if(evidence.downloadedFile){
  const data=await readFile(`${out}/joyverse-yovid.mp4`);
  evidence.fileSize=data.length;evidence.mp4Signature=data.subarray(4,8).toString();
  evidence.validMp4Container=evidence.mp4Signature==="ftyp"&&data.length>20000;
  evidence.status=evidence.validMp4Container?"A non-gallery result downloaded as MP4 and container signature verified":"Downloaded file failed MP4 validation";
 } else evidence.validMp4Container=false;
 await writeFile(`${out}/yovid-generation-evidence.json`,JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({status:evidence.status,downloadedFile:evidence.downloadedFile,fileSize:evidence.fileSize,validMp4Container:evidence.validMp4Container,network,failures,pageErrors,consoleErrors,lastState:last},null,2));
 if(!evidence.validMp4Container)process.exitCode=2;
}catch(error){
 evidence.error=String(error?.stack||error);evidence.network=network;evidence.failures=failures;evidence.pageErrors=pageErrors;evidence.consoleErrors=consoleErrors;
 await page.screenshot({path:`${out}/yovid-generation-error.png`,fullPage:true}).catch(()=>{});
 await writeFile(`${out}/yovid-generation-evidence.json`,JSON.stringify(evidence,null,2));
 console.error(evidence.error);process.exitCode=1;
}finally{await browser.close()}
