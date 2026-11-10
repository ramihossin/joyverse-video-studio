import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

const MAX_CLIPS = 40;
const MAX_CLIP_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export async function assembleMp4(clips, {
  ffmpegPath,
  spawn = nodeSpawn,
  workRoot = tmpdir(),
  timeoutMs = 180000
} = {}) {
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > MAX_CLIPS) {
    throw new Error("Assembly requires between 1 and 40 clips.");
  }
  let total = 0;
  for (const clip of clips) {
    if (!Buffer.isBuffer(clip) || clip.length === 0 || clip.length > MAX_CLIP_BYTES) {
      throw new Error("Each clip must be a non-empty MP4 buffer up to 100 MiB.");
    }
    total += clip.length;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Combined input exceeds 500 MiB.");
  if (!ffmpegPath) {
    const mod = await import("ffmpeg-static");
    ffmpegPath = mod.default;
  }
  if (typeof ffmpegPath !== "string" || !ffmpegPath) throw new Error("FFmpeg binary is unavailable.");

  const dir = await mkdtemp(join(workRoot, "joyverse-ffmpeg-"));
  try {
    const list = [];
    for (let i = 0; i < clips.length; i++) {
      const name = "clip-" + String(i).padStart(3, "0") + ".mp4";
      await writeFile(join(dir, name), clips[i], { flag: "wx", mode: 0o600 });
      list.push("file '" + name + "'");
    }
    await writeFile(join(dir, "inputs.txt"), list.join("\n") + "\n", { flag: "wx", mode: 0o600 });
    const output = join(dir, "final.mp4");
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "1", "-i", join(dir, "inputs.txt"),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-movflags", "+faststart", output
      ], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { child.kill("SIGKILL"); settled = true; reject(new Error("FFmpeg assembly timed out.")); }
      }, timeoutMs);
      child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.once("error", error => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      });
      child.once("close", code => {
        if (!settled) {
          settled = true; clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error("FFmpeg failed with exit code " + code + ": " + stderr));
        }
      });
    });
    const result = await readFile(output);
    if (result.length < 12 || result.subarray(4, 8).toString() !== "ftyp") {
      throw new Error("FFmpeg output is not a valid MP4 container.");
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
