import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JOYVERSE_TEST_MEMORY_STORE = "1";
const { enqueueTask, claimNextVideoTask, setTaskReferenceImage, getTask } = await import("../bridge/task-store.js");

test("video worker claims only explicitly confirmed video tasks", async () => {
  await enqueueTask({
    task_id: "ordinary-task", scene_id: "ordinary", prompt: "Browse a page.",
    toolsets: ["web"], confirm_video_generation: false
  });
  await enqueueTask({
    task_id: "unconfirmed-video", scene_id: "unconfirmed", prompt: "Make a clip.",
    toolsets: ["video_gen"], confirm_video_generation: false
  });
  await enqueueTask({
    task_id: "confirmed-video", scene_id: "confirmed", prompt: "Make a clip.",
    toolsets: ["video_gen"], confirm_video_generation: true,
    video_options: { aspect: "landscape", duration: 4 }
  });

  const task = await claimNextVideoTask();
  assert.equal(task.task_id, "confirmed-video");
  assert.equal(task.confirm_video_generation, true);
  assert.equal(task.video_options.duration, 4);
  assert.equal(typeof task.claim_token, "string");
  assert.ok(task.claim_token.length >= 32);
});

test("video worker does not claim ordinary or unconfirmed tasks", async () => {
  await enqueueTask({
    task_id: "web-only", scene_id: "web", prompt: "Search.",
    toolsets: ["web"], confirm_video_generation: false
  });
  await enqueueTask({
    task_id: "video-needs-confirmation", scene_id: "video", prompt: "Generate.",
    toolsets: ["video_gen"], confirm_video_generation: false
  });
  assert.equal(await claimNextVideoTask(), null);
});

test("reference image key is persisted and returned to a confirmed video worker", async () => {
  await enqueueTask({
    task_id: "reference-image-task", scene_id: "reference-scene", prompt: "Animate the reference.",
    toolsets: ["video_gen"], confirm_video_generation: true
  });
  const linked = await setTaskReferenceImage("reference-image-task", "references/reference-image-task/example.png");
  assert.equal(linked.reference_image_key, "references/reference-image-task/example.png");
  const task = await claimNextVideoTask();
  assert.equal(task.task_id, "reference-image-task");
  assert.equal(task.reference_image_key, "references/reference-image-task/example.png");
  assert.equal((await getTask("reference-image-task")).reference_image_key, "references/reference-image-task/example.png");
});

test("reference image association rejects non-video and already claimed tasks", async () => {
  await enqueueTask({
    task_id: "reference-web-task", scene_id: "reference-web", prompt: "Browse.",
    toolsets: ["web"], confirm_video_generation: false
  });
  assert.equal(await setTaskReferenceImage("reference-web-task", "references/a.png"), null);
});
