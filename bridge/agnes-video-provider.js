const API_BASE = "https://apihub.agnes-ai.com";
const MODEL = "agnes-video-2.5-flash";
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const TRUSTED_OUTPUT_HOSTS = new Set(["platform-outputs.agnes-ai.space"]);

function aspectRatioFor(options = {}) {
  const values = { portrait: "9:16", landscape: "16:9", square: "1:1" };
  const value = values[options.aspect || "portrait"];
  if (!value) throw new Error("Unsupported Agnes video aspect.");
  return value;
}

function safeOutputUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Agnes returned an invalid video URL."); }
  if (url.protocol !== "https:" || !TRUSTED_OUTPUT_HOSTS.has(url.hostname.toLowerCase()) ||
      url.username || url.password) {
    throw new Error("Agnes returned a video URL outside the trusted output domain.");
  }
  return url;
}

async function readJson(response, label) {
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(label + " returned invalid JSON (HTTP " + response.status + ")."); }
  if (!response.ok) {
    const detail = typeof data.error === "string" ? data.error :
      typeof data.message === "string" ? data.message : "request rejected";
    throw new Error(label + " failed with HTTP " + response.status + ": " + detail.slice(0, 300));
  }
  return data;
}

export function createAgnesVideoProvider({
  apiKey = process.env.AGNES_API_KEY || "",
  model = process.env.AGNES_VIDEO_MODEL || MODEL,
  fetchImpl = fetch,
  pollIntervalMs = 5000,
  maxWaitMs = 15 * 60 * 1000,
  requestTimeoutMs = 60000,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("AGNES_API_KEY is required to use the Agnes video provider.");
  }
  if (model !== MODEL) throw new Error("Unsupported Agnes video model.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 30000 ||
      !Number.isInteger(maxWaitMs) || maxWaitMs < 10000 || maxWaitMs > 30 * 60 * 1000 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 180000) {
    throw new Error("Invalid Agnes polling or timeout configuration.");
  }

  const headers = { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" };
  async function request(url, options, label) {
    const response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    return readJson(response, label);
  }

  return Object.freeze({
    name: "agnes-video-2.5-flash",
    async generate({ prompt, referenceImage = null, videoOptions = {}, onProgress } = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) {
        throw new Error("A non-empty prompt up to 12000 characters is required.");
      }
      if (referenceImage !== null &&
          (!Buffer.isBuffer(referenceImage) || referenceImage.length === 0)) {
        throw new Error("Reference image must be a non-empty Buffer.");
      }
      const requestedDuration = videoOptions.duration ?? 5;
      if (!Number.isInteger(requestedDuration) || requestedDuration < 4 || requestedDuration > 12) {
        throw new Error("Agnes Video 2.5 Flash duration must be an integer from 4 to 12 seconds.");
      }
      const seconds = requestedDuration;
      const body = {
        model,
        prompt: prompt.trim(),
        mode: referenceImage ? "img2video" : "text",
        seconds: String(seconds),
        size: "720P",
        n: 1,
        aspect_ratio: aspectRatioFor(videoOptions)
      };
      if (Number.isInteger(videoOptions.seed) && videoOptions.seed >= 0) body.seed = videoOptions.seed;
      if (referenceImage) body.first_frame = "data:image/png;base64," + referenceImage.toString("base64");

      await onProgress?.({ stage: "connecting", progress: 0.02 });
      const created = await request(API_BASE + "/v1/videos", {
        method: "POST", headers, body: JSON.stringify(body)
      }, "Agnes video submission");
      const videoId = created.video_id || created.id;
      if (typeof videoId !== "string" || !videoId.trim()) {
        throw new Error("Agnes did not return a video_id.");
      }
      const deadline = now() + maxWaitMs;
      let lastProgress = 0.05;
      while (now() < deadline) {
        await sleep(pollIntervalMs);
        const pollUrl = new URL(API_BASE + "/agnesapi");
        pollUrl.searchParams.set("video_id", videoId);
        pollUrl.searchParams.set("model_name", model);
        const status = await request(pollUrl.href, { method: "GET", headers }, "Agnes video status");
        const state = String(status.status || "").toLowerCase();
        if (state === "failed" || state === "error") {
          throw new Error("Agnes video generation failed: " +
            String(status.error || "provider reported failure").slice(0, 500));
        }
        if (state === "completed" || state === "succeeded" || state === "success") {
          const outputUrl = safeOutputUrl(status.url || status.video_url);
          await onProgress?.({ stage: "downloading", progress: 0.9 });
          const download = await fetchImpl(outputUrl.href, {
            signal: AbortSignal.timeout(requestTimeoutMs)
          });
          if (!download.ok) throw new Error("Agnes video download failed with HTTP " + download.status + ".");
          const declaredLength = Number(download.headers?.get?.("content-length") || 0);
          if (declaredLength > MAX_OUTPUT_BYTES) throw new Error("Agnes output exceeds the 100 MiB limit.");
          const buffer = Buffer.from(await download.arrayBuffer());
          if (buffer.length < 12 || buffer.length > MAX_OUTPUT_BYTES ||
              buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
            throw new Error("Agnes response is not a valid MP4 within the 100 MiB limit.");
          }
          await onProgress?.({ stage: "completed", progress: 1 });
          return { buffer, contentType: "video/mp4", bytes: buffer.length };
        }
        const progress = Number(status.progress);
        if (Number.isFinite(progress)) {
          lastProgress = Math.max(lastProgress, Math.min(0.85, 0.05 + progress / 100 * 0.8));
        }
        await onProgress?.({ stage: "generating", progress: lastProgress });
      }
      throw new Error("Agnes video generation timed out before a completed video was available.");
    }
  });
}
