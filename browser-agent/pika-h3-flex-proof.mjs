import { Client } from "@gradio/client";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const outDir = "pika-proof-output";
await mkdir(outDir, { recursive: true });
const prompt = "A tiny cheerful turquoise dragon with small golden wings gently waves beside a colorful flower garden. Polished friendly 3D cartoon animation, bright joyful colors, soft warm daylight, smooth gentle motion, simple child-friendly scene, no text.";

function urlsIn(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    if (/\.mp4(?:$|\?)/i.test(value) || /\/file=/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) urlsIn(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "url" || key === "path") && typeof item === "string") {
        if (/\.mp4(?:$|\?)/i.test(item) || /\/file=/i.test(item)) out.push(item);
      } else urlsIn(item, out);
    }
  }
  return out;
}

async function main() {
  console.log("Connecting anonymously to Pika-Labs/pika-h3-flex…");
  const client = await Client.connect("Pika-Labs/pika-h3-flex");

  console.log("Submitting one child-friendly text-to-video test (5 seconds, 480p).");
  const result = await client.predict("/probe", [
    null,          // wire upload not needed for text mode
    "Text",        // generation task
    prompt,
    null,          // first frame
    null,          // last frame
    [],            // reference files
    "[]",          // reference kinds
    480,           // height
    832,           // width
    125,           // frames: 5 seconds at 25 fps
    42,            // seed
    null,          // optional tape file
    false          // exact anchor
  ]);

  const rawUrls = urlsIn(result?.data || []);
  console.log("PIKA_RESULT_META", JSON.stringify({
    dataCount: result?.data?.length ?? null,
    dataSummary: (result?.data || []).map((item, index) => ({
      index,
      type: typeof item,
      keys: item && typeof item === "object" ? Object.keys(item) : [],
      preview: JSON.stringify(item).slice(0, 500)
    })),
    candidateUrls: rawUrls.map(u => u.slice(0, 500))
  }, null, 2));

  const candidates = [];
  for (const value of result?.data || []) {
    if (typeof value === "string") candidates.push(value);
    else if (value && typeof value === "object") {
      if (typeof value.url === "string") candidates.push(value.url);
      if (typeof value.path === "string") candidates.push(value.path);
      if (value.video && typeof value.video.url === "string") candidates.push(value.video.url);
      if (value.video && typeof value.video.path === "string") candidates.push(value.video.path);
    }
  }
  const videoRef = candidates.find(v => /\.mp4(?:$|\?)/i.test(v) || /\/file=/i.test(v));
  if (!videoRef) {
    await writeFile(path.join(outDir, "result.json"), JSON.stringify({
      status: "no-video-reference",
      prompt,
      result
    }, null, 2));
    throw new Error("Pika returned no recognizable MP4 reference.");
  }

  let videoUrl;
  if (/^https?:\/\//i.test(videoRef)) {
    videoUrl = new URL(videoRef);
  } else if (videoRef.startsWith("/")) {
    videoUrl = new URL(videoRef, "https://pika-labs-pika-h3-flex.hf.space");
  } else {
    throw new Error("Unrecognized non-URL video reference; refusing to guess a download path.");
  }

  const host = videoUrl.hostname.toLowerCase();
  if (videoUrl.protocol !== "https:" ||
      !(host === "hf.space" || host.endsWith(".hf.space") ||
        host === "huggingface.co" || host.endsWith(".huggingface.co")) ||
      videoUrl.username || videoUrl.password) {
    throw new Error("Pika returned a file reference outside trusted Hugging Face hosts.");
  }

  console.log("Downloading the generated MP4…");
  const response = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("Video download failed with HTTP " + response.status + ".");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new Error("Downloaded output is not a valid MP4 file (missing ftyp signature).");
  }

  const videoPath = path.join(outDir, "joyverse-pika-h3-flex-test.mp4");
  await writeFile(videoPath, buffer);
  const fileInfo = await stat(videoPath);
  const report = {
    status: "completed",
    provider: "Pika-Labs/pika-h3-flex public Hugging Face Space",
    prompt,
    settings: { duration_seconds: 5, width: 832, height: 480, frames: 125, seed: 42 },
    file: { name: path.basename(videoPath), bytes: fileInfo.size, signature: buffer.subarray(4, 8).toString("ascii") },
    gradioOutputCount: result?.data?.length ?? null
  };
  await writeFile(path.join(outDir, "result.json"), JSON.stringify(report, null, 2));
  console.log("PIKA_PROOF_SUCCESS", JSON.stringify(report));
}

main().catch(async error => {
  const report = {
    status: "failed",
    error: String(error?.stack || error).slice(0, 6000),
    note: "No generated video is claimed unless a valid MP4 was downloaded and its ftyp signature verified."
  };
  await writeFile(path.join(outDir, "result.json"), JSON.stringify(report, null, 2));
  console.error("PIKA_PROOF_FAILED", report.error);
  process.exitCode = 1;
});
