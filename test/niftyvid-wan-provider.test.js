import test from "node:test";
import assert from "node:assert/strict";
import { createNiftyVidWanProvider } from "../bridge/niftyvid-wan-provider.js";

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) };
}
function mp4Buffer() {
  const buffer = Buffer.alloc(32);
  buffer.write("ftyp", 4, "ascii");
  return buffer;
}
function downloadResponse(buffer) {
  return {
    ok: true, status: 200,
    headers: { get: name => name.toLowerCase() === "content-length" ? String(buffer.length) : null },
    arrayBuffer: async () => buffer
  };
}
function completedSse(url) {
  return "event: complete\ndata: " + JSON.stringify([{
    path: "/tmp/gradio/generated.mp4",
    url,
    orig_name: "generated.mp4",
    size: 32,
    mime_type: "video/mp4",
    meta: { _type: "gradio.FileData" }
  }, null, 42]) + "\n\n";
}

test("Wan 2.2 uploads a reference image, submits a resumable job, and returns a verified MP4", async () => {
  const calls = [];
  const video = mp4Buffer();
  const progress = [];
  const jobIds = [];
  const provider = createNiftyVidWanProvider({
    requestTimeoutMs: 10000,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/gradio_api/upload")) return jsonResponse(["/tmp/gradio/reference.png"]);
      if (String(url).endsWith("/gradio_api/call/generate_video")) return jsonResponse({ event_id: "wan-event-123" });
      if (String(url).endsWith("/gradio_api/call/generate_video/wan-event-123")) {
        return { ok: true, status: 200, text: async () => completedSse(
          "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space/gradio_api/file=/tmp/gradio/generated.mp4"
        ) };
      }
      if (String(url).endsWith("/gradio_api/file=/tmp/gradio/generated.mp4")) return downloadResponse(video);
      throw new Error("Unexpected URL: " + url);
    }
  });
  const output = await provider.generate({
    prompt: "A golden star slowly rotates above a colorful magical garden.",
    referenceImage: Buffer.from("reference-image"),
    videoOptions: { duration: 3.5, seed: 77, steps: 6, quality: 6 },
    onJobCreated: async id => jobIds.push(id),
    onProgress: async value => progress.push(value.stage)
  });
  assert.equal(output.contentType, "video/mp4");
  assert.deepEqual(output.buffer, video);
  assert.deepEqual(jobIds, ["wan-event-123"]);
  assert.ok(progress.includes("uploading"));
  assert.ok(progress.includes("downloading"));
  const uploaded = calls[0].options.body.get("files");
  assert.equal(uploaded.type, "image/png");
  assert.equal(uploaded.size, Buffer.byteLength("reference-image"));
  const submitted = JSON.parse(calls[1].options.body);
  assert.equal(submitted.data[0].path, "/tmp/gradio/reference.png");
  assert.equal(submitted.data[2], "A golden star slowly rotates above a colorful magical garden.");
  assert.equal(submitted.data[5], 3.5);
  assert.equal(submitted.data[8], 77);
  assert.equal(submitted.data[10], 6);
  assert.ok(calls[2].url.endsWith("/wan-event-123"));
});

test("Wan 2.2 resumes an existing event ID without uploading or submitting again", async () => {
  const calls = [];
  const video = mp4Buffer();
  const provider = createNiftyVidWanProvider({
    requestTimeoutMs: 10000,
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).endsWith("/gradio_api/call/generate_video/existing-event")) {
        return { ok: true, status: 200, text: async () => completedSse(
          "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space/gradio_api/file=/tmp/gradio/resumed.mp4"
        ) };
      }
      if (String(url).endsWith("/gradio_api/file=/tmp/gradio/resumed.mp4")) return downloadResponse(video);
      throw new Error("Unexpected URL: " + url);
    }
  });
  const output = await provider.generate({
    prompt: "A star.",
    referenceImage: Buffer.from("reference-image"),
    providerJobId: "existing-event",
    videoOptions: { duration: 3.5 }
  });
  assert.deepEqual(output.buffer, video);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].endsWith("/existing-event"));
});

test("Wan 2.2 requires a reference image and rejects unsupported duration before network access", async () => {
  let calls = 0;
  const provider = createNiftyVidWanProvider({
    fetchImpl: async () => { calls++; throw new Error("unexpected request"); }
  });
  await assert.rejects(provider.generate({ prompt: "A star." }), /requires a non-empty reference image/);
  await assert.rejects(provider.generate({
    prompt: "A star.", referenceImage: Buffer.from("image"),
    videoOptions: { duration: 5 }
  }), /duration must be from 0.5 to 4.5 seconds/);
  assert.equal(calls, 0);
});

test("Wan 2.2 rejects untrusted output hosts and provider error events", async () => {
  const video = mp4Buffer();
  const provider = createNiftyVidWanProvider({
    requestTimeoutMs: 10000,
    fetchImpl: async url => {
      if (String(url).endsWith("/gradio_api/upload")) return jsonResponse(["/tmp/ref.png"]);
      if (String(url).endsWith("/gradio_api/call/generate_video")) return jsonResponse({ event_id: "evt" });
      if (String(url).endsWith("/gradio_api/call/generate_video/evt")) {
        return { ok: true, status: 200, text: async () => completedSse("https://evil.example/video.mp4") };
      }
      if (String(url).endsWith("/gradio_api/call/generate_video/bad")) {
        return { ok: true, status: 200, text: async () => "event: error\ndata: GPU queue unavailable\n\n" };
      }
      if (String(url).includes("evil.example")) return downloadResponse(video);
      throw new Error("Unexpected URL: " + url);
    }
  });
  await assert.rejects(provider.generate({
    prompt: "A star.", referenceImage: Buffer.from("image"), videoOptions: { duration: 3.5 }
  }), /outside the configured Space/);
  await assert.rejects(provider.generate({
    prompt: "A star.", referenceImage: Buffer.from("image"),
    providerJobId: "bad", videoOptions: { duration: 3.5 }
  }), /GPU queue unavailable/);
});

test("Wan 2.2 validates configured Space URL", () => {
  assert.throws(() => createNiftyVidWanProvider({ spaceUrl: "http://example.com" }), /HTTPS URL/);
});
