import test from "node:test";
import assert from "node:assert/strict";
import { createAgnesVideoProvider } from "./agnes-video-provider.js";

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp"), Buffer.alloc(8)]);

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    arrayBuffer: async () => body
  };
}

test("Agnes submits a text video, polls by video_id and downloads verified MP4", async () => {
  const calls = [];
  const provider = createAgnesVideoProvider({
    apiKey: "test-secret",
    pollIntervalMs: 1000,
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/videos")) return response(200, { video_id: "video_123" });
      if (String(url).includes("/agnesapi?")) return response(200, {
        status: "completed", progress: 100,
        url: "https://platform-outputs.agnes-ai.space/videos/test.mp4"
      });
      return response(200, mp4);
    }
  });
  const result = await provider.generate({ prompt: "A rainbow over a garden", videoOptions: { aspect: "square", duration: 5 } });
  assert.equal(result.contentType, "video/mp4");
  assert.deepEqual(result.buffer, mp4);
  const submitted = JSON.parse(calls[0].options.body);
  assert.equal(submitted.model, "agnes-video-2.5-flash");
  assert.equal(submitted.aspect_ratio, "1:1");
  assert.ok(calls[1].url.includes("video_id=video_123"));
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
});

test("Agnes supports a reference frame as a data URL", async () => {
  const calls = [];
  const provider = createAgnesVideoProvider({
    apiKey: "test-secret", pollIntervalMs: 1000, sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/videos")) return response(200, { video_id: "video_456" });
      if (String(url).includes("/agnesapi?")) return response(200, { status: "failed", error: "test stop" });
      throw new Error("unexpected download");
    }
  });
  await assert.rejects(provider.generate({
    prompt: "Animate the frame", referenceImage: Buffer.from("image"),
    videoOptions: { aspect: "portrait", duration: 3 }
  }), /test stop/);
  const submitted = JSON.parse(calls[0].options.body);
  assert.equal(submitted.mode, "img2video");
  assert.equal(submitted.seconds, 4);
  assert.match(submitted.first_frame, /^data:image\/png;base64,/);
});

test("Agnes rejects untrusted output hosts and missing credentials", async () => {
  assert.throws(() => createAgnesVideoProvider({ apiKey: "" }), /AGNES_API_KEY/);
  const provider = createAgnesVideoProvider({
    apiKey: "test-secret", pollIntervalMs: 1000, sleep: async () => {},
    fetchImpl: async url => String(url).endsWith("/v1/videos")
      ? response(200, { video_id: "video_789" })
      : response(200, { status: "completed", url: "https://evil.example/video.mp4" })
  });
  await assert.rejects(provider.generate({ prompt: "test" }), /trusted output domain/);
});
