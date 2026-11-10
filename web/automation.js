import { parseManifest, serializeManifest } from "./manifest.js";

const STORAGE_KEY = "joyverse-scene-queue-v1";
const MAX_MANIFEST_FILE_BYTES = 30 * 1024 * 1024;
const fileInput = document.getElementById("manifest-file");
const importButton = document.getElementById("import-manifest");
const exportButton = document.getElementById("export-manifest");
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
