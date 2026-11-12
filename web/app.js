import { saveVideoBlob, getVideoBlob, deleteVideoBlob } from "./video-storage.js";
import { parseManifest, serializeManifest } from "./manifest.js";

const $ = (id) => document.getElementById(id);
const form = $("studio-form");
const imageInput = $("image");
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
const bridgeInput = $("bridge-url");
const studioTokenInput = $("studio-token");

const STORAGE_KEY = "joyverse-scene-queue-v2";
const FINAL_KEY = "joyverse-final-video-v1";
let queue = [];
let queueRunning = false;
let stopRequested = false;
let assemblyRunning = false;
let previewUrl = null;
let assemblyUrl = null;
const clipUrls = new Map();

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) queue = JSON.parse(saved);
  else {
    const legacy = JSON.parse(localStorage.getItem("joyverse-scene-queue-v1") || "[]");
    queue = Array.isArray(legacy) ? legacy.map(scene => ({
      ...scene, status: scene.status === "running" ? "waiting" : scene.status,
      serverTaskId: null, referenceBlobId: null, referenceImageKey: null
    })) : [];
  }
  if (!Array.isArray(queue)) queue = [];
} catch { queue = []; }

bridgeInput.value = localStorage.getItem("joyverse-bridge-url") || bridgeInput.value;
studioTokenInput.value = sessionStorage.getItem("joyverse-studio-token") || "";

function saveQueue() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(queue)); }
  catch (error) { console.warn("Could not persist scene queue", error); }
}
function setStatus(message, busy = false) {
  statusBox.hidden = false;
  statusText.textContent = message;
  spinner.hidden = !busy;
}
function apiConfig() {
  const base = bridgeInput.value.trim().replace(/\/+$/, "");
  const token = studioTokenInput.value.trim();
  if (!/^https:\/\//i.test(base)) throw new Error("عنوان الخادم يجب أن يبدأ بـ https://");
  if (!token || token.length < 32) throw new Error("أدخل رمز ربط الاستوديو الصحيح.");
  localStorage.setItem("joyverse-bridge-url", base);
  sessionStorage.setItem("joyverse-studio-token", token);
  return { base, token };
}
async function apiRequest(path, options = {}) {
  const { base, token } = apiConfig();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + token);
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.json);
    delete options.json;
  }
  const response = await fetch(base + path, { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    let detail = "HTTP " + response.status;
    try {
      const body = await response.json();
      detail = body.message || body.error || detail;
    } catch {}
    throw new Error(detail);
  }
  return response;
}
function dimensionsFor(aspect) {
  if (aspect === "landscape") return { width: 1472, height: 832 };
  if (aspect === "square") return { width: 1024, height: 1024 };
  return { width: 832, height: 1472 };
}
function statusLabel(status) {
  return ({ waiting: "بانتظار الدور — لم يُرسل بعد", queued: "محفوظ على الخادم — بانتظار العامل",
    running: "العامل يولّد المشهد", done: "مكتمل ومحفوظ سحابياً", failed: "تعذّر" })[status] || status;
}
function renderQueue() {
  sceneList.replaceChildren();
  const counts = { waiting: 0, queued: 0, running: 0, done: 0, failed: 0 };
  queue.forEach((scene, index) => {
    counts[scene.status] = (counts[scene.status] || 0) + 1;
    const item = document.createElement("li");
    item.className = "scene-item";
    const copy = document.createElement("div");
    copy.className = "scene-copy";
    const title = document.createElement("strong");
    title.textContent = scene.title || ("مشهد " + (index + 1));
    const detail = document.createElement("small");
    detail.textContent = statusLabel(scene.status) +
      (scene.referenceBlobId ? " · صورة مرجعية مرفقة" : "") +
      (scene.error ? " · " + scene.error : "");
    copy.append(title, detail);
    item.append(copy);
    if (scene.status === "done" && scene.videoUrl && !scene.serverTaskId) {
      const legacyLink = document.createElement("a");
      legacyLink.href = scene.videoUrl; legacyLink.target = "_blank"; legacyLink.rel = "noopener noreferrer";
      legacyLink.textContent = "فتح الفيديو السابق";
      item.append(legacyLink);
    }
    if (scene.status === "done" && scene.serverTaskId) {
      const getClip = document.createElement("button");
      getClip.type = "button";
      getClip.className = "scene-action";
      getClip.textContent = "استرجاع MP4";
      getClip.addEventListener("click", () => downloadScene(scene).catch(error => setStatus("تعذّر استرجاع المقطع: " + error.message)));
      item.append(getClip);
    }
    if (!queueRunning && !assemblyRunning && scene.status !== "running" && scene.status !== "queued") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-scene";
      remove.textContent = "حذف من القائمة";
      remove.addEventListener("click", () => {
        if (scene.referenceBlobId) deleteVideoBlob(scene.referenceBlobId).catch(console.warn);
        if (scene.localVideoId) deleteVideoBlob(scene.localVideoId).catch(console.warn);
        queue = queue.filter(entry => entry.id !== scene.id);
        saveQueue(); renderQueue();
      });
      item.append(remove);
    }
    sceneList.append(item);
  });
  queueSummary.textContent = `الإجمالي: ${queue.length} · محلي: ${counts.waiting} · في طابور الخادم: ${counts.queued} · قيد التوليد: ${counts.running} · مكتمل: ${counts.done} · متعذّر: ${counts.failed}`;
  startButton.disabled = queueRunning || assemblyRunning || !queue.some(scene => scene.status === "waiting" || scene.serverTaskId && ["queued","running"].includes(scene.status));
  stopButton.disabled = !queueRunning;
  const completed = queue.filter(scene => scene.status === "done" && scene.serverTaskId).length;
  assembleButton.disabled = queueRunning || assemblyRunning || completed < 1;
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  preview.hidden = false;
  uploadTitle.textContent = file.name;
  uploadHelp.textContent = Math.ceil(file.size / 1024) + " KB — ستُرفع مع هذا المشهد إلى التخزين السحابي";
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt) return setStatus("اكتب وصف المشهد أولاً.");
  if (!$("consent").checked) return setStatus("يرجى الموافقة على إرسال الوصف والصورة الاختيارية إلى مزود النموذج.");
  let referenceBlobId = null;
  const file = imageInput.files?.[0] || null;
  if (file) {
    if (!["image/png","image/jpeg","image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      return setStatus("الصورة يجب أن تكون PNG أو JPEG أو WebP وبحجم لا يتجاوز 10 ميغابايت.");
    }
    referenceBlobId = "reference:" + crypto.randomUUID();
    try { await saveVideoBlob(referenceBlobId, file); }
    catch (error) { return setStatus("تعذّر حفظ الصورة المرجعية على الهاتف: " + error.message); }
  }
  queue.push({
    id: crypto.randomUUID(), title: $("scene-title").value.trim() || ("مشهد " + (queue.length + 1)),
    prompt, status: "waiting", serverTaskId: null, referenceBlobId,
    referenceImageKey: null, videoUrl: null, error: null, createdAt: new Date().toISOString()
  });
  saveQueue(); renderQueue();
  $("scene-title").value = ""; $("prompt").value = "";
  imageInput.value = "";
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; preview.hidden = true;
  uploadTitle.textContent = "اختر صورة مرجعية";
  uploadHelp.textContent = "PNG أو JPG أو WEBP";
  setStatus("أُضيف المشهد محلياً. عند تشغيل القائمة سيُرفع إلى الخادم ويصبح مستقلاً عن المتصفح.");
});

async function uploadReference(scene) {
  if (!scene.referenceBlobId || scene.referenceImageKey) return scene.referenceImageKey || null;
  const blob = await getVideoBlob(scene.referenceBlobId);
  if (!blob) throw new Error("الصورة المرجعية غير موجودة في مساحة الهاتف؛ أعد إرفاقها بهذا المشهد.");
  const response = await apiRequest("/api/hermes/reference-upload", {
    method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob
  });
  const data = await response.json();
  scene.referenceImageKey = data.reference_image_key;
  saveQueue();
  return scene.referenceImageKey;
}
async function dispatchScene(scene) {
  if (scene.serverTaskId) return;
  setStatus("رفع وتجهيز: " + scene.title, true);
  const reference_image_key = await uploadReference(scene);
  const video_options = {
    aspect: $("aspect").value, duration: Number($("duration").value),
    seed: Number($("seed").value) || 42,
    randomize_seed: $("random-seed").checked,
    enhance_prompt: $("enhance-prompt").checked
  };
  const response = await apiRequest("/api/hermes/dispatch", {
    method: "POST",
    json: { scene_id: scene.id, prompt: scene.prompt, toolsets: ["video_gen"],
      confirm_video_generation: true, video_options, ...(reference_image_key ? { reference_image_key } : {}) }
  });
  const data = await response.json();
  scene.serverTaskId = data.task_id;
  scene.status = "queued";
  scene.error = null;
  saveQueue(); renderQueue();
}
async function refreshScene(scene) {
  const response = await apiRequest("/api/hermes/tasks/" + encodeURIComponent(scene.serverTaskId));
  const task = await response.json();
  scene.serverStatus = task.status;
  scene.provider = task.provider || scene.provider || null;
  scene.status = task.status === "queued" ? "queued" : task.status === "claimed" ? "running" :
    task.status === "completed" ? "done" : task.status === "failed" ? "failed" : scene.status;
  scene.error = task.error || null;
  scene.storageKey = task.storage_key || task.result?.storage_key || null;
  return task;
}
async function pollTasks() {
  if (queueRunning) return;
  queueRunning = true; renderQueue();
  try {
    while (!stopRequested) {
      const active = queue.filter(scene => scene.serverTaskId && ["queued","running"].includes(scene.status));
      if (!active.length) break;
      await Promise.all(active.map(async scene => {
        try { await refreshScene(scene); }
        catch (error) { scene.error = error.message; }
      }));
      saveQueue(); renderQueue();
      const remaining = queue.some(scene => scene.serverTaskId && ["queued","running"].includes(scene.status));
      if (!remaining || stopRequested) break;
      setStatus("العامل الخلفي يعمل. تتم مزامنة حالات " + active.length + " مشاهد…", true);
      await new Promise(resolve => setTimeout(resolve, 3500));
    }
    if (stopRequested) setStatus("أوقفت متابعة الحالة فقط. العامل الخلفي يواصل عمله على الخادم.");
    else setStatus("اكتملت مزامنة المهام. يمكنك إغلاق المتصفح؛ المهام المرسلة محفوظة على الخادم.");
  } finally {
    queueRunning = false; saveQueue(); renderQueue();
  }
}
async function runQueue() {
  if (queueRunning || assemblyRunning) return;
  if (!$("consent").checked && queue.some(scene => scene.status === "waiting")) {
    return setStatus("فعّل الموافقة قبل إرسال المشاهد إلى مزود النموذج.");
  }
  try {
    apiConfig();
    stopRequested = false;
    queueRunning = true; renderQueue();
    const pending = queue.filter(scene => scene.status === "waiting");
    for (const scene of pending) {
      if (stopRequested) break;
      try { await dispatchScene(scene); }
      catch (error) { scene.status = "waiting"; scene.error = error.message; saveQueue(); renderQueue(); }
    }
    queueRunning = false; renderQueue();
    if (stopRequested) setStatus("توقفت عن إرسال مشاهد إضافية ومتابعة الحالة فقط؛ المهام التي أُرسلت تواصل عملها على الخادم.");
    else await pollTasks();
  } catch (error) {
    queueRunning = false; renderQueue();
    setStatus("تعذّر الاتصال بخادم JoyVerse: " + error.message);
  }
}
async function fetchBlob(path) {
  const response = await apiRequest(path, { method: "GET" });
  return response.blob();
}
async function downloadScene(scene) {
  if (!scene.serverTaskId) throw new Error("معرّف المهمة غير موجود.");
  setStatus("استرجاع المقطع من التخزين السحابي…", true);
  const blob = await fetchBlob("/api/hermes/video/" + encodeURIComponent(scene.serverTaskId));
  const id = "clip:" + scene.serverTaskId;
  await saveVideoBlob(id, blob);
  const old = clipUrls.get(scene.serverTaskId);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  clipUrls.set(scene.serverTaskId, url);
  scene.localVideoId = id; scene.videoUrl = url; saveQueue();
  resultVideo.src = url; downloadLink.href = url;
  $("result-title").textContent = scene.title;
  $("result-meta").textContent = (scene.provider || "محرك الفيديو المحدد") + " · محفوظ على خادم JoyVerse";
  resultBox.hidden = false;
  setStatus("تم استرجاع " + scene.title + " بنجاح.");
}
async function showFinal(finalId) {
  const blob = await fetchBlob("/api/hermes/final/" + encodeURIComponent(finalId));
  if (assemblyUrl) URL.revokeObjectURL(assemblyUrl);
  assemblyUrl = URL.createObjectURL(blob);
  assemblyVideo.src = assemblyUrl;
  assemblyDownload.href = assemblyUrl;
  assemblyBox.hidden = false;
}
async function assembleCompletedScenes() {
  if (queueRunning || assemblyRunning) return;
  const completed = queue.filter(scene => scene.status === "done" && scene.serverTaskId);
  if (!completed.length) return setStatus("لا توجد مشاهد مكتملة محفوظة على الخادم.");
  if (completed.length > 40) return setStatus("الدمج على الخادم يدعم 40 مشهداً كحد أقصى في المرة الواحدة.");
  assemblyRunning = true; renderQueue();
  try {
    setStatus("يرسل الاستوديو ترتيب المشاهد إلى FFmpeg على الخادم…", true);
    const response = await apiRequest("/api/hermes/assemble", {
      method: "POST", json: { task_ids: completed.map(scene => scene.serverTaskId) }
    });
    const data = await response.json();
    localStorage.setItem(FINAL_KEY, data.final_id);
    await showFinal(data.final_id);
    setStatus("اكتمل دمج " + data.scene_count + " مشاهد. حُفظ الفيديو النهائي في التخزين السحابي.");
  } catch (error) {
    setStatus("تعذّر الدمج على الخادم: " + error.message);
  } finally { assemblyRunning = false; renderQueue(); }
}
assembleButton.addEventListener("click", assembleCompletedScenes);
startButton.addEventListener("click", runQueue);
stopButton.addEventListener("click", () => { stopRequested = true; });
$("clear-queue").addEventListener("click", () => {
  if (queueRunning || assemblyRunning) return;
  queue.filter(scene => scene.status === "done").forEach(scene => {
    if (scene.referenceBlobId) deleteVideoBlob(scene.referenceBlobId).catch(console.warn);
    if (scene.localVideoId) deleteVideoBlob(scene.localVideoId).catch(console.warn);
  });
  queue = queue.filter(scene => scene.status !== "done");
  saveQueue(); renderQueue();
});
$("import-manifest").addEventListener("click", () => $("manifest-file").click());
$("manifest-file").addEventListener("change", async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const scenes = parseManifest(JSON.parse(await file.text()));
    scenes.forEach(scene => queue.push({ id: crypto.randomUUID(), ...scene, status: "waiting",
      serverTaskId: null, referenceBlobId: null, referenceImageKey: null, error: null }));
    saveQueue(); renderQueue(); setStatus("تم استيراد " + scenes.length + " مشاهد.");
  } catch (error) { setStatus("تعذّر استيراد القائمة: " + error.message); }
  event.target.value = "";
});
$("export-manifest").addEventListener("click", () => {
  const blob = new Blob([serializeManifest(queue)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = "joyverse-scene-manifest.json"; link.click();
  URL.revokeObjectURL(url);
});
bridgeInput.addEventListener("change", () => localStorage.setItem("joyverse-bridge-url", bridgeInput.value.trim()));
studioTokenInput.addEventListener("change", () => { sessionStorage.setItem("joyverse-studio-token", studioTokenInput.value.trim()); restoreServerState(); });
renderQueue();

async function restoreServerState() {
  const token = studioTokenInput.value.trim();
  if (!token) return;
  try {
    const active = queue.filter(scene => scene.serverTaskId);
    await Promise.all(active.map(async scene => {
      try { await refreshScene(scene); } catch (error) { console.warn("Task restore failed", error.message); }
    }));
    saveQueue(); renderQueue();
    const finalId = localStorage.getItem(FINAL_KEY);
    if (finalId) {
      try { await showFinal(finalId); } catch (error) { console.warn("Final video restore failed", error.message); }
    }
    if (queue.some(scene => scene.serverTaskId && ["queued","running"].includes(scene.status))) {
      stopRequested = false;
      pollTasks().catch(error => setStatus("تعذّرت مزامنة المهام: " + error.message));
    } else if (active.length) {
      setStatus("تم استرجاع حالات المشاهد من خادم JoyVerse.");
    }
  } catch (error) {
    setStatus("تعذّر استرجاع حالة الخادم: " + error.message);
  }
}
restoreServerState();
window.addEventListener("beforeunload", () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (assemblyUrl) URL.revokeObjectURL(assemblyUrl);
  for (const url of clipUrls.values()) URL.revokeObjectURL(url);
});
