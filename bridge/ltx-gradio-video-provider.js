const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_SPACE_ID = "Lightricks/LTX-2.5";

function dimensionsFor(options = {}) {
  const presets = {
    portrait: { width: 832, height: 1472 },
    landscape: { width: 1472, height: 832 },
    square: { width: 1024, height: 1024 }
  };
  const preset = presets[options.aspect || "portrait"];
  if (!preset) throw new Error("Unsupported LTX video aspect.");
  const width = options.width ?? preset.width;
  const height = options.height ?? preset.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 512 || height < 512 || width > 2048 || height > 2048 ||
      width % 64 !== 0 || height % 64 !== 0) {
    throw new Error("LTX width and height must be integers from 512 to 2048 and divisible by 64.");
  }
  return { width, height };
}

function baseUrlForSpace(spaceId) {
  if (typeof spaceId !== "string" || !spaceId.trim()) {
    throw new Error("LTX_GRADIO_SPACE must be a Hugging Face Space ID.");
  }
  if (/^https:\/\/[a-z0-9.-]+\.hf\.space\/?$/i.test(spaceId)) {
    return new URL(spaceId.endsWith("/") ? spaceId : spaceId + "/");
  }
  const parts = spaceId.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error("LTX_GRADIO_SPACE must use owner/space-name format.");
  }
  return new URL("https://" + parts[0].toLowerCase() + "-" + parts[1].toLowerCase() + ".hf.space/");
}

function outputUrlFor(file, baseUrl) {
  const value = typeof file === "string" ? file :
    (file && typeof file === "object" ? (file.url || file.path) : null);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("LTX Gradio did not return a video file.");
  }
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new Error("LTX Gradio returned an invalid video URL.");
  }
  const host = url.hostname.toLowerCase();
  const trustedHost = host.endsWith(".hf.space") ||
    host === "huggingface.co" || host.endsWith(".huggingface.co");
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    throw new Error("LTX Gradio returned a video URL outside the trusted Hugging Face domain.");
  }
  return url;
}

async function defaultClientFactory(spaceId, token) {
  const { Client, handle_file } = await import("@gradio/client");
  const options = token ? { token } : {};
  const client = await Client.connect(spaceId, options);
  return { client, handleFile: handle_file };
}

export function createLtxGradioVideoProvider({
  spaceId = process.env.LTX_GRADIO_SPACE || DEFAULT_SPACE_ID,
  token = process.env.HF_TOKEN || "",
  clientFactory = defaultClientFactory,
  fetchImpl = fetch,
  downloadTimeoutMs = 60000
} = {}) {
  const baseUrl = baseUrlForSpace(spaceId);
  if (token && (typeof token !== "string" || !token.startsWith("hf_"))) {
    throw new Error("HF_TOKEN must be a Hugging Face token when configured.");
  }
  if (typeof clientFactory !== "function" || typeof fetchImpl !== "function") {
    throw new Error("LTX Gradio client and fetch implementations are required.");
  }
  if (!Number.isInteger(downloadTimeoutMs) || downloadTimeoutMs < 1000 || downloadTimeoutMs > 180000) {
    throw new Error("downloadTimeoutMs must be from 1000 to 180000.");
  }

  let clientPromise;
  async function getClient() {
    if (!clientPromise) {
      clientPromise = clientFactory(spaceId, token).then(value => {
        if (!value?.client || typeof value.client.predict !== "function" ||
            typeof value.handleFile !== "function") {
          throw new Error("LTX Gradio client factory returned an invalid client.");
        }
        return value;
      });
      clientPromise.catch(() => { clientPromise = undefined; });
    }
    return clientPromise;
  }

  return Object.freeze({
    name: "ltx-gradio",
    async generate({ prompt, referenceImage = null, videoOptions = {}, onProgress } = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) {
        throw new Error("A non-empty prompt up to 12000 characters is required.");
      }
      if (referenceImage !== null &&
          (!Buffer.isBuffer(referenceImage) || referenceImage.length === 0)) {
        throw new Error("Reference image must be a non-empty Buffer.");
      }
      const duration = videoOptions.duration ?? 5;
      if (!Number.isInteger(duration) || duration < 1 || duration > 5) {
        throw new Error("LTX duration must be an integer from 1 to 5 seconds.");
      }
      const { width, height } = dimensionsFor(videoOptions);
      const seed = videoOptions.seed ?? 42;
      if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
        throw new Error("LTX seed must be an integer from 0 to 2147483647.");
      }
      const decoder = "conv";
      const randomizeSeed = videoOptions.randomize_seed === true;
      const enhancePrompt = videoOptions.enhance_prompt === true;

      await onProgress?.({ stage: "connecting", progress: 0.02 });
      const { client, handleFile } = await getClient();
      const imageInput = referenceImage ? handleFile(referenceImage) : null;
      await onProgress?.({ stage: "queued", progress: 0.05 });

      // This is the public run endpoint wired to the Space's Generate button.
      // Arguments: prompt, image, height, width, duration, seed, decoder,
      // auto length, randomize seed, and prompt enhancement.
      const prediction = await client.predict("/run", [
        prompt, imageInput, height, width, duration, seed, decoder,
        false, randomizeSeed, enhancePrompt
      ]);
      await onProgress?.({ stage: "downloading", progress: 0.9 });

      const videoUrl = outputUrlFor(prediction?.data?.[0], baseUrl);
      const headers = token ? { Authorization: "Bearer " + token } : {};
      const response = await fetchImpl(videoUrl.href, {
        headers,
        signal: AbortSignal.timeout(downloadTimeoutMs)
      });
      if (!response.ok) {
        throw new Error("LTX video download failed with HTTP " + response.status + ".");
      }
      const declaredLength = Number(response.headers?.get?.("content-length") || 0);
      if (declaredLength > MAX_OUTPUT_BYTES) {
        throw new Error("LTX output exceeds the 100 MiB video limit.");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 12 || buffer.length > MAX_OUTPUT_BYTES ||
          buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
        throw new Error("LTX Gradio response is not a valid MP4 within the 100 MiB limit.");
      }
      await onProgress?.({ stage: "completed", progress: 1 });
      return { buffer, contentType: "video/mp4", bytes: buffer.length };
    }
  });
}
