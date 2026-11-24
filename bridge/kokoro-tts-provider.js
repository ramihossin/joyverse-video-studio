const MAX_TEXT_LENGTH = 500;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_SPACE_ID = "RobinsAIWorld/Kokoro-TTS-cpu";
const VOICES = new Set([
  "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah",
  "af_sky", "af_jessica", "af_river", "am_adam", "am_michael"
]);

function baseUrlForSpace(spaceId) {
  if (typeof spaceId !== "string" || !spaceId.trim()) throw new Error("Kokoro Space ID is required.");
  if (/^https:\/\/[a-z0-9.-]+\.hf\.space\/?$/i.test(spaceId)) {
    return new URL(spaceId.endsWith("/") ? spaceId : spaceId + "/");
  }
  const parts = spaceId.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error("Kokoro Space must use owner/space-name format.");
  }
  return new URL("https://" + parts[0].toLowerCase() + "-" + parts[1].toLowerCase() + ".hf.space/");
}

function audioUrlFor(value, baseUrl) {
  const candidate = typeof value === "string" ? value :
    (value && typeof value === "object" ? (value.url || value.path) : null);
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error("Kokoro did not return an audio file.");
  }
  const url = new URL(candidate, baseUrl);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" ||
      !(host.endsWith(".hf.space") || host === "huggingface.co" || host.endsWith(".huggingface.co")) ||
      url.username || url.password) {
    throw new Error("Kokoro returned a URL outside the trusted Hugging Face domain.");
  }
  return url;
}

function audioOutputFromPrediction(prediction) {
  const first = prediction?.data?.[0];
  if (first && typeof first === "object" && !Array.isArray(first)) return first;
  if (Array.isArray(first)) {
    const item = first.find(value => typeof value === "string" ||
      (value && typeof value === "object" && (value.url || value.path)));
    if (item) return item;
  }
  return first;
}

async function defaultClientFactory(spaceId) {
  const { Client } = await import("@gradio/client");
  return Client.connect(spaceId);
}

export function createKokoroTtsProvider({
  spaceId = process.env.KOKORO_TTS_SPACE || DEFAULT_SPACE_ID,
  clientFactory = defaultClientFactory,
  fetchImpl = fetch,
  downloadTimeoutMs = 60000
} = {}) {
  const baseUrl = baseUrlForSpace(spaceId);
  if (typeof clientFactory !== "function" || typeof fetchImpl !== "function") {
    throw new Error("Kokoro client and fetch implementations are required.");
  }
  let clientPromise;
  async function getClient() {
    if (!clientPromise) {
      clientPromise = Promise.resolve(clientFactory(spaceId)).then(client => {
        if (!client || typeof client.predict !== "function") throw new Error("Invalid Kokoro Gradio client.");
        return client;
      });
      clientPromise.catch(() => { clientPromise = undefined; });
    }
    return clientPromise;
  }
  return Object.freeze({
    name: "kokoro-gradio-tts",
    async generate({ text, voice = "af_heart", speed = 1 } = {}) {
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
        throw new Error("Voiceover text must contain 1 to 500 characters.");
      }
      if (!VOICES.has(voice)) throw new Error("Unsupported Kokoro voice.");
      if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
        throw new Error("Voice speed must be between 0.5 and 2.");
      }
      const client = await getClient();
      const prediction = await client.predict("/generate_first", [text.trim(), voice, speed, false]);
      const audioFile = audioOutputFromPrediction(prediction);
      const audioUrl = audioUrlFor(audioFile, baseUrl);
      const response = await fetchImpl(audioUrl.href, { signal: AbortSignal.timeout(downloadTimeoutMs) });
      if (!response.ok) throw new Error("Kokoro audio download failed with HTTP " + response.status + ".");
      const declared = Number(response.headers?.get?.("content-length") || 0);
      if (declared > MAX_AUDIO_BYTES) throw new Error("Kokoro audio exceeds the 20 MiB limit.");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 44 || buffer.length > MAX_AUDIO_BYTES ||
          buffer.toString("ascii", 0, 4) !== "RIFF" ||
          buffer.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("Kokoro returned an invalid WAV file.");
      }
      return { buffer, contentType: "audio/wav", bytes: buffer.length, voice, sampleRate: buffer.readUInt32LE(24) };
    }
  });
}
