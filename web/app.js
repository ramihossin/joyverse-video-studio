import { preloadFfmpegRuntime } from "./ffmpeg-cache.js";
import { assembleVideos } from "./assembler.js";
import { Client, handle_file } from "https://esm.sh/@gradio/client@2.0.0";

const PROVIDER = { space: "Lightricks/LTX-2.5", endpoint: "/run" };

async function composeReferenceImages(files) {
  if (files.length > 6) throw new Error("يمكن إرفاق 6 صور مرجعية كحد أقصى للمشهد.");
  const cellSize = 512;
  const gap = 20;
  const columns = files.length === 2 ? 2 : 2;
  const rows = Math.ceil(files.length / columns);
  const canvas = document.createElement("canvas");
  canvas.width = columns * cellSize + (columns + 1) * gap;
  canvas.height = rows * cellSize + (rows + 1) * gap;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("تعذّر تجهيز لوحة الصور المرجعية في هذا المتصفح.");
  context.fillStyle = "#f4f4f4";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < files.length; index += 1) {
    const bitmap = await createImageBitmap(files[index]);
    const scale = Math.min(cellSize / bitmap.width, cellSize / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const x = gap + (index % columns) * (cellSize + gap) + Math.round((cellSize - width) / 2);
    const y = gap + Math.floor(index / columns) * (cellSize + gap) + Math.round((cellSize - height) / 2);
    context.drawImage(bitmap, x, y, width, height);
    bitmap.close?.();
  }
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("تعذّر إنشاء لوحة الصور المرجعية.")), "image/png"));
  return new File([blob], "joyverse-reference-board.png", { type: "image/png" });
}
const $ = (id) => document.getElementById(id);
const form = $("studio-form");
const imageInput = $("image");
const tokenInput = $("hf-token");
const previewList = $("preview-list");
const uploadTitle = $("upload-title");
const uploadHelp = $("upload-help");
const statusBox = $("status-box");
const statusText = $("status-text");
const spinner = $("spinner");
const sceneList = $("scene-list");
const queueSummary = $("queue-summary");
const startButton = $("start-queue");
const stopButton = $("stop-queue");
const assembleButton = $("assemble-scenes");
const assemblyBox = $("assembly-box");
const assemblyVideo = $("assembly-video");
const assemblyDownload = $("assembly-download");
const resultBox = $("result-box");
const resultVideo = $("result-video");
const downloadLink = $("download");

const STORAGE_KEY = "joyverse-scene-queue-v1";
let queue = [];
let queueRunning = false;
let stopRequested = false;
let assemblyRunning = false;
let assemblyUrl = null;
let previewUrls = [];

try {
  queue = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  if (!Array.isArray(queue)) queue = [];
  queue.forEach((scene) => {
    if (scene.status === "running") scene.status = "waiting";
  });
} catch { queue = []; }

function saveQueue() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (error) {
    console.warn("Could not persist scene queue", error);
  }
}

function setStatus(message, busy = false) {
  statusBox.hidden = false;
  statusText.textContent = message;
  spinner.hidden = !busy;
}

function getVideoUrl(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.url || value.video?.url || value.video || value.path || null;
}

function dimensionsFor(aspect) {
  if (aspect === "landscape") return { width: 1472, height: 832 };
  if (aspect === "square") return { width: 1024, height: 1024 };
  return { width: 832, height: 1472 };
}

function statusLabel(status) {
  return ({
    waiting: "بانتظار الدور",
    running: "قيد التوليد",
    done: "مكتمل",
    failed: "تعذّر",
  })[status] || status;
}

function renderQueue() {
  sceneList.replaceChildren();
  const counts = { waiting: 0, running: 0, done: 0, failed: 0 };
  queue.forEach((scene, index) => {
    counts[scene.status] = (counts[scene.status] || 0) + 1;
    const item = document.createElement("li");
    item.className = "scene-item";

    const copy = document.createElement("div");
    copy.className = "scene-copy";
    const title = document.createElement("strong");
    title.textContent = scene.title || ("مشهد " + (index + 1));
    const detail = document.createElement("small");
    detail.textContent = statusLabel(scene.status) + (scene.error ? " — " + scene.error : "");
    copy.append(title, detail);
    item.append(copy);

    if (scene.videoUrl) {
      const link = document.createElement("a");
      link.href = scene.videoUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "فتح MP4";
      item.append(link);
    }
    if (!queueRunning && !assemblyRunning && scene.status !== "running") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-scene";
      remove.textContent = "حذف";
      remove.addEventListener("click", () => {
        queue = queue.filter((entry) => entry.id !== scene.id);
        saveQueue();
        renderQueue();
      });
      item.append(remove);
    }
    sceneList.append(item);
  });
  queueSummary.textContent = `الإجمالي: ${queue.length} · بانتظار الدور: ${counts.waiting} · قيد التوليد: ${counts.running} · مكتمل: ${counts.done} · تعذّر: ${counts.failed}`;
  startButton.disabled = queueRunning || assemblyRunning || !queue.some((scene) => scene.status === "waiting");
  stopButton.disabled = !queueRunning;
  const completedCount = queue.filter((scene) => scene.status === "done" && scene.videoUrl).length;
  assembleButton.disabled = queueRunning || assemblyRunning || completedCount < 2;
}

imageInput.addEventListener("change", () => {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
  previewList.replaceChildren();
  const files = Array.from(imageInput.files || []);
  if (files.length > 6) {
    imageInput.value = "";
    uploadTitle.textContent = "اختر حتى 6 صور فقط";
    uploadHelp.textContent = "قلّل عدد الصور ثم حاول مجدداً.";
    previewList.hidden = true;
    return;
  }
  if (files.some(file => !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
    imageInput.value = "";
    uploadTitle.textContent = "صيغة صورة غير مدعومة";
    uploadHelp.textContent = "استخدم PNG أو JPG أو WEBP.";
    previewList.hidden = true;
    return;
  }
  if (!files.length) {
    uploadTitle.textContent = "اختر صوراً مرجعية متعددة";
    uploadHelp.textContent = "PNG أو JPG أو WEBP — حتى 6 صور";
    previewList.hidden = true;
    return;
  }
  files.forEach((file) => {
    const url = URL.createObjectURL(file);
    previewUrls.push(url);
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = url;
    image.alt = file.name;
    const caption = document.createElement("figcaption");
    caption.textContent = file.name;
    figure.append(image, caption);
    previewList.append(figure);
  });
  previewList.hidden = false;
  uploadTitle.textContent = "تم اختيار " + files.length + " صور مرجعية";
  uploadHelp.textContent = "ستُجمع الصور في لوحة مرجعية واحدة قبل إرسالها للمحرك.";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt) return setStatus("اكتب وصف المشهد أولاً.");
  if (!$("consent").checked) return setStatus("يرجى الموافقة على إرسال الوصف والصورة الاختيارية إلى مزود النموذج.");

  const title = $("scene-title").value.trim() || ("مشهد " + (queue.length + 1));
  queue.push({
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    title,
    prompt,
    status: "waiting",
    videoUrl: null,
    error: null,
    createdAt: new Date().toISOString()
  });
  saveQueue();
  renderQueue();
  $("scene-title").value = "";
  $("prompt").value = "";
  setStatus("أُضيف المشهد إلى قائمة الإنتاج. لم يُرسل بعد إلى مزود النموذج.");
});

async function generateScene(client, scene) {
  const files = Array.from(imageInput.files || []);
  const referenceFile = files.length > 1 ? await composeReferenceImages(files) : (files[0] || null);
  const image = referenceFile ? await handle_file(referenceFile) : null;
  const duration = Number($("duration").value);
  const seedValue = Number($("seed").value) || 42;
  const { width, height } = dimensionsFor($("aspect").value);
  const args = [
    scene.prompt,
    image,
    height,
    width,
    duration,
    seedValue,
    "conv",
    false,
    $("random-seed").checked,
    $("enhance-prompt").checked
  ];

  const job = client.submit(PROVIDER.endpoint, args);
  let output = null;
  for await (const message of job) {
    if (message.type === "status") {
      const stage = message.stage || message.status || message.message || "قيد المعالجة";
      const position = Number.isInteger(message.position) ? " · ترتيب الطابور: " + (message.position + 1) : "";
      const eta = Number.isFinite(message.eta) && message.eta > 0 ? " · الوقت المتوقع: " + Math.ceil(message.eta) + " ثانية" : "";
      setStatus(scene.title + ": " + stage + position + eta, true);
    } else if (message.type === "data") {
      output = message.data;
    }
  }
  const videoUrl = getVideoUrl(output?.[0]);
  if (!videoUrl) throw new Error("لم يُرجع المحرك رابط فيديو صالحاً.");
  return { videoUrl, output, duration };
}

async function runQueue() {
  if (queueRunning || assemblyRunning) return;
  if (!queue.some((scene) => scene.status === "waiting")) {
    setStatus("لا توجد مشاهد بانتظار التوليد.");
    return;
  }
  if (!$("consent").checked) {
    setStatus("فعّل الموافقة قبل إرسال أي مشهد إلى مزود النموذج.");
    return;
  }

  queueRunning = true;
  stopRequested = false;
  renderQueue();
  let client;

  try {
    setStatus("جارٍ الاتصال بمحرك LTX‑2.5 المجاني…", true);
    const connectOptions = { events: ["status", "data"] };
    const hfToken = tokenInput.value.trim();
    if (hfToken) connectOptions.token = hfToken;
    client = await Client.connect(PROVIDER.space, connectOptions);

    for (const scene of queue) {
      if (stopRequested) break;
      if (scene.status !== "waiting") continue;

      scene.status = "running";
      scene.error = null;
      saveQueue();
      renderQueue();
      setStatus("بدأ إرسال: " + scene.title, true);

      try {
        const result = await generateScene(client, scene);
        scene.status = "done";
        scene.videoUrl = result.videoUrl;
        scene.error = null;
        saveQueue();
        renderQueue();

        resultVideo.src = result.videoUrl;
        downloadLink.href = result.videoUrl;
        $("result-title").textContent = scene.title;
        $("result-meta").textContent = "LTX‑2.5 · " + result.duration + " ثوانٍ · " + $("aspect").value;
        resultBox.hidden = false;
        setStatus("اكتمل " + scene.title + " بنجاح. الانتقال إلى المشهد التالي.", false);
      } catch (error) {
        scene.status = "failed";
        scene.error = error?.message || String(error);
        saveQueue();
        renderQueue();
        setStatus("تعذّر توليد " + scene.title + ": " + scene.error + ". ستستمر القائمة بالمشهد التالي إن وُجد.", false);
      }
    }
  } catch (error) {
    setStatus("تعذّر الاتصال بمحرك LTX‑2.5: " + (error?.message || String(error)), false);
  } finally {
    queueRunning = false;
    saveQueue();
    renderQueue();
    if (stopRequested) setStatus("توقف الطابور بعد انتهاء الطلب الجاري. المشاهد المتبقية محفوظة.");
    else if (!queue.some((scene) => scene.status === "waiting")) setStatus("انتهت محاولة تشغيل القائمة. راجع حالات المشاهد وروابط MP4.");
  }
}

async function assembleCompletedScenes() {
  if (queueRunning || assemblyRunning) return;
  const completed = queue.filter((scene) => scene.status === "done" && scene.videoUrl);
  if (completed.length < 2) return setStatus("يلزم مشهدان مكتملان على الأقل قبل الدمج.");
  if (completed.length > 8) return setStatus("الدمج المحلي يدعم 8 مشاهد كحد أقصى في المرة الواحدة.");

  assemblyRunning = true;
  renderQueue();
  assembleButton.textContent = "جارٍ تجهيز الدمج…";
  try {
    setStatus("جارٍ تنزيل المقاطع المكتملة إلى الهاتف…", true);
    const blob = await assembleVideos(completed, $("aspect").value, ({ stage, progress }) => {
      const percent = Math.round((Number(progress) || 0) * 100);
      const label = stage === "download" ? "تنزيل المقاطع" : stage === "load" ? "تحميل محرك الدمج" : "دمج وترميز الفيديو";
      const progressText = stage === "download" || percent > 0 ? " · " + percent + "%" : "…";
      setStatus(label + progressText, true);
    });
    if (assemblyUrl) URL.revokeObjectURL(assemblyUrl);
    assemblyUrl = URL.createObjectURL(blob);
    assemblyVideo.src = assemblyUrl;
    assemblyDownload.href = assemblyUrl;
    assemblyBox.hidden = false;
    setStatus("اكتمل دمج " + completed.length + " مشاهد في فيديو واحد. الملف صامت وجاهز لإضافة الصوت لاحقاً.");
  } catch (error) {
    const message = error?.message || String(error);
    setStatus("تعذّر الدمج المحلي: " + message + " إذا ظهر خطأ شبكة، تحقق من اتصال الإنترنت أو دعم المتصفح.");
  } finally {
    assemblyRunning = false;
    assembleButton.textContent = "دمج المشاهد المكتملة";
    renderQueue();
  }
}

assembleButton.addEventListener("click", assembleCompletedScenes);
startButton.addEventListener("click", runQueue);
stopButton.addEventListener("click", () => {
  stopRequested = true;
  setStatus("تم طلب الإيقاف. لن يبدأ مشهد جديد بعد انتهاء المشهد الجاري.", true);
});
$("clear-queue").addEventListener("click", () => {
  if (queueRunning) return;
  queue = queue.filter((scene) => scene.status !== "done");
  saveQueue();
  renderQueue();
});
window.addEventListener("beforeunload", () => {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  if (assemblyUrl) URL.revokeObjectURL(assemblyUrl);
});

const engineCacheStatus = $("engine-cache-status");
preloadFfmpegRuntime((status) => {
  if (!engineCacheStatus) return;
  if (status.state === "downloading") {
    engineCacheStatus.textContent = "تنزيل محرك الدمج في الخلفية: " + status.completed + " من " + status.total + " ملفات";
  } else if (status.state === "ready") {
    engineCacheStatus.textContent = "محرك الدمج جاهز ومحفوظ في المتصفح.";
  } else if (status.state === "unsupported") {
    engineCacheStatus.textContent = status.message;
  } else if (status.state === "error") {
    engineCacheStatus.textContent = "تعذّر التخزين المسبق: " + status.message;
  }
});
renderQueue();
