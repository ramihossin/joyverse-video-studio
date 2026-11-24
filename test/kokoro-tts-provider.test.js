import test from "node:test";
import assert from "node:assert/strict";
import { createKokoroTtsProvider } from "../bridge/kokoro-tts-provider.js";

function wavBuffer() {
  const buffer=Buffer.alloc(44+48000);
  buffer.write("RIFF",0,"ascii"); buffer.writeUInt32LE(buffer.length-8,4);
  buffer.write("WAVE",8,"ascii"); buffer.write("fmt ",12,"ascii");
  buffer.writeUInt32LE(16,16); buffer.writeUInt16LE(1,20); buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(24000,24); buffer.writeUInt32LE(48000,28);
  buffer.writeUInt16LE(2,32); buffer.writeUInt16LE(16,34);
  buffer.write("data",36,"ascii"); buffer.writeUInt32LE(48000,40);
  return buffer;
}
function jsonResponse(value) {
  return {ok:true,status:200,text:async()=>JSON.stringify(value)};
}
function sseResponse(url) {
  const file={path:"/tmp/gradio/audio.wav",url,size:null,orig_name:"audio.wav",mime_type:null,meta:{_type:"gradio.FileData"}};
  return {ok:true,status:200,text:async()=>"event: complete\ndata: "+JSON.stringify([file,"phonemes"])+"\n\n"};
}
function audioResponse(buffer) {
  return {ok:true,status:200,headers:{get:name=>name.toLowerCase()==="content-length"?String(buffer.length):null},arrayBuffer:async()=>buffer};
}

test("Kokoro submits text, persists event ID, and downloads verified WAV", async()=>{
  const calls=[]; const jobs=[]; const audio=wavBuffer();
  const provider=createKokoroTtsProvider({
    requestTimeoutMs:10000,
    fetchImpl:async(url,options={})=>{
      calls.push({url:String(url),options});
      if(String(url).endsWith("/gradio_api/call/generate_first")) return jsonResponse({event_id:"kokoro-event-1"});
      if(String(url).endsWith("/gradio_api/call/generate_first/kokoro-event-1")) {
        return sseResponse("https://robinsaiworld-kokoro-tts-cpu.hf.space/gradio_a/gradio_api/file=/tmp/gradio/audio.wav");
      }
      if(String(url).includes("/gradio_a/gradio_api/file=")) return audioResponse(audio);
      throw new Error("Unexpected URL: "+url);
    }
  });
  const result=await provider.generate({
    text:" Hello JoyVerse! ",voice:"af_heart",speed:1.0,
    onJobCreated:async id=>jobs.push(id)
  });
  assert.equal(result.contentType,"audio/wav");
  assert.equal(result.sampleRate,24000);
  assert.equal(result.durationSeconds,1);
  assert.deepEqual(result.buffer,audio);
  assert.deepEqual(jobs,["kokoro-event-1"]);
  assert.deepEqual(JSON.parse(calls[0].options.body).data,["Hello JoyVerse!","af_heart",1.0,false]);
  assert.equal(calls.length,3);
});

test("Kokoro resumes an existing event without submitting a duplicate job", async()=>{
  const calls=[]; const audio=wavBuffer();
  const provider=createKokoroTtsProvider({
    requestTimeoutMs:10000,
    fetchImpl:async url=>{
      calls.push(String(url));
      if(String(url).endsWith("/gradio_api/call/generate_first/existing-event")) {
        return sseResponse("https://robinsaiworld-kokoro-tts-cpu.hf.space/gradio_api/file=/tmp/gradio/audio.wav");
      }
      if(String(url).includes("/gradio_api/file=")) return audioResponse(audio);
      throw new Error("Unexpected URL: "+url);
    }
  });
  const result=await provider.generate({text:"Hello.",providerJobId:"existing-event"});
  assert.equal(result.sampleRate,24000);
  assert.equal(calls.length,2);
  assert.ok(calls[0].endsWith("/existing-event"));
});

test("Kokoro validates text, voice, speed, host, and WAV signature", async()=>{
  let calls=0;
  const provider=createKokoroTtsProvider({fetchImpl:async()=>{calls++;throw new Error("unexpected");}});
  await assert.rejects(provider.generate({text:""}),/1 to 500 characters/);
  await assert.rejects(provider.generate({text:"hello",voice:"unknown"}),/Unsupported/);
  await assert.rejects(provider.generate({text:"hello",speed:3}),/between 0.5 and 2/);
  assert.equal(calls,0);

  const unsafe=createKokoroTtsProvider({
    fetchImpl:async url=>{
      if(String(url).endsWith("/gradio_api/call/generate_first")) return jsonResponse({event_id:"unsafe"});
      if(String(url).endsWith("/gradio_api/call/generate_first/unsafe")) {
        return sseResponse("https://evil.example/audio.wav");
      }
      throw new Error("unexpected");
    }
  });
  await assert.rejects(unsafe.generate({text:"hello"}),/outside the configured Space/);

  const invalid=createKokoroTtsProvider({
    fetchImpl:async url=>{
      if(String(url).endsWith("/gradio_api/call/generate_first")) return jsonResponse({event_id:"bad-wav"});
      if(String(url).endsWith("/gradio_api/call/generate_first/bad-wav")) {
        return sseResponse("https://robinsaiworld-kokoro-tts-cpu.hf.space/gradio_api/file=/tmp/gradio/bad.wav");
      }
      if(String(url).includes("/gradio_api/file=")) return audioResponse(Buffer.alloc(64));
      throw new Error("unexpected");
    }
  });
  await assert.rejects(invalid.generate({text:"hello"}),/invalid WAV/);
});

test("Kokoro validates Space URL",()=>{
  assert.throws(()=>createKokoroTtsProvider({spaceUrl:"http://example.com"}),/HTTPS/);
});
