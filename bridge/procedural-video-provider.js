import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

const WIDTH = 360;
const HEIGHT = 640;
const FPS = 15;
const MAX_OUTPUT_BYTES = 45 * 1024 * 1024;

function detectImageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw new Error("Reference image must be PNG, JPEG, or WebP.");
}

function paletteFor(prompt) {
  const value = String(prompt || "").toLowerCase();
  if (/pink|magenta|وردي|زهري/.test(value)) return { background: "0x271344", ball: [255, 90, 190] };
  if (/green|forest|jungle|أخضر|غابة/.test(value)) return { background: "0x102d2b", ball: [150, 255, 75] };
  if (/yellow|sun|gold|أصفر|شمس|ذهبي/.test(value)) return { background: "0x14284d", ball: [255, 220, 55] };
  if (/blue|ocean|sea|بحر|أزرق|سماء/.test(value)) return { background: "0x101f45", ball: [60, 205, 255] };
  if (/red|أحمر/.test(value)) return { background: "0x24152b", ball: [255, 75, 75] };
  return { background: "0x151b46", ball: [255, 135, 65] };
}

function buildFilter(palette, includeTitle) {
  const [red, green, blue] = palette.ball;
  const sphere = [
    "format=rgb24",
    "geq=" +
      "r='if(lt((X-(W*(0.5+0.28*sin(T*1.7))))*(X-(W*(0.5+0.28*sin(T*1.7))) )+(Y-(H*(0.48+0.18*cos(T*1.3))))*(Y-(H*(0.48+0.18*cos(T*1.3)))) ,(min(W,H)*0.16)*(min(W,H)*0.16))," + red + ",12+18*Y/H)':" +
      "g='if(lt((X-(W*(0.5+0.28*sin(T*1.7))))*(X-(W*(0.5+0.28*sin(T*1.7))) )+(Y-(H*(0.48+0.18*cos(T*1.3))))*(Y-(H*(0.48+0.18*cos(T*1.3)))) ,(min(W,H)*0.16)*(min(W,H)*0.16))," + green + ",18+18*Y/H)':" +
      "b='if(lt((X-(W*(0.5+0.28*sin(T*1.7))))*(X-(W*(0.5+0.28*sin(T*1.7))) )+(Y-(H*(0.48+0.18*cos(T*1.3))))*(Y-(H*(0.48+0.18*cos(T*1.3)))) ,(min(W,H)*0.16)*(min(W,H)*0.16))," + blue + ",55+35*Y/H)'",
    "format=yuv420p"
  ];
  if (includeTitle) {
    sphere.splice(sphere.length - 1, 0,
      "drawtext=font='DejaVu Sans':text='JOYVERSE KIDS':fontcolor=white:fontsize=25:x=(w-text_w)/2:y=h*0.12:shadowcolor=black@0.6:shadowx=2:shadowy=2");
  }
  return sphere.join(",");
}

function runFfmpeg(spawn, ffmpegPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Procedural video generation timed out."));
    }, timeoutMs);
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.once("error", error => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("FFmpeg video generation failed: " + stderr));
    });
  });
}

export function createProceduralVideoProvider({
  ffmpegPath,
  spawn = nodeSpawn,
  workRoot = tmpdir(),
  timeoutMs = 150000
} = {}) {
  return Object.freeze({
    name: "procedural-ffmpeg",
    async generate({ prompt, referenceImage = null, videoOptions = {}, onProgress } = {}) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) {
        throw new Error("A non-empty prompt up to 12000 characters is required.");
      }
      const duration = videoOptions.duration ?? 5;
      if (!Number.isInteger(duration) || duration < 1 || duration > 5) {
        throw new Error("Video duration must be from 1 to 5 seconds.");
      }
      if (referenceImage !== null && (!Buffer.isBuffer(referenceImage) || referenceImage.length === 0)) {
        throw new Error("Reference image must be a non-empty Buffer.");
      }
      if (!ffmpegPath) {
        const mod = await import("ffmpeg-static");
        ffmpegPath = mod.default;
      }
      if (typeof ffmpegPath !== "string" || !ffmpegPath) {
        throw new Error("The bundled FFmpeg executable is unavailable.");
      }

      const dir = await mkdtemp(join(workRoot, "joyverse-scene-"));
      try {
        const outputPath = join(dir, "scene.mp4");
        const args = ["-hide_banner", "-loglevel", "error", "-y"];
        let filter;
        if (referenceImage) {
          const extension = detectImageExtension(referenceImage);
          const imagePath = join(dir, "reference." + extension);
          await writeFile(imagePath, referenceImage, { flag: "wx", mode: 0o600 });
          args.push("-loop", "1", "-framerate", String(FPS), "-i", imagePath);
          filter = "scale=" + WIDTH + ":" + HEIGHT +
            ":force_original_aspect_ratio=increase,crop=" + WIDTH + ":" + HEIGHT +
            ",zoompan=z='min(zoom+0.0012,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=" +
            WIDTH + "x" + HEIGHT + ":fps=" + FPS;
        } else {
          const palette = paletteFor(prompt);
          args.push("-f", "lavfi", "-i",
            "color=c=" + palette.background + ":s=" + WIDTH + "x" + HEIGHT + ":r=" + FPS);
          filter = buildFilter(palette, true);
        }
        await onProgress?.({ stage: "generating", progress: 0.1 });
        const common = [
          "-vf", filter, "-t", String(duration), "-an",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27",
          "-pix_fmt", "yuv420p", "-threads", "2", "-movflags", "+faststart",
          outputPath
        ];
        try {
          await runFfmpeg(spawn, ffmpegPath, [...args, ...common], timeoutMs);
        } catch (error) {
          if (referenceImage) throw error;
          // Font packages are not guaranteed on minimal hosting images. Retry
          // the same scene without the optional title instead of failing a job.
          await runFfmpeg(spawn, ffmpegPath, [...args, "-vf", buildFilter(paletteFor(prompt), false),
            ...common.slice(2)], timeoutMs);
        }
        const buffer = await readFile(outputPath);
        if (buffer.length < 1024 || buffer.length > MAX_OUTPUT_BYTES ||
            buffer.subarray(4, 8).toString() !== "ftyp") {
          throw new Error("FFmpeg did not produce a valid MP4 within the storage limit.");
        }
        await onProgress?.({ stage: "completed", progress: 1 });
        return { buffer, contentType: "video/mp4", bytes: buffer.length };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
}
