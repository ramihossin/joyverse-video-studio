import test from "node:test";
import assert from "node:assert/strict";
import { processClaimedVideoTask, createVideoWorker } from "../bridge/video-worker.js";

const baseTask = {
  task_id: "task-1", scene_id: "scene/one", prompt: "A friendly dragon.",
  toolsets: ["video_gen"], confirm_video_generation: true,
  video_options: { aspect: "landscape", duration: 3 },
  claim_token: "claim-token-with-at-least-32-characters", attempts: 1
};

test("video worker stores the generated MP4 and commits its durable key", async () => {
  const checkpoints = [];
  const finishes = [];
  let saved;
  const result = await processClaimedVideoTask(baseTask, {
    provider: { generate: async ({ prompt, videoOptions }) => {
      assert.equal(prompt, baseTask.prompt);
      assert.equal(videoOptions.duration, 3);
      return { buffer: Buffer.from("mp4"), contentType: "video/mp4" };
    } },
    storage: { put: async (key, buffer, contentType) => {
      saved = { key, size: buffer.length, content_type: contentType };
      return saved;
    } },
    checkpoint: async (_id, _token, value) => {
      checkpoints.push(value);
      return { accepted: true };
    },
    finish: async (...args) => { finishes.push(args); return { status: args[2] }; }
  });
  assert.equal(result.status, "completed");
  assert.equal(saved.key, "jobs/task-1/scene%2Fone.mp4");
  assert.deepEqual(checkpoints.map(x => x.stage), ["submitting", "uploading", "completed"]);
  assert.equal(finishes[0][2], "completed");
  assert.equal(finishes[0][3].storage_key, saved.key);
});

test("video worker loads a stored reference image and passes it to LTX", async () => {
  const expected = Buffer.from("reference-image-bytes");
  let received;
  const result = await processClaimedVideoTask({
    ...baseTask, reference_image_key: "references/task-1/ref.png"
  }, {
    provider: { generate: async ({ referenceImage }) => {
      received = referenceImage;
      return { buffer: Buffer.from("mp4"), contentType: "video/mp4" };
    } },
    storage: {
      get: async key => { assert.equal(key, "references/task-1/ref.png"); return expected; },
      put: async (key, buffer, contentType) => ({ key, size: buffer.length, content_type: contentType })
    },
    checkpoint: async () => ({ accepted: true }),
    finish: async () => ({ status: "completed" })
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(received, expected);
});

test("video worker blocks duplicate LTX submission after a lost provider checkpoint", async () => {
  let generated = false;
  let finished;
  const result = await processClaimedVideoTask({
    ...baseTask, attempts: 2, provider: "ltx-gradio", stage: "generating"
  }, {
    provider: { generate: async () => { generated = true; } },
    storage: { put: async () => ({}) },
    finish: async (...args) => { finished = args; return { status: "failed" }; }
  });
  assert.equal(result.reason, "provider_resume_unavailable");
  assert.equal(generated, false);
  assert.equal(finished[2], "failed");
});

test("video worker refuses tasks without explicit confirmation", async () => {
  await assert.rejects(processClaimedVideoTask({
    ...baseTask, confirm_video_generation: false
  }, {
    provider: { generate: async () => ({}) },
    storage: { put: async () => ({}) }
  }), /explicit video-generation confirmation/);
});

test("video worker validates polling interval", () => {
  assert.throws(() => createVideoWorker({
    provider: {}, storage: {}, pollMs: 100
  }), /VIDEO_WORKER_POLL_MS/);
});
