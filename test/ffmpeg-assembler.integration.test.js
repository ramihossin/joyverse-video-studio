import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { assembleMp4 } from "../bridge/ffmpeg-assembler.js";
import { createProceduralMusicWav } from "../bridge/procedural-music.js";

function run(binary,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{stdio:["ignore","ignore","pipe"]});
    let stderr="";
    child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-3000);});
    child.once("error",reject);
    child.once("close",code=>code===0?resolve():reject(new Error("FFmpeg exit "+code+": "+stderr)));
  });
}

test("real FFmpeg assembly produces a playable MP4 with a mixed audio stream", async()=>{
  const ffmpeg=(await import("ffmpeg-static")).default;
  assert.ok(ffmpeg,"ffmpeg-static binary must be available");
  const dir=await mkdtemp(join(tmpdir(),"joyverse-media-integration-"));
  try {
    const input=join(dir,"synthetic-clip.mp4");
    await run(ffmpeg,[
      "-hide_banner","-loglevel","error","-y",
      "-f","lavfi","-i","color=c=blue:s=320x240:r=24:d=1",
      "-an","-c:v","libx264","-pix_fmt","yuv420p","-movflags","+faststart",input
    ]);
    const clip=await readFile(input);
    assert.ok(clip.length>1000);
    const music=createProceduralMusicWav({durationSeconds:1.2,style:"cheerful"});
    const final=await assembleMp4([clip],{
      audioTracks:[{buffer:music,extension:"wav",volume:0.25}]
    });
    assert.equal(final.toString("ascii",4,8),"ftyp");
    const output=join(dir,"assembled.mp4");
    const {writeFile}=await import("node:fs/promises");
    await writeFile(output,final);
    await run(ffmpeg,[
      "-hide_banner","-loglevel","error","-i",output,
      "-map","0:v:0","-map","0:a:0","-f","null","-"
    ]);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
