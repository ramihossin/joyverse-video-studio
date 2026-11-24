import test from "node:test";
import assert from "node:assert/strict";
import { createAgnesVideoProvider } from "../bridge/agnes-video-provider.js";

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

function mp4Buffer() {
  const buffer = Buffer.alloc(32);
  buffer.write("ftyp", 4, "ascii");
  return buffer;
}

test("Agnes text-to-video uses the free Flash model schema and returns a validated MP4", async () => {
  const calls = [];
  const video = mp4Buffer();
  const provider = createAgnesVideoProvider({
    apiKey: "test-free-key",
    pollIntervalMs: 1000,
    maxWaitMs: 10000,
    requestTimeoutMs: 1000,
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/v1/videos")) {
        return jsonResponse({ video_id: "video-123" });
      }
      if (String(url).startsWith("https://apihub.agnes-ai.com/agnesapi")) {
        return jsonResponse({ status: "completed", metadata: {
          url: "https://platform-outputs.agnes-ai.space/video.mp4"
        } });
      }
      if (String(url) === "https://platform-outputs.agnes-ai.space/video.mp4") {
        return {
          ok: true, status: 200,
          headers: { get: name => name.toLowerCase() === "content-length" ? String(video.length) : null },
          arrayBuffer: async () => video
        };
      }
      throw new Error("Unexpected URL: " + url);
    }
  });
  const created = [];
  const output = await provider.generate({
    prompt: "A cheerful golden star floats over a colorful garden.",
    videoOptions: { duration: 5, aspect: "landscape", seed: 42 },
    onJobCreated: async id => created.push(id)
  });
  assert.equal(output.contentType, "video/mp4");
  assert.deepEqual(output.buffer, video);
  assert.deepEqual(created, ["video-123"]);
  const submission = JSON.parse(calls[0].options.body);
  assert.deepEqual(submission, {
    model: "agnes-video-2.5-flash",
    prompt: "A cheerful golden star floats over a colorful garden.",
    mode: "text",
    seconds: "5",
    size: "720P",
    n: 1,
    aspect_ratio: "16:9",
    seed: 42
  });
  assert.match(calls[1].url, /video_id=video-123/);
  assert.match(calls[1].url, /model_name=agnes-video-2.5-flash/);
});

test("Agnes provider resumes polling an existing provider job without resubmitting", async () => {
  const calls = [];
  const video = mp4Buffer();
  const provider = createAgnesVideoProvider({
    apiKey: "test-free-key",
    pollIntervalMs: 1000,
    maxWaitMs: 10000,
    requestTimeoutMs: 1000,
    sleep: async () => {},
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).startsWith("https://apihub.agnes-ai.com/agnesapi")) {
        return jsonResponse({ status: "completed", metadata: {
          url: "https://platform-outputs.agnes-ai.space/resumed.mp4"
        } });
      }
      if (String(url) === "https://platform-outputs.agnes-ai.space/resumed.mp4") {
        return {
          ok: true, status: 200,
          headers: { get: () => String(video.length) },
          arrayBuffer: async () => video
        };
      }
      throw new Error("Unexpected URL: " + url);
    }
  });
  const output = await provider.generate({
    prompt: "A colorful star.",
    providerJobId: "existing-video-456",
    videoOptions: { duration: 5, aspect: "landscape" }
  });
  assert.deepEqual(output.buffer, video);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("video_id=existing-video-456"));
});

test("Agnes free Flash adapter rejects reference buffers before sending an invalid API request", async () => {
  let called = false;
  const provider = createAgnesVideoProvider({
    apiKey: "test-free-key",
    fetchImpl: async () => { called = true; throw new Error("should not be called"); }
  });
  await assert.rejects(provider.generate({
    prompt: "A character moves.",
    referenceImage: Buffer.from("image"),
    videoOptions: { duration: 5 }
  }), /hosted image URL.*text-to-video only/);
  assert.equal(called, false);
});

test("Agnes provider rejects paid model identifiers", () => {
  assert.throws(() => createAgnesVideoProvider({
    apiKey: "test-free-key", model: "agnes-video-2.5"
  }), /Only the free Agnes Video 2.5 Flash model/);
});
