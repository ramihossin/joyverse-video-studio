import { chromium } from "playwright";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
const out="browser-agent-output"; await mkdir(out,{recursive:true});
const prompt="A tiny cheerful turquoise dragon with small golden wings gently waves beside a colorful flower garden. Polished friendly 3D cartoon animation, bright joyful colors, soft warm daylight, one simple continuous action, smooth camera movement, no text.";
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const network=[],failures=[],errors=[],downloads=[]; let savedFile=null;
const safeUrl=r=>{try{const u=new URL(r);return u.origin+u.pathname}catch{return String(r).split("?")[0]}};
page.on("response",r=>{if(/api|generate|video|task|queue|render|ad|turnstile/i.test(r.url()))network.push({url:safeUrl(r.url()),method:r.request().method(),status:r.status(),contentType:r.headers()["content-type"]||""})});
page.on("requestfailed",r=>failures.push({url:safeUrl(r.url()),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>errors.push(String(e?.message||e).slice(0,400)));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text().slice(0,300))});
page.on("download",async d=>{const name=path.basename(d.suggestedFilename()||"loremotion-video.mp4").replace(/[^a-zA-Z0-9._-]/g,"_");const p=path.join(out,name);try{await d.saveAs(p);savedFile=p;downloads.push({name,path:p})}catch(e){downloads.push({name,error:String(e).slice(0,250)})}});
const inspect=()=>page.evaluate(()=>({
 url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,6500),
 prompt:document.querySelector("#generate-prompt-dock")?.value||null,
 negativePrompt:document.querySelector("#generate-negative-prompt")?.value||null,
 videos:[...document.querySelectorAll("video")].map(v=>({src:v.currentSrc||v.src,readyState:v.readyState,duration:Number.isFinite(v.duration)?v.duration:null})),
 links:[...document.querySelectorAll("a")].map(a=>({text:(a.innerText||a.textContent||"").trim().slice(0,90),href:a.href})).filter(a=>/download|\\.mp4/i.test(a.text+" "+a.href)).slice(0,20),
 controls:[...document.querySelectorAll("input,textarea,button,[role=button]")].slice(0,70).map(e=>({tag:e.tagName.toLowerCase(),id:e.id||null,type:e.type||null,placeholder:e.getAttribute("placeholder"),aria:e.getAttribute("aria-label"),text:(e.innerText||e.textContent||"").trim().slice(0,120),value:"value"in e?e.value:null,disabled:"disabled"in e?e.disabled:null}))
}));
async function saveVideo(state){
 if(savedFile)return;
 const v=state.videos.find(x=>x.src&&x.readyState>=2)||state.videos.find(x=>x.src); if(!v?.src)return;
 try{
  if(v.src.startsWith("blob:")){
   const b64=await page.evaluate(async src=>{const r=await fetch(src);if(!r.ok)throw new Error("blob "+r.status);const b=new Uint8Array(await r.arrayBuffer());let x="";for(let i=0;i<b.length;i+=32768)x+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(x)},v.src);
   const p=path.join(out,"loremotion-generated.mp4");await writeFile(p,Buffer.from(b64,"base64"));savedFile=p;
  }else if(/^https?:/i.test(v.src)){const r=await context.request.get(v.src,{timeout:90000});if(r.ok()){const p=path.join(out,"loremotion-generated.mp4");await writeFile(p,await r.body());savedFile=p}}
 }catch(e){errors.push("video-save: "+String(e).slice(0,300))}
}
try{
 await page.goto("https://loremotion.com/generate/",{waitUntil:"domcontentloaded",timeout:60000});
 await page.waitForTimeout(5000);
 const before=await inspect();
 await page.screenshot({path:path.join(out,"loremotion-before.png"),fullPage:true});
 const promptBox=page.locator("#generate-prompt-dock");
 if(await promptBox.count())await promptBox.fill(prompt);
 await page.waitForTimeout(1000);
 const ready=await inspect();
 const generate=page.getByRole("button",{name:/^Generate/i}).first();
 const buttonCount=await generate.count();
 const buttonEnabled=buttonCount?await generate.isEnabled().catch(()=>false):false;
 const turnstileResponse=await page.locator('input[id*="cf-chl-widget"][type="hidden"]').first().inputValue().catch(()=>"");
 const hasTurnstile=await page.locator('iframe[src*="challenges.cloudflare.com"]').count()>0||await page.locator('input[id*="cf-chl-widget"]').count()>0;
 const state={stage:"inspection-only",before,ready,buttonCount,buttonEnabled,hasTurnstile,turnstileTokenPresent:Boolean(turnstileResponse)};
 console.log("LOREMOTION READY",JSON.stringify({title:ready.title,prompt:ready.prompt,buttonCount,buttonEnabled,hasTurnstile,turnstileTokenPresent:Boolean(turnstileResponse),text:ready.text.slice(0,1800)},null,2));
 if(buttonEnabled){
  await generate.click();state.stage="submitted";
  const start=Date.now();
  while(Date.now()-start<240000){
   await page.waitForTimeout(4000);const curr=await inspect();
   if(curr.videos.some(v=>v.src&&v.readyState>=2)||curr.links.some(a=>/download/i.test(a.text))||savedFile){state.stage="video-ready";state.result=curr;await saveVideo(curr);break}
   if(/generation failed|request failed|something went wrong|queue is full|try again later|daily limit|limit reached|watch.*ad|continue.*ad/i.test(curr.text)){state.stage="generation-gate-or-error";state.result=curr;break}
  }
  if(!state.result)state.result=await inspect();
 }else if(hasTurnstile&&!turnstileResponse){state.stage="human-verification-required"}
 else if(!ready.prompt){state.stage="prompt-field-not-found"}
 else{state.stage="generate-button-unavailable"}
 if(!savedFile&&state.result)await saveVideo(state.result);
 state.savedFile=savedFile;state.network=network;state.failures=failures;state.errors=errors;state.downloads=downloads;
 if(savedFile){const inf=await stat(savedFile);const fs=await import("node:fs/promises");const h=await fs.readFile(savedFile);state.file={bytes:inf.size,ftyp:h.subarray(4,8).toString("ascii"),validMp4Signature:h.subarray(4,8).toString("ascii")==="ftyp"}}
 await page.screenshot({path:path.join(out,"loremotion-after.png"),fullPage:true});
 await writeFile(path.join(out,"loremotion-result.json"),JSON.stringify(state,null,2));
 console.log("LOREMOTION RESULT",JSON.stringify({stage:state.stage,buttonEnabled,hasTurnstile,turnstileTokenPresent:Boolean(turnstileResponse),savedFile,file:state.file,network:network.slice(-15),failures:failures.slice(0,10),errors:errors.slice(0,10)},null,2));
 if(state.stage==="human-verification-required")process.exitCode=2;
 else if(state.stage==="prompt-field-not-found"||state.stage==="generate-button-unavailable")process.exitCode=3;
 else if(state.stage==="generation-gate-or-error")process.exitCode=4;
 else if(state.stage==="video-ready"&&!savedFile)process.exitCode=5;
}catch(e){await writeFile(path.join(out,"loremotion-exception.txt"),String(e?.stack||e));console.error(e);process.exitCode=1}
finally{await browser.close()}
