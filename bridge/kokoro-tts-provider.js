const MAX_TEXT_LENGTH = 500;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_SPACE_URL = "https://robinsaiworld-kokoro-tts-cpu.hf.space";
const VOICES = new Set([
  "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah",
  "af_sky", "af_jessica", "af_river", "am_adam", "am_michael"
]);

function baseUrlForSpace(value) {
  const configured = value || process.env.KOKORO_TTS_SPACE_URL || process.env.KOKORO_TTS_SPACE || DEFAULT_SPACE_URL;
  if (typeof configured !== "string" || !configured.trim()) throw new Error("Kokoro Space URL is required.");
  if (!configured.startsWith("https://")) {
    const parts = configured.split("/");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part))) {
      throw new Error("Kokoro Space must be an HTTPS URL or owner/space-name.");
    }
    return new URL("https://" + parts[0].toLowerCase() + "-" + parts[1].toLowerCase() + ".hf.space");
  }
  let url;
  try { url = new URL(configured); } catch { throw new Error("Kokoro Space URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Kokoro Space URL must use HTTPS without credentials, query, or fragment.");
  }
  return url.origin;
}

function parseCompletedAudio(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  let currentEvent = "message";
  let currentData = [];
  const blocks = [];
  for (const line of lines) {
    if (line === "") {
      if (currentEvent !== "message" || currentData.length) blocks.push({ event: currentEvent, data: currentData.join("\n") });
      currentEvent = "message";
      currentData = [];
    } else if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
    else if (line.startsWith("data:")) currentData.push(line.slice(5).trim());
  }
  if (currentEvent !== "message" || currentData.length) blocks.push({ event: currentEvent, data: currentData.join("\n") });
  let providerError = "";
  for (const block of blocks) {
    if (block.event === "error") { providerError = block.data; continue; }
    if (block.event !== "complete" || !block.data) continue;
    let payload;
    try { payload = JSON.parse(block.data); }
    catch { throw new Error("Kokoro returned malformed completion JSON."); }
    const candidates = Array.isArray(payload) ? payload : [payload];
    const file = candidates.find(item => item && typeof item === "object" &&
      (typeof item.url === "string" || typeof item.path === "string"));
    if (!file) throw new Error("Kokoro completed without an audio file reference.");
    return file;
  }
  if (providerError) throw new Error("Kokoro generation failed: " + providerError.slice(0, 800));
  throw new Error("Kokoro event stream ended without a completed audio file.");
}

function resolveAudioUrl(file, baseUrl) {
  const raw = typeof file.url === "string" && file.url ? file.url :
    typeof file.path === "string" && file.path ? "/gradio_api/file=" + file.path : "";
  if (!raw) throw new Error("Kokoro returned an empty audio file reference.");
  let url;
  try { url = new URL(raw, baseUrl); } catch { throw new Error("Kokoro returned an invalid audio URL."); }
  const base = new URL(baseUrl);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0") {
    if (!file.path) throw new Error("Kokoro returned a local-only audio URL.");
    url = new URL("/gradio_api/file=" + file.path, baseUrl);
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== base.hostname.toLowerCase() ||
      url.port !== base.port || url.username || url.password) {
    throw new Error("Kokoro returned an audio URL outside the configured Space.");
  }
  return url;
}

export function createKokoroTtsProvider({
  spaceUrl,
  fetchImpl = fetch,
  requestTimeoutMs = 10 * 60 * 1000,
  maxAudioBytes = MAX_AUDIO_BYTES
} = {}) {
  const baseUrl = baseUrlForSpace(spaceUrl);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 15 * 60 * 1000) {
    throw new Error("Kokoro timeout must be from 1000 to 900000 milliseconds.");
  }
  if (!Number.isInteger(maxAudioBytes) || maxAudioBytes < 44 || maxAudioBytes > 100 * 1024 * 1024) {
    throw new Error("Kokoro audio size limit is invalid.");
  }

  async function request(url, options = {}) {
    return fetchImpl(url, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) });
  }

  return Object.freeze({
    name: "kokoro-cpu-tts",
    async generate({ text, voice = "af_heart", speed = 1, providerJobId = null, onJobCreated, onProgress } = {}) {
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
        throw new Error("Voiceover text must contain 1 to 500 characters.");
      }
      if (!VOICES.has(voice)) throw new Error("Unsupported Kokoro voice.");
      if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
        throw new Error("Voice speed must be between 0.5 and 2.");
      }
      let eventId = providerJobId;
      if (eventId !== null && (typeof eventId !== "string" || !eventId.trim() || eventId.length > 2048)) {
        throw new Error("Kokoro event ID is invalid.");
      }

      if (!eventId) {
        await onProgress?.({ stage: "submitting", progress: 0.05 });
        const accepted = await request(baseUrl + "/gradio_api/call/generate_first", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: [text.trim(), voice, speed, false] })
        });
        const acceptedText = await accepted.text();
        if (!accepted.ok) throw new Error("Kokoro submission failed with HTTP " + accepted.status + ": " + acceptedText.slice(0, 500));
        let submission;
        try { submission = JSON.parse(acceptedText); }
        catch { throw new Error("Kokoro submission returned invalid JSON."); }
        eventId = submission.event_id;
        if (typeof eventId !== "string" || !eventId.trim()) throw new Error("Kokoro did not return a resumable event ID.");
        await onJobCreated?.(eventId);
      }

      await onProgress?.({ stage: "generating", progress: 0.25 });
      const stream = await request(baseUrl + "/gradio_api/call/generate_first/" + encodeURIComponent(eventId), {
        method: "GET",
        headers: { Accept: "text/event-stream" }
      });
      const streamText = await stream.text();
      if (!stream.ok) throw new Error("Kokoro event stream failed with HTTP " + stream.status + ": " + streamText.slice(0, 500));
      const file = parseCompletedAudio(streamText);
      const audioUrl = resolveAudioUrl(file, baseUrl);

      await onProgress?.({ stage: "downloading", progress: 0.85 });
      let download = await request(audioUrl.href, { method: "GET" });
      if (!download.ok && file.path) {
        download = await request(baseUrl + "/gradio_api/file=" + file.path, { method: "GET" });
      }
      if (!download.ok && file.path) {
        download = await request(baseUrl + "/file=" + file.path, { method: "GET" });
      }
      if (!download.ok) throw new Error("Kokoro audio download failed with HTTP " + download.status + ".");
      const declared = Number(download.headers?.get?.("content-length") || 0);
      if (declared > maxAudioBytes) throw new Error("Kokoro audio exceeds the configured size limit.");
      const buffer = Buffer.from(await download.arrayBuffer());
      if (buffer.length < 44 || buffer.length > maxAudioBytes ||
          buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("Kokoro returned an invalid WAV file.");
      }
      const sampleRate = buffer.readUInt32LE(24);
      const byteRate = buffer.readUInt32LE(28);
      const dataBytes = buffer.readUInt32LE(40);
      const durationSeconds = byteRate > 0 ? dataBytes / byteRate : 0;
      if (sampleRate < 8000 || sampleRate > 96000 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("Kokoro returned invalid WAV metadata.");
      }
      await onProgress?.({ stage: "completed", progress: 1 });
      return { buffer, contentType: "audio/wav", bytes: buffer.length, voice, sampleRate, durationSeconds };
    }
  });
}
