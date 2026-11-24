const DEFAULT_SPACE_URL = "https://cbensimon-wan2-2-fp8da-aoti-preview2.hf.space";
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_NEGATIVE_PROMPT = "blurry, distorted, low quality, text, watermark";

function readSpaceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("NIFTYVID_SPACE_URL must be a valid HTTPS URL."); }
  if (url.protocol !== "https:") {
    throw new Error("NIFTYVID_SPACE_URL must be an HTTPS URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("NIFTYVID_SPACE_URL must not include credentials, query, or fragment.");
  }
  return url.origin;
}

async function responseText(response, label) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(label + " failed with HTTP " + response.status + ": " + body.slice(0, 500));
  }
  return body;
}

function parseSseOutput(raw) {
  let lastError = "";
  for (const block of raw.replace(/\r\n/g, "\n").split("\n\n")) {
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (eventName === "error") {
      lastError = dataLines.join("\n").slice(0, 800) || "NiftyVid reported an upstream error.";
      continue;
    }
    if (eventName !== "complete" || dataLines.length === 0) continue;
    let payload;
    try { payload = JSON.parse(dataLines.join("\n")); }
    catch { throw new Error("NiftyVid completed with malformed JSON."); }
    const candidates = Array.isArray(payload) ? payload : [payload];
    const file = candidates.find(item => item && typeof item === "object" &&
      (typeof item.url === "string" || typeof item.path === "string"));
    if (!file) throw new Error("NiftyVid completed without a video file reference.");
    return file;
  }
  if (lastError) throw new Error("NiftyVid generation failed: " + lastError);
  throw new Error("NiftyVid event stream ended without a completed video.");
}

function safeOutputUrl(file, spaceUrl) {
  const raw = typeof file.url === "string" && file.url ? file.url :
    typeof file.path === "string" && file.path ? "/gradio_api/file=" + file.path : "";
  if (!raw) throw new Error("NiftyVid returned an empty video file reference.");
  let url;
  try { url = new URL(raw, spaceUrl); } catch { throw new Error("NiftyVid returned an invalid video URL."); }
  const expected = new URL(spaceUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== expected.hostname.toLowerCase() ||
      url.port !== expected.port || url.username || url.password) {
    throw new Error("NiftyVid returned a video URL outside the configured Space.");
  }
  return url;
}

export function createNiftyVidWanProvider({
  spaceUrl = process.env.NIFTYVID_SPACE_URL || DEFAULT_SPACE_URL,
  fetchImpl = fetch,
  requestTimeoutMs = 10 * 60 * 1000,
  maxOutputBytes = MAX_OUTPUT_BYTES
} = {}) {
  const baseUrl = readSpaceUrl(spaceUrl);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 15 * 60 * 1000) {
    throw new Error("NiftyVid request timeout must be from 1000 to 900000 milliseconds.");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 12 || maxOutputBytes > 500 * 1024 * 1024) {
    throw new Error("NiftyVid output size limit is invalid.");
  }

  async function request(url, options, label) {
    const response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    return response;
  }

  return Object.freeze({
    name: "niftyvid-wan2-i2v",
    async generate({
      prompt,
      referenceImage = null,
      videoOptions = {},
      providerJobId = null,
      onJobCreated,
      onProgress
    } = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) {
        throw new Error("A non-empty NiftyVid prompt up to 12000 characters is required.");
      }
      if (!Buffer.isBuffer(referenceImage) || referenceImage.length === 0) {
        throw new Error("NiftyVid Wan 2.2 requires a non-empty reference image Buffer.");
      }
      const duration = videoOptions.duration ?? 3.5;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0.5 || duration > 4.5) {
        throw new Error("NiftyVid duration must be from 0.5 to 4.5 seconds.");
      }
      const steps = videoOptions.steps ?? 6;
      const seed = videoOptions.seed ?? 42;
      const quality = videoOptions.quality ?? 6;
      if (!Number.isInteger(steps) || steps < 1 || steps > 30) {
        throw new Error("NiftyVid inference steps must be an integer from 1 to 30.");
      }
      if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
        throw new Error("NiftyVid seed must be an integer from 0 to 2147483647.");
      }
      if (!Number.isInteger(quality) || quality < 1 || quality > 10) {
        throw new Error("NiftyVid quality must be an integer from 1 to 10.");
      }

      let eventId = providerJobId;
      if (eventId !== null && (typeof eventId !== "string" || !eventId.trim() || eventId.length > 2048)) {
        throw new Error("NiftyVid provider event ID is invalid.");
      }

      if (!eventId) {
        await onProgress?.({ stage: "uploading", progress: 0.04 });
        const form = new FormData();
        form.append("files", new Blob([referenceImage], { type: "image/png" }), "joyverse-reference.png");
        const uploadResponse = await request(baseUrl + "/gradio_api/upload", {
          method: "POST",
          body: form
        }, "NiftyVid image upload");
        const uploadText = await responseText(uploadResponse, "NiftyVid image upload");
        let uploaded;
        try { uploaded = JSON.parse(uploadText); }
        catch { throw new Error("NiftyVid image upload returned invalid JSON."); }
        const imagePath = Array.isArray(uploaded) ? uploaded[0] : null;
        if (typeof imagePath !== "string" || !imagePath.trim()) {
          throw new Error("NiftyVid image upload did not return a file path.");
        }

        const image = {
          path: imagePath,
          url: baseUrl + "/gradio_api/file=" + imagePath,
          orig_name: "joyverse-reference.png",
          size: referenceImage.length,
          mime_type: "image/png",
          meta: { _type: "gradio.FileData" }
        };
        const data = [
          image,
          null,
          prompt.trim(),
          steps,
          String(videoOptions.negativePrompt || DEFAULT_NEGATIVE_PROMPT),
          duration,
          1,
          1,
          seed,
          videoOptions.randomizeSeed === true,
          quality,
          "UniPCMultistep",
          3.0,
          16,
          false,
          true
        ];
        await onProgress?.({ stage: "submitting", progress: 0.08 });
        const submitResponse = await request(baseUrl + "/gradio_api/call/generate_video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data })
        }, "NiftyVid video submission");
        const submitText = await responseText(submitResponse, "NiftyVid video submission");
        let submitted;
        try { submitted = JSON.parse(submitText); }
        catch { throw new Error("NiftyVid video submission returned invalid JSON."); }
        eventId = submitted.event_id;
        if (typeof eventId !== "string" || !eventId.trim()) {
          throw new Error("NiftyVid did not return a resumable event ID.");
        }
        await onJobCreated?.(eventId);
      }

      await onProgress?.({ stage: "generating", progress: 0.2 });
      const eventUrl = baseUrl + "/gradio_api/call/generate_video/" + encodeURIComponent(eventId);
      const eventResponse = await request(eventUrl, {
        method: "GET",
        headers: { Accept: "text/event-stream" }
      }, "NiftyVid generation stream");
      const eventText = await responseText(eventResponse, "NiftyVid generation stream");
      const file = parseSseOutput(eventText);
      const outputUrl = safeOutputUrl(file, baseUrl);

      await onProgress?.({ stage: "downloading", progress: 0.9 });
      const download = await request(outputUrl.href, { method: "GET" }, "NiftyVid video download");
      if (!download.ok) throw new Error("NiftyVid video download failed with HTTP " + download.status + ".");
      const declaredLength = Number(download.headers?.get?.("content-length") || 0);
      if (declaredLength > maxOutputBytes) throw new Error("NiftyVid output exceeds the configured size limit.");
      const buffer = Buffer.from(await download.arrayBuffer());
      if (buffer.length < 12 || buffer.length > maxOutputBytes ||
          buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
        throw new Error("NiftyVid response is not a valid MP4 within the configured size limit.");
      }
      await onProgress?.({ stage: "completed", progress: 1 });
      return { buffer, contentType: "video/mp4", bytes: buffer.length };
    }
  });
}
