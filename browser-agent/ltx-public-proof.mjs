import { Client } from "@gradio/client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = "ltx-proof-output";
await mkdir(outDir, { recursive: true });

const prompt = "A tiny cheerful turquoise dragon with small golden wings waves beside a bright flower garden. Polished friendly 3D cartoon animation, smooth gentle movement, warm daylight, colorful joyful setting, simple composition, no text.";

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return String(value || "").slice(0, 300);
  }
}

async function main() {
  const spaceId = "Lightricks/LTX-2.5";
  const options = process.env.HF_TOKEN ? { token: process.env.HF_TOKEN } : {};
  console.log("Connecting to the official public LTX-2.5 Gradio Space…");
  const client = await Client.connect(spaceId, options);

  // Public API signature verified against the current official Space:
  // prompt, image, height, width, duration_s, seed, decoder,
  // auto_len, randomize_seed, do_enhance.
  console.log("Submitting one anonymous shared-queue test (2 seconds, 512x512).");
  const result = await client.predict("/run", [
    prompt,
    null,
    512,
    512,
    2.0,
    42,
    "conv",
    false,
    false,
    false
  ]);

  const file = result?.data?.[0];
  const rawUrl = typeof file === "string" ? file : file?.url || file?.path;
  if (!rawUrl) throw new Error("The Space returned no video file.");

  const base = "https://lightricks-ltx-2-5.hf.space/";
  const videoUrl = new URL(rawUrl, base);
  const host = videoUrl.hostname.toLowerCase();
  if (videoUrl.protocol !== "https:" ||
      !(host.endsWith(".hf.space") || host === "huggingface.co" || host.endsWith(".huggingface.co")) ||
      videoUrl.username || videoUrl.password) {
    throw new Error("The Space returned a download URL outside the trusted Hugging Face domain.");
  }

  console.log("Generation returned a video reference. Downloading MP4…");
  const response = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("Video download failed with HTTP " + response.status + ".");
  const buffer = Buffer.from(await response.arrayBuffer());
  const signature = buffer.subarray(4, 8).toString("ascii");
  if (buffer.length < 12 || signature !== "ftyp") {
    throw new Error("The downloaded file is not a valid MP4 (missing ftyp signature).");
  }

  const videoPath = path.join(outDir, "joyverse-ltx-test.mp4");
  await writeFile(videoPath, buffer);

  const report = {
    status: "completed",
    provider: "Lightricks/LTX-2.5 public Gradio Space",
    prompt,
    settings: { duration_seconds: 2, width: 512, height: 512, seed: 42 },
    file: { name: path.basename(videoPath), bytes: buffer.length, signature },
    result_summary: Array.isArray(result?.data) ? result.data.slice(1).map(v => String(v).slice(0, 120)) : []
  };
  await writeFile(path.join(outDir, "result.json"), JSON.stringify(report, null, 2));
  console.log("LTX_PROOF_SUCCESS", JSON.stringify(report));
}

main().catch(async error => {
  const report = {
    status: "failed",
    error: String(error?.stack || error).slice(0, 5000),
    note: "No video was reported as generated unless a valid MP4 was downloaded and checked."
  };
  await writeFile(path.join(outDir, "result.json"), JSON.stringify(report, null, 2));
  console.error("LTX_PROOF_FAILED", report.error);
  process.exitCode = 1;
});
