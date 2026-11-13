import { chromium } from "playwright";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
const out="browser-agent-output"; await mkdir(out,{recursive:true});
const prompt="Create one beautiful 5-second 3D animated preschool scene in a magical musical forest. Adam is a cheerful cartoon character with soft brown hair and a bright blue outfit. He stands on a mossy path, smiles and gives one friendly wave to the camera. Beside him is Zeno, a tiny turquoise dragon with a cream-colored belly, large amber eyes, small golden horns and golden wings; Zeno makes one gentle wing flutter and smiles. Colorful glowing flowers sway softly, tiny golden music notes sparkle in the air, warm sunbeams pass through lush green trees. Bright saturated colors, polished high-quality 3D family animation, charming rounded character design, smooth gentle camera push-in, joyful and calm mood, single continuous shot, no dialogue, no text, no subtitles, no logo.";
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const network=[],failures=[],pageErrors=[],consoleErrors=[];
page.on("request",r=>{if(r.method()==="POST"||/api\/(generate|video|job|task|download)|\/generate|\/result/i.test(r.url()))network.push({kind:"request",url:r.url(),method:r.method(),body:r.postData()||""})});
page.on("response",async r=>{if(r.request().method()!=="POST"&&!/api\/(generate|video|job|task|download)|\/generate|\/result/i.test(r.url()))return;let body="";try{body=(await r.text()).slice(0,2200)}catch{}network.push({kind:"response",url:r.url(),method:r.request().method(),status:r.status(),body})});
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>pageErrors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")consoleErrors.push(m.text())});
const evidence={target:"https://ai.jxzhihi.com/studio",prompt,browser:"Playwright + Chromium on GitHub-hosted Linux runner",startedAt:new Date().toISOString(),actions:[]};
async function getState(){
 return await page.evaluate(()=>({
  url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,8000),
  prompt:document.querySelector("#prompt")?.value||"",
  resolution:document.querySelector("#resolution")?.value||"",
  duration:document.querySelector("#duration")?.value||"",
  redeemCode:document.querySelector("#code")?.value||"",
  generateDisabled:!!document.querySelector("#generate")?.disabled,
  videos:[...document.querySelectorAll("video")].map(v=>({src:v.currentSrc||v.src||v.querySelector("source")?.src||"",poster:v.poster||"",parent:(v.parentElement?.innerText||"").slice(0,500)})),
  links:[...document.querySelectorAll("a")].map(a=>({text:(a.innerText||"").trim(),href:a.href})).filter(x=>/download|mp4|保存|下载/i.test(x.text+" "+x.href)),
  buttons:[...document.querySelectorAll("button")].map(b=>({text:(b.innerText||"").trim().replace(/\s+/g," ").slice(0,120),disabled:b.disabled,id:b.id||null})).filter(x=>/generate|download|save|cancel|try|生成|下载|保存|队列|排队/i.test(x.text))
 }));
}
try{
 await page.goto(evidence.target,{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(1800);
 const promptBox=page.locator("#prompt");
 await promptBox.waitFor({state:"visible",timeout:10000});
 await promptBox.fill(prompt);
 await page.locator("#resolution").selectOption("1280x736");
 const before=await getState();
 evidence.before=before;
 evidence.preExistingVideoUrls=before.videos.map(v=>v.src).filter(Boolean);
 if(before.duration!=="5") throw new Error("The default duration is not 5 seconds; refusing to submit.");
 if(before.resolution!=="1280x736") throw new Error("Resolution selection did not persist; refusing to submit.");
 if(before.redeemCode.trim()!=="") throw new Error("Redeem-code field is not empty; no paid code may be entered.");
 if(before.generateDisabled) throw new Error("Generate control is disabled.");
 if(/captcha|turnstile|verify you are human|security check|登录|sign in|log in/i.test(before.text)) throw new Error("A verification or login gate appeared; stopping.");
 if(!/免费体验|free trial|visitor.*1|1 次/i.test(before.text)) throw new Error("The free-trial disclosure was not visible; refusing to spend anything.");
 await page.screenshot({path:`${out}/marvis-before-submit.png`,fullPage:true});
 evidence.actions.push("filled text prompt, selected 1280x736, left redemption code blank, preserved 5 seconds");
 evidence.actions.push("clicked the public Start Generation button once");
 await page.locator("#generate").click();
 evidence.submittedAt=new Date().toISOString();
 const started=Date.now(); let last=await getState(); let sawQueue=false; let blocked=false; let failed=false;
 while(Date.now()-started<300000){
  await page.waitForTimeout(4000);
  last=await getState(); evidence.lastState=last;
  const txt=last.text||"";
  if(/captcha|turnstile|verify you are human|security check/i.test(txt)){blocked=true;break;}
  if(/生成失败|任务失败|failed to generate|generation failed|insufficient credit|余额不足|体验次数已用完|已达.*上限|请购买|核销码/i.test(txt)){failed=true;break;}
  if(/排队|队列|生成中|正在生成|processing|rendering|queued|running/i.test(txt))sawQueue=true;
  const newVideo=last.videos.find(v=>v.src&&!evidence.preExistingVideoUrls.includes(v.src));
  const download=last.links.find(l=>l.href&&!evidence.preExistingVideoUrls.includes(l.href)&&/\.mp4|download|下载/i.test(l.text+" "+l.href));
  const ready=/生成成功|视频已生成|完成|下载原片|download original|video ready/i.test(txt);
  if(newVideo||download||(ready&&last.videos.length>0)){evidence.resultState="New result detected in the generator";break;}
  if(blocked||failed)break;
 }
 evidence.lastState=last;
 evidence.sawQueue=sawQueue;
 evidence.network=network;evidence.failures=failures;evidence.pageErrors=pageErrors;evidence.consoleErrors=consoleErrors;
 if(blocked)evidence.resultState="Stopped at security verification; no bypass attempted";
 else if(failed)evidence.resultState="Generator returned an error or free-quota block";
 else if(!evidence.resultState)evidence.resultState=sawQueue?"Generation was queued or running but no output appeared before timeout":"No generated result detected before timeout";
 await page.screenshot({path:`${out}/marvis-after-submit.png`,fullPage:true});
 const finalState=await getState();
 const newVideo=finalState.videos.find(v=>v.src&&!evidence.preExistingVideoUrls.includes(v.src));
 const newLink=finalState.links.find(l=>l.href&&!evidence.preExistingVideoUrls.includes(l.href)&&/\.mp4|download|下载/i.test(l.text+" "+l.href));
 let downloadUrl=newVideo?.src||newLink?.href||null;
 if(downloadUrl&&downloadUrl.startsWith("blob:")){
  const dl=page.getByRole("link",{name:/download|下载/i}).last();
  if(await dl.count()){
   const promise=page.waitForEvent("download",{timeout:30000});await dl.click();const d=await promise;
   await d.saveAs(`${out}/joyverse-marvis.mp4`);evidence.downloadedFile="joyverse-marvis.mp4";
  }
 } else if(downloadUrl){
  const response=await page.request.get(downloadUrl,{timeout:60000});
  evidence.downloadHTTP=response.status();evidence.downloadContentType=response.headers()["content-type"]||"";
  if(response.ok()){
   const bytes=Buffer.from(await response.body());
   await writeFile(`${out}/joyverse-marvis.mp4`,bytes);
   evidence.downloadedFile="joyverse-marvis.mp4";evidence.fileSize=bytes.length;
  }
 } else {
  const dl=page.getByRole("button",{name:/download|下载/i}).last();
  if(await dl.count()&&await dl.isEnabled()){
   try{const promise=page.waitForEvent("download",{timeout:20000});await dl.click();const d=await promise;await d.saveAs(`${out}/joyverse-marvis.mp4`);evidence.downloadedFile="joyverse-marvis.mp4";evidence.suggestedFilename=d.suggestedFilename()}catch(e){evidence.downloadError=String(e)}
  }
 }
 if(evidence.downloadedFile){
  const bytes=await readFile(`${out}/joyverse-marvis.mp4`);
  evidence.fileSize=bytes.length;evidence.mp4Signature=bytes.subarray(4,8).toString();
  evidence.validMp4Container=evidence.mp4Signature==="ftyp"&&bytes.length>20000;
  evidence.resultState=evidence.validMp4Container?"MP4 downloaded from the new generator result and file signature verified":"Downloaded file failed MP4 container validation";
 }else evidence.validMp4Container=false;
 await writeFile(`${out}/marvis-generation-evidence.json`,JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({resultState:evidence.resultState,downloadedFile:evidence.downloadedFile,fileSize:evidence.fileSize,validMp4Container:evidence.validMp4Container,downloadHTTP:evidence.downloadHTTP,lastText:(last.text||"").slice(-1800),videos:finalState.videos,links:finalState.links,network,failures,pageErrors,consoleErrors},null,2));
 if(!evidence.validMp4Container)process.exitCode=2;
}catch(error){
 evidence.error=String(error?.stack||error);evidence.network=network;evidence.failures=failures;evidence.pageErrors=pageErrors;evidence.consoleErrors=consoleErrors;
 await page.screenshot({path:`${out}/marvis-generation-error.png`,fullPage:true}).catch(()=>{});
 await writeFile(`${out}/marvis-generation-evidence.json`,JSON.stringify(evidence,null,2));
 console.error(evidence.error);process.exitCode=1;
}finally{await browser.close()}
