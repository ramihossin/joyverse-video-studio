const MAX_CLIPS = 8;
const MAX_CLIP_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 350 * 1024 * 1024;

function dimensionsFor(aspect) {
  if (aspect === "landscape") return { width: 1280, height: 720 };
  if (aspect === "square") return { width: 720, height: 720 };
  return { width: 720, height: 1280 };
}

async function loadFFmpeg(onProgress) {
  const { FFmpeg } = await import(
    "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js"
  );
  const ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    if (Number.isFinite(progress)) onProgress(Math.max(0, Math.min(1, progress)));
  });

  const coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd";
  const [coreResponse, wasmResponse] = await Promise.all([
    fetch(coreBase + "/ffmpeg-core.js"),
    fetch(coreBase + "/ffmpeg-core.wasm")
  ]);
  if (!coreResponse.ok || !wasmResponse.ok) {
    throw new Error("تعذّر تحميل محرك الدمج من شبكة CDN.");
  }

  const coreBlob = URL.createObjectURL(
    new Blob([await coreResponse.arrayBuffer()], { type: "text/javascript" })
  );
  const wasmBlob = URL.createObjectURL(
    new Blob([await wasmResponse.arrayBuffer()], { type: "application/wasm" })
  );

  try {
    await ffmpeg.load({ coreURL: coreBlob, wasmURL: wasmBlob });
    return ffmpeg;
  } catch (error) {
    ffmpeg.terminate();
    throw error;
  } finally {
    URL.revokeObjectURL(coreBlob);
    URL.revokeObjectURL(wasmBlob);
  }
}

export async function assembleVideos(scenes, aspect, onProgress = () => {}) {
  if (!Array.isArray(scenes) || scenes.length < 2 || scenes.length > MAX_CLIPS) {
    throw new Error("اختر من مشهدين إلى 8 مشاهد مكتملة للدمج.");
  }

  const clips = [];
  let totalBytes = 0;
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    if (!scene || typeof scene.videoUrl !== "string" || !/^https?:\/\//i.test(scene.videoUrl)) {
      throw new Error("رابط فيديو غير صالح في المشهد " + (index + 1) + ".");
    }
    onProgress({ stage: "download", progress: index / scenes.length });
    const response = await fetch(scene.videoUrl, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error("تعذّر تنزيل المشهد " + (index + 1) + " من مزود الفيديو.");
    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length || data.length > MAX_CLIP_BYTES) {
      throw new Error("حجم ملف المشهد " + (index + 1) + " غير مناسب للدمج المحلي.");
    }
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("إجمالي الملفات أكبر من الحد الآمن للدمج على الهاتف (350 ميغابايت).");
    }
    clips.push(data);
  }

  let ffmpeg;
  try {
    onProgress({ stage: "load", progress: 0 });
    ffmpeg = await loadFFmpeg((progress) => onProgress({ stage: "encode", progress }));
    const list = [];
    for (let index = 0; index < clips.length; index += 1) {
      const name = "clip" + String(index).padStart(3, "0") + ".mp4";
      await ffmpeg.writeFile(name, clips[index]);
      list.push("file '" + name + "'");
    }
    await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(list.join("\n")));
    const { width, height } = dimensionsFor(aspect);
    onProgress({ stage: "encode", progress: 0 });
    const exitCode = await ffmpeg.exec([
      "-f", "concat", "-safe", "0", "-i", "concat.txt",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`,
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25",
      "-movflags", "+faststart", "joyverse-final.mp4"
    ]);
    if (exitCode !== 0) throw new Error("فشل FFmpeg في دمج المشاهد (رمز " + exitCode + ").");
    const output = await ffmpeg.readFile("joyverse-final.mp4");
    if (!(output instanceof Uint8Array) || output.length < 1024) {
      throw new Error("لم ينتج محرك الدمج ملف فيديو صالحاً.");
    }
    return new Blob([output], { type: "video/mp4" });
  } finally {
    if (ffmpeg) ffmpeg.terminate();
  }
}
