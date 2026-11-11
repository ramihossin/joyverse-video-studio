import test from "node:test";
import assert from "node:assert/strict";
import { createLtxGradioVideoProvider } from "../bridge/ltx-gradio-video-provider.js";

const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(16)]);

function makeProvider() {
  const calls = [];
  const progress = [];
  const provider = createLtxGradioVideoProvider({
    token: "hf_test_token",
    clientFactory: async (spaceId, token) => {
      assert.equal(spaceId, "Lightricks/LTX-2.5");
      assert.equal(token, "hf_test_token");
      return {
        handleFile: buffer => ({ uploaded: buffer }),
        client: {
          predict: async (endpoint, args) => {
            calls.push({ endpoint, args });
            return {
              data: [{ url: "https://lightricks-ltx-2-5.hf.space/gradio_api/file=scene.mp4" }]
            };
          }
        }
      };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://lightricks-ltx-2-5.hf.space/gradio_api/file=scene.mp4");
      assert.equal(options.headers.Authorization, "Bearer hf_test_token");
      return new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } });
    }
  });
  return { provider, calls, progress };
}

test("LTX provider submits a text-to-video request to the real Gradio run endpoint", async () => {
  const { provider, calls, progress } = makeProvider();
  const result = await provider.generate({
    prompt: "A friendly turquoise dragon flies through a colorful garden",
    videoOptions: { aspect: "portrait", duration: 5, seed: 7 },
    onProgress: value => progress.push(value)
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, "/run");
  assert.deepEqual(calls[0].args, [
    "A friendly turquoise dragon flies through a colorful garden",
    null, 1472, 832, 5, 7, "conv", false, false, false
  ]);
  assert.deepEqual(result.buffer, mp4);
  assert.equal(result.contentType, "video/mp4");
  assert.equal(result.bytes, mp4.length);
  assert.equal(progress.at(-1).stage, "completed");
});

test("LTX provider uploads a reference image for image-to-video", async () => {
  const { provider, calls } = makeProvider();
  const image = Buffer.from("reference-image");
  await provider.generate({
    prompt: "Animate the character waving",
    referenceImage: image,
    videoOptions: { aspect: "landscape", duration: 3 }
  });
  assert.deepEqual(calls[0].args[1], { uploaded: image });
  assert.equal(calls[0].args[2], 832);
  assert.equal(calls[0].args[3], 1472);
});

test("LTX provider rejects a non-Hugging-Face output URL", async () => {
  const provider = createLtxGradioVideoProvider({
    clientFactory: async () => ({
      handleFile: value => value,
      client: { predict: async () => ({ data: [{ url: "https://example.com/fake.mp4" }] }) }
    }),
    fetchImpl: async () => { throw new Error("must not fetch an untrusted host"); }
  });
  await assert.rejects(
    provider.generate({ prompt: "Test scene", videoOptions: { duration: 1 } }),
    /outside the trusted Hugging Face domain/
  );
});

test("LTX provider rejects malformed model output instead of reporting success", async () => {
  const provider = createLtxGradioVideoProvider({
    clientFactory: async () => ({
      handleFile: value => value,
      client: { predict: async () => ({ data: [{ url: "https://lightricks-ltx-2-5.hf.space/output.mp4" }] }) }
    }),
    fetchImpl: async () => new Response(Buffer.from("not an mp4"), { status: 200 })
  });
  await assert.rejects(
    provider.generate({ prompt: "Test scene", videoOptions: { duration: 1 } }),
    /not a valid MP4/
  );
});
