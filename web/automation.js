import { parseManifest, serializeManifest } from "./manifest.js";
import { saveVideoBlob } from "./video-storage.js";

const STORAGE_KEY = "joyverse-scene-queue-v1";
const MAX_MANIFEST_FILE_BYTES = 30 * 1024 * 1024;
const fileInput = document.getElementById("manifest-file");
const importButton = document.getElementById("import-manifest");
const exportButton = document.getElementById("export-manifest");
const videoInput = document.getElementById("video-files");
const videoImportButton = document.getElementById("import-videos");
const MAX_CLIP_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 350 * 1024 * 1024;
const MAX_VIDEO_CLIPS = 8;
const statusBox = document.getElementById("status-box");
const statusText = document.getElementById("status-text");

function showMessage(message) {
  statusBox.hidden = false;
  statusText.textContent = message;
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

importButton.addEventListener("click", () => fileInput.click());
videoImportButton.addEventListener("click", () => videoInput.click());

videoInput.addEventListener("change", async () => {
  const files = Array.from(videoInput.files || []);
  if (!files.length) return;
  const savedIds = [];
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(current)) throw new Error("قائمة المشاهد المحلية تالفة.");
    const completed = current.filter(scene => scene.status === "done" && (scene.videoUrl || scene.localVideoId)).length;
    if (completed + files.length > MAX_VIDEO_CLIPS) throw new Error("يمكن دمج 8 مقاطع مكتملة كحد أقصى. احذف مقاطع أو ادمجها أولاً.");
    if (current.length + files.length > 100) throw new Error("الحد الأقصى للقائمة هو 100 مشهد.");
    let totalBytes = current.reduce((sum, scene) => sum + (Number(scene.localVideoBytes) || 0), 0);
    for (const file of files) {
      if (!file.type.startsWith("video/") && !/\.mp4$/i.test(file.name)) throw new Error("الملف " + file.name + " ليس فيديو مدعوماً.");
      if (file.size <= 0 || file.size > MAX_CLIP_BYTES) throw new Error("يجب ألا يتجاوز حجم كل مقطع 100 ميغابايت.");
      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("إجمالي المقاطع يتجاوز 350 ميغابايت.");
    }
    for (const file of files) {
      const localVideoId = makeId();
      await saveVideoBlob(localVideoId, file);
      savedIds.push(localVideoId);
      current.push({ id: makeId(), title: file.name.replace(/\.mp4$/i, "") || "مقطع مستورد", prompt: "", status: "done", videoUrl: null, localVideoId, localVideoBytes: file.size, localVideoName: file.name, error: null, createdAt: new Date().toISOString() });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    showMessage("تم استيراد " + files.length + " مقطع فيديو من الهاتف وإضافتها إلى قائمة الدمج.");
    location.reload();
  } catch (error) {
    showMessage("تعذّر استيراد الفيديو: " + (error?.message || String(error)));
  } finally {
    videoInput.value = "";
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_MANIFEST_FILE_BYTES) {
      throw new Error("حجم ملف الإنتاج يجب ألا يتجاوز 30 ميغابايت.");
    }
    const imported = parseManifest(JSON.parse(await file.text()));
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(current)) throw new Error("قائمة المشاهد المحلية تالفة؛ صدّر نسخة منها قبل المتابعة.");
    if (current.length + imported.length > 100) throw new Error("الحد الأقصى للقائمة هو 100 مشهد.");
    const now = new Date().toISOString();
    const additions = imported.map(scene => ({
      id: makeId(), title: scene.title, prompt: scene.prompt,
      status: "waiting", videoUrl: null, error: null, createdAt: now
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...current, ...additions]));
    showMessage(`تم استيراد ${additions.length} مشهد. جارٍ تحديث القائمة…`);
    location.reload();
  } catch (error) {
    showMessage("تعذّر الاستيراد: " + (error?.message || String(error)));
  } finally {
    fileInput.value = "";
  }
});

exportButton.addEventListener("click", () => {
  try {
    const queue = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(queue) || queue.length === 0) throw new Error("لا توجد مشاهد لتصديرها.");
    const blob = new Blob([serializeManifest(queue)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "joyverse-scene-manifest.json";
    link.click();
    URL.revokeObjectURL(url);
    showMessage("تم تجهيز ملف المشاهد للتنزيل.");
  } catch (error) {
    showMessage("تعذّر التصدير: " + (error?.message || String(error)));
  }
});
