import { setTimeout as delay } from "node:timers/promises";
import {
  initializeTaskStore, claimNextVideoTask, updateTaskCheckpoint, finishTask
} from "./task-store.js";
import { createProceduralVideoProvider } from "./procedural-video-provider.js";
import { createObjectStorage } from "./object-storage.js";

function safeSegment(value) {
  return encodeURIComponent(String(value)).slice(0, 160) || "scene";
}

export async function processClaimedVideoTask(task, {
  provider,
  storage,
  checkpoint = updateTaskCheckpoint,
  finish = finishTask,
  heartbeatIntervalMs = 60000
} = {}) {
  if (!task || task.confirm_video_generation !== true ||
      !Array.isArray(task.toolsets) || !task.toolsets.includes("video_gen")) {
    throw new Error("Worker received a task without explicit video-generation confirmation.");
  }
  if (!provider || typeof provider.generate !== "function" ||
      !storage || typeof storage.put !== "function") {
    throw new Error("Video worker provider and durable object storage are required.");
  }
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1000 || heartbeatIntervalMs >= 5 * 60 * 1000) {
    throw new Error("heartbeatIntervalMs must be from 1000 to less than 300000.");
  }
  const claimToken = task.claim_token;
  if (typeof claimToken !== "string" || claimToken.length < 32) {
    throw new Error("Claim token is missing or invalid.");
  }

  const providerName = provider.name || "custom-video-provider";
  let heartbeatTimer = null;
  let heartbeatChain = Promise.resolve();
  let heartbeatError = null;
  let currentStage = "submitting";
  const renewLease = () => {
    heartbeatChain = heartbeatChain.then(async () => {
      const renewed = await checkpoint(task.task_id, claimToken, {
        stage: currentStage, provider: providerName
      });
      if (!renewed) throw new Error("Video worker lost ownership of the task lease.");
    }).catch(error => { heartbeatError = error; });
    return heartbeatChain;
  };
  try {
    const started = await checkpoint(task.task_id, claimToken, {
      stage: "submitting", provider: providerName
    });
    if (!started) throw new Error("Task claim expired before video generation started.");
    heartbeatTimer = setInterval(() => { void renewLease(); }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    const referenceImage = task.reference_image_key ? await storage.get(task.reference_image_key) : null;
    if (heartbeatError) throw heartbeatError;
    const output = await provider.generate({
      prompt: task.prompt,
      referenceImage,
      videoOptions: task.video_options || {},
      onProgress: async () => {
        currentStage = "generating";
        await renewLease();
        if (heartbeatError) throw heartbeatError;
      }
    });
    if (heartbeatError) throw heartbeatError;
    currentStage = "uploading";
    await renewLease();
    if (heartbeatError) throw heartbeatError;
    const key = "jobs/" + safeSegment(task.task_id) + "/" +
      safeSegment(task.scene_id) + ".mp4";
    const saved = await storage.put(key, output.buffer, output.contentType || "video/mp4");
    if (heartbeatError) throw heartbeatError;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    await heartbeatChain;
    if (heartbeatError) throw heartbeatError;
    const savedCheckpoint = await checkpoint(task.task_id, claimToken, {
      stage: "completed", provider: providerName, storage_key: saved.key
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
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatChain;
    await finish(task.task_id, claimToken, "failed", null,
      String(heartbeatError?.message || error?.message || error).slice(0, 1000));
    return { status: "failed", error: String(heartbeatError?.message || error?.message || error).slice(0, 1000) };
  }
}

export function createVideoWorker({
  provider = createProceduralVideoProvider(),
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
      logger.info?.("JoyVerse procedural FFmpeg video worker started.");
      while (!stopping) {
        try {
          const result = await this.runOnce();
          if (result.status === "idle") await delay(pollMs);
          else logger.info?.("Video task processed:", result.status, result.storage_key || result.error || "");
        } catch (error) {
          logger.error?.("Video worker error:", String(error?.message || error).slice(0, 300));
          await delay(pollMs);
        }
      }
      logger.info?.("JoyVerse procedural FFmpeg video worker stopped.");
    }
  });
}
