import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JOYVERSE_TEST_MEMORY_STORE = "1";
const { enqueueTask, claimNextVideoTask } = await import("../bridge/task-store.js");

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
