import { Client, handle_file } from "@gradio/client";
import { normalizeVideoOptions } from "./video-job.js";

const SPACE = "Lightricks/LTX-2.5";
const ENDPOINT = "/run";
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

function findOutputUrl(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (typeof value.url === "string") return value.url;
  for (const child of Object.values(value)) {
    const found = findOutputUrl(child, seen);
    if (found) return found;
  }
  return null;
}

function validateProviderUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("LTX returned an invalid output URL."); }
  const host = url.hostname.toLowerCase();
  const allowed = host === "hf.space" || host.endsWith(".hf.space") ||
    host === "huggingface.co" || host.endsWith(".huggingface.co") ||
    host.endsWith(".huggingfaceusercontent.com") ||
    host === "gradio.live" || host.endsWith(".gradio.live");
  if (url.protocol !== "https:" || !allowed || url.username || url.password) {
    throw new Error("LTX returned an output URL outside the approved Hugging Face/Gradio hosts.");
  }
  return url.toString();
}

export function createLtxProvider({
  clientConnect = Client.connect,
  fileHandler = handle_file,
  fetchImpl = fetch,
  space = process.env.LTX_SPACE || SPACE,
  endpoint = ENDPOINT,
  token = process.env.HF_TOKEN || "",
  maxOutputBytes = MAX_OUTPUT_BYTES
} = {}) {
  return Object.freeze({
    async generate({ prompt, videoOptions = {}, referenceImage = null, onProgress } = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) {
        throw new Error("A non-empty prompt up to 12000 characters is required.");
      }
      const options = normalizeVideoOptions(videoOptions);
      if (referenceImage !== null &&
          (!Buffer.isBuffer(referenceImage) || referenceImage.length === 0)) {
        throw new Error("Reference image must be a non-empty Buffer.");
      }

      const clientOptions = { events: ["data", "status"] };
      if (token) clientOptions.token = token;
      const client = await clientConnect(space, clientOptions);
      const imageInput = referenceImage ? fileHandler(referenceImage) : null;
      const submission = client.submit(endpoint, [
        prompt, imageInput, options.height, options.width, options.duration,
        options.seed, options.decoder, options.auto_len,
        options.randomize_seed, options.enhance_prompt
      ]);

      let outputData = null;
      for await (const message of submission) {
        if (message?.type === "status") {
          const status = message.status || message.stage;
          if (status === "error" || message.success === false) {
            throw new Error(message.message || "LTX generation failed.");
          }
          if (typeof onProgress === "function") {
            await onProgress({
              stage: status || "generating",
              position: message.position ?? null,
              eta: message.eta ?? null
            });
          }
        } else if (message?.type === "data") {
          outputData = message.data;
        }
      }

      const outputUrl = findOutputUrl(outputData);
      if (!outputUrl) throw new Error("LTX completed without a downloadable video URL.");
      const safeUrl = validateProviderUrl(outputUrl);
      const response = await fetchImpl(safeUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(120000)
      });
      if (!response.ok) throw new Error("LTX output download failed with HTTP " + response.status + ".");
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > maxOutputBytes) throw new Error("LTX output exceeds the 100 MiB download limit.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > maxOutputBytes) {
        throw new Error("LTX output is empty or exceeds the 100 MiB download limit.");
      }
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
        throw new Error("LTX returned an unexpected output content type.");
      }
      return { buffer: bytes, contentType, bytes: bytes.length };
    }
  });
}
