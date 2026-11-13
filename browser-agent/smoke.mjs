import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";

const out="browser-agent-output"; await mkdir(out,{recursive:true});
const taskId="T1794596396843276";
const base="https://ai.jxzhihi.com";
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage({viewport:{width:1365,height:900}});
const checks=[], failures=[], errors=[];
page.on("requestfailed",r=>failures.push({url:r.url(),error:r.failure()?.errorText||""}));
page.on("pageerror",e=>errors.push(String(e?.stack||e)));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text())});
const evidence={target:base+"/studio",taskId,mode:"monitor existing task only; no generation submit",startedAt:new Date().toISOString(),checks:[]};
try{
 await page.goto(base+"/studio",{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForTimeout(800);
 const deadline=Date.now()+360000;
 let latest=null, outputUrl=null;
 while(Date.now()<deadline){
  const check=await page.evaluate(async id=>{
   try{
    const r=await fetch("/api/task/"+encodeURIComponent(id),{method:"GET",credentials:"same-origin",cache:"no-store"});
    const body=await r.text();
    let data=null;try{data=JSON.parse(body)}catch{}
    return {httpStatus:r.status,ok:r.ok,body:body.slice(0,5000),data};
   }catch(e){return {error:String(e)}}
  },taskId);
  latest=check;
  const row={at:new Date().toISOString(),httpStatus:check.httpStatus,data:check.data,body:check.body?.slice(0,1000),error:check.error};
  evidence.checks.push(row);
  console.log(JSON.stringify(row));
  const s=String(check.data?.status||"").toLowerCase();
  const path=check.data?.output_path||check.data?.video_url||check.data?.url||null;
  if(path && (s==="completed"||s==="done"||s==="success"||s==="succeeded")){outputUrl=path;break;}
  if(["failed","error","cancelled","canceled"].includes(s))break;
  await page.waitForTimeout(10000);
 }
 evidence.latest=latest;
 evidence.outputPath=outputUrl;
 evidence.pageErrors=errors;
 evidence.networkFailures=failures;
 if(outputUrl){
  const url=new URL(outputUrl,base).href;
  evidence.resolvedOutputUrl=url;
  const response=await page.request.get(url,{timeout:90000});
  evidence.downloadHTTP=response.status();
  evidence.contentType=response.headers()["content-type"]||"";
  if(response.ok()){
   const bytes=Buffer.from(await response.body());
   await writeFile(out+"/joyverse-marvis.mp4",bytes);
   evidence.fileSize=bytes.length;
   evidence.mp4Signature=bytes.subarray(4,8).toString();
   evidence.validMp4Container=evidence.mp4Signature==="ftyp"&&bytes.length>20000;
   evidence.result=evidence.validMp4Container?"Existing task completed; output downloaded and MP4 container verified":"Existing task returned an output file, but MP4 validation failed";
  }else evidence.result="Task completed but output download failed";
 }else{
  const status=String(latest?.data?.status||"unknown").toLowerCase();
  evidence.result=["failed","error","cancelled","canceled"].includes(status)?"Existing task failed; no retry made":"Existing task did not reach completion during the monitoring window";
  evidence.validMp4Container=false;
 }
 await page.screenshot({path:out+"/marvis-task-monitor.png",fullPage:true});
 await writeFile(out+"/marvis-task-monitor-evidence.json",JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({result:evidence.result,latest:evidence.latest,outputPath:evidence.outputPath,downloadHTTP:evidence.downloadHTTP,fileSize:evidence.fileSize,mp4Signature:evidence.mp4Signature,validMp4Container:evidence.validMp4Container},null,2));
 if(!evidence.validMp4Container)process.exitCode=2;
}catch(error){
 evidence.error=String(error?.stack||error);evidence.pageErrors=errors;evidence.networkFailures=failures;
 await writeFile(out+"/marvis-task-monitor-evidence.json",JSON.stringify(evidence,null,2));
 console.error(evidence.error);process.exitCode=1;
}finally{await browser.close()}
