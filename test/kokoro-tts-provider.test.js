import test from "node:test";
import assert from "node:assert/strict";
import { createKokoroTtsProvider } from "../bridge/kokoro-tts-provider.js";

function wav() {
  const b=Buffer.alloc(48);
  b.write("RIFF",0); b.writeUInt32LE(40,4); b.write("WAVE",8);
  b.write("fmt ",12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20);
  b.writeUInt16LE(1,22); b.writeUInt32LE(24000,24); b.writeUInt32LE(48000,28);
  b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write("data",36); b.writeUInt32LE(4,40);
  return b;
}

test("generates and validates WAV voiceover through Gradio client", async () => {
  let calls=0;
  const audio=wav();
  const provider=createKokoroTtsProvider({
    clientFactory:async()=>({predict:async(endpoint,args)=>{
      calls++; assert.equal(endpoint,"/generate_first");
      assert.equal(args[0],"Hello JoyVerse!"); assert.equal(args[1],"af_heart");
      return {data:[{url:"https://robinsaiworld-kokoro-tts-cpu.hf.space/file=voice.wav"},"tokens"]};
    }}),
    fetchImpl:async url=>{
      assert.equal(url,"https://robinsaiworld-kokoro-tts-cpu.hf.space/file=voice.wav");
      return {ok:true,headers:{get:()=>"48"},arrayBuffer:async()=>audio};
    }
  });
  const result=await provider.generate({text:" Hello JoyVerse! "});
  assert.equal(calls,1); assert.equal(result.contentType,"audio/wav");
  assert.equal(result.sampleRate,24000); assert.deepEqual(result.buffer,audio);
});

test("validates text, voice, speed, returned host and WAV signature", async()=>{
  const provider=createKokoroTtsProvider({clientFactory:async()=>({predict:async()=>({data:[{url:"https://evil.example/a.wav"}]})})});
  await assert.rejects(()=>provider.generate({text:""}),/1 to 500/);
  await assert.rejects(()=>provider.generate({text:"hello",voice:"unknown"}),/Unsupported/);
  await assert.rejects(()=>provider.generate({text:"hello",speed:3}),/between 0.5 and 2/);
  await assert.rejects(()=>provider.generate({text:"hello"}),/outside the trusted/);
  const invalid=createKokoroTtsProvider({
    clientFactory:async()=>({predict:async()=>({data:[{url:"https://robinsaiworld-kokoro-tts-cpu.hf.space/a.wav"}]})}),
    fetchImpl:async()=>({ok:true,headers:{get:()=>null},arrayBuffer:async()=>Buffer.alloc(48)})
  });
  await assert.rejects(()=>invalid.generate({text:"hello"}),/invalid WAV/);
});
