import { setTimeout as delay } from "node:timers/promises";
import {
  initializeTaskStore, claimNextVideoTask, updateTaskCheckpoint, finishTask
} from "./task-store.js";
import { createLtxGradioVideoProvider } from "./ltx-gradio-video-provider.js";
import { createAgnesVideoProvider } from "./agnes-video-provider.js";
import { createNiftyVidWanProvider } from "./niftyvid-wan-provider.js";

export function createDefaultVideoProvider(env = process.env) {
  const selected = String(env.VIDEO_PROVIDER || "ltx").toLowerCase();
  if (selected === "agnes") return createAgnesVideoProvider({
    apiKey: env.AGNES_API_KEY,
    model: env.AGNES_VIDEO_MODEL || "agnes-video-2.5-flash"
  });
  if (selected === "niftyvid-wan") return createNiftyVidWanProvider({
    spaceUrl: env.NIFTYVID_SPACE_URL || undefined
  });
  if (selected === "ltx") return createLtxGradioVideoProvider();
  throw new Error("VIDEO_PROVIDER must be one of agnes, ltx, or niftyvid-wan.");
}
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

  const providerName = provider.name || task.provider || "custom-video-provider";
  if (task.attempts > 1 && task.provider === providerName &&
      ["submitting", "provider_queued", "generating", "downloading", "uploading"].includes(task.stage) &&
      !task.storage_key && !task.provider_job_id) {
    const reason = "The previous worker stopped after submitting to the provider without a resumable provider job ID. The task was not submitted again, to avoid duplicate generation and quota consumption.";
    await finish(task.task_id, claimToken, "failed", null, reason);
    return { status: "failed", reason: "provider_resume_unavailable", error: reason };
  }
  let heartbeatTimer = null;
  let heartbeatChain = Promise.resolve();
  let heartbeatError = null;
  let currentStage = task.provider_job_id ? "provider_queued" : "submitting";
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
      stage: currentStage, provider: providerName
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
      providerJobId: task.provider_job_id || null,
      onJobCreated: async providerJobId => {
        if (typeof providerJobId !== "string" || !providerJobId.trim() || providerJobId.length > 2048) {
          throw new Error("Video provider returned an invalid resumable job ID.");
        }
        currentStage = "provider_queued";
        const saved = await checkpoint(task.task_id, claimToken, {
          stage: currentStage, provider: providerName, provider_job_id: providerJobId
        });
        if (!saved) throw new Error("Task claim expired before the provider job ID could be persisted.");
        if (heartbeatError) throw heartbeatError;
      },
      onProgress: async progress => {
        currentStage = progress?.stage === "downloading" ? "downloading" : "generating";
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
  provider = createDefaultVideoProvider(),
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
      logger.info?.("JoyVerse " + (provider.name || "video") + " video worker started.");
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
      logger.info?.("JoyVerse video worker stopped.");
    }
  });
}
