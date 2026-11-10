import { assembleVideos } from "./assembler.js";
import { Client, handle_file } from "https://esm.sh/@gradio/client@2.0.0";

const PROVIDER = { space: "Lightricks/LTX-2.5", endpoint: "/run" };
const $ = (id) => document.getElementById(id);
const form = $("studio-form");
const imageInput = $("image");
const tokenInput = $("hf-token");
const preview = $("preview");
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
let previewUrl = null;

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
  const file = imageInput.files?.[0];
  if (!file) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (assemblyUrl) URL.revokeObjectURL(assemblyUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  preview.hidden = false;
  uploadTitle.textContent = file.name;
  uploadHelp.textContent = Math.ceil(file.size / 1024) + " KB — سيُستخدم كمرجع للمشاهد التالية";
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
  const file = imageInput.files?.[0] || null;
  const image = file ? await handle_file(file) : null;
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
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});

renderQueue();
