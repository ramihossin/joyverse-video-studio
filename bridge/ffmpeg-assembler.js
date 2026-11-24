import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

const MAX_CLIPS = 40;
const MAX_CLIP_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_AUDIO_TRACKS = 4;
const MAX_AUDIO_TRACK_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_AUDIO_BYTES = 100 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "m4a", "aac", "ogg", "flac"]);

export async function assembleMp4(clips, {
  ffmpegPath,
  spawn = nodeSpawn,
  workRoot = tmpdir(),
  timeoutMs = 180000,
  audioTracks = []
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
  if (!Array.isArray(audioTracks) || audioTracks.length > MAX_AUDIO_TRACKS) {
    throw new Error("Audio tracks must be an array containing at most 4 tracks.");
  }
  let totalAudio = 0;
  for (const track of audioTracks) {
    if (!track || !Buffer.isBuffer(track.buffer) || track.buffer.length === 0 ||
        track.buffer.length > MAX_AUDIO_TRACK_BYTES) {
      throw new Error("Each audio track must be a non-empty audio buffer up to 50 MiB.");
    }
    if (!AUDIO_EXTENSIONS.has(track.extension)) {
      throw new Error("Audio track extension must be wav, mp3, m4a, aac, ogg, or flac.");
    }
    totalAudio += track.buffer.length;
  }
  if (totalAudio > MAX_TOTAL_AUDIO_BYTES) throw new Error("Combined audio exceeds 100 MiB.");
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
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "1", "-i", join(dir, "inputs.txt")
    ];
    for (let i = 0; i < audioTracks.length; i++) {
      const track = audioTracks[i];
      const name = "audio-" + String(i).padStart(3, "0") + "." + track.extension;
      await writeFile(join(dir, name), track.buffer, { flag: "wx", mode: 0o600 });
      args.push("-i", join(dir, name));
    }
    if (audioTracks.length > 0) {
      const filters = audioTracks.map((track, i) =>
        "[" + (i + 1) + ":a:0]volume=" + (Number.isFinite(track.volume) ? Math.max(0, Math.min(2, track.volume)) : 1) + "[a" + i + "]"
      );
      const inputs = audioTracks.map((_, i) => "[a" + i + "]").join("");
      filters.push(inputs + "amix=inputs=" + audioTracks.length + ":duration=longest:dropout_transition=2,apad[aout]");
      args.push(
        "-filter_complex", filters.join(";"),
        "-map", "0:v:0", "-map", "[aout]"
      );
    }
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "192k", "-shortest",
      "-movflags", "+faststart", output
    );
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
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
