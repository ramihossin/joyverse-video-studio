import { setTimeout as delay } from "node:timers/promises";
import {
  initializeTaskStore, claimNextVideoTask, updateTaskCheckpoint, finishTask
} from "./task-store.js";
import { createLtxProvider } from "./ltx-provider.js";
import { createObjectStorage } from "./object-storage.js";

function safeSegment(value) {
  return encodeURIComponent(String(value)).slice(0, 160) || "scene";
}

export async function processClaimedVideoTask(task, {
  provider,
  storage,
  checkpoint = updateTaskCheckpoint,
  finish = finishTask
} = {}) {
  if (!task || task.confirm_video_generation !== true ||
      !Array.isArray(task.toolsets) || !task.toolsets.includes("video_gen")) {
    throw new Error("Worker received a task without explicit video-generation confirmation.");
  }
  if (!provider || typeof provider.generate !== "function" ||
      !storage || typeof storage.put !== "function") {
    throw new Error("Video worker provider and durable object storage are required.");
  }
  const claimToken = task.claim_token;
  if (typeof claimToken !== "string" || claimToken.length < 32) {
    throw new Error("Claim token is missing or invalid.");
  }

  // Gradio's event iterator is process-local. If a previous attempt died after
  // submission, do not silently submit a second generation and consume more quota.
  if (task.attempts > 1 && task.provider === "ltx-gradio" &&
      ["submitting", "generating"].includes(task.stage) && !task.provider_job_id) {
    await finish(task.task_id, claimToken, "failed", null,
      "Previous LTX submission has no durable provider job ID. Automatic resubmission was blocked to avoid duplicate generation.");
    return { status: "failed", reason: "provider_resume_unavailable" };
  }

  try {
    const started = await checkpoint(task.task_id, claimToken, {
      stage: "submitting", provider: "ltx-gradio"
    });
    if (!started) throw new Error("Task claim expired before LTX submission.");
    const referenceImage = task.reference_image_key ? await storage.get(task.reference_image_key) : null;
    const output = await provider.generate({
      prompt: task.prompt,
      referenceImage,
      videoOptions: task.video_options || {},
      onProgress: async progress => {
        await checkpoint(task.task_id, claimToken, {
          stage: "generating", provider: "ltx-gradio"
        });
      }
    });
    await checkpoint(task.task_id, claimToken, {
      stage: "uploading", provider: "ltx-gradio"
    });
    const key = "jobs/" + safeSegment(task.task_id) + "/" +
      safeSegment(task.scene_id) + ".mp4";
    const saved = await storage.put(key, output.buffer, output.contentType || "video/mp4");
    const savedCheckpoint = await checkpoint(task.task_id, claimToken, {
      stage: "completed", provider: "ltx-gradio", storage_key: saved.key
    });
    if (!savedCheckpoint) throw new Error("Task claim expired before the stored video could be committed.");
    const completed = await finish(task.task_id, claimToken, "completed", {
      storage_key: saved.key,
      bytes: saved.size,
      content_type: saved.content_type
    }, null);
    if (!completed) throw new Error("Task ownership was lost before completion acknowledgement.");
    return { status: "completed", storage_key: saved.key, bytes: saved.size };
  } catch (error) {
    await finish(task.task_id, claimToken, "failed", null,
      String(error?.message || error).slice(0, 1000));
    return { status: "failed", error: String(error?.message || error).slice(0, 1000) };
  }
}

export function createVideoWorker({
  provider = createLtxProvider(),
  storage = createObjectStorage(),
  claim = claimNextVideoTask,
  processTask = processClaimedVideoTask,
  pollMs = Number(process.env.VIDEO_WORKER_POLL_MS || 5000),
  logger = console
} = {}) {
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) {
    throw new Error("VIDEO_WORKER_POLL_MS must be from 1000 to 60000.");
  }
  let stopping = false;
  return Object.freeze({
    stop() { stopping = true; },
    async runOnce() {
      const task = await claim();
      if (!task) return { status: "idle" };
      return processTask(task, { provider, storage });
    },
    async run() {
      await initializeTaskStore();
      logger.info?.("JoyVerse LTX worker started.");
      while (!stopping) {
        try {
          const result = await this.runOnce();
          if (result.status === "idle") await delay(pollMs);
          else logger.info?.("Video task processed:", result.status, result.storage_key || "");
        } catch (error) {
          logger.error?.("Video worker error:", String(error?.message || error).slice(0, 300));
          await delay(pollMs);
        }
      }
      logger.info?.("JoyVerse LTX worker stopped.");
    }
  });
}
