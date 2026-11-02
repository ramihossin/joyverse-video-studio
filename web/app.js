import { Client, handle_file } from "https://esm.sh/@gradio/client";

const SPACE = "zerogpu-aoti/wan2-2-fp8da-aoti-faster";
const form = document.querySelector("#studio-form");
const imageInput = document.querySelector("#image");
const preview = document.querySelector("#preview");
const uploadTitle = document.querySelector("#upload-title");
const uploadHelp = document.querySelector("#upload-help");
const generateButton = document.querySelector("#generate");
const statusBox = document.querySelector("#status-box");
const statusText = document.querySelector("#status-text");
const spinner = document.querySelector("#spinner");
const resultBox = document.querySelector("#result-box");
const resultVideo = document.querySelector("#result-video");
const downloadLink = document.querySelector("#download");

let previewUrl = null;

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  preview.hidden = false;
  uploadTitle.textContent = file.name;
  uploadHelp.textContent = Math.round(file.size / 1024) + " KB";
});

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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = imageInput.files?.[0];
  const prompt = document.querySelector("#prompt").value.trim();
  if (!file || !prompt || !document.querySelector("#consent").checked) return;

  generateButton.disabled = true;
  resultBox.hidden = true;
  setStatus("جارٍ الاتصال بخدمة التوليد…", true);

  try {
    const client = await Client.connect(SPACE);
    setStatus("تم الاتصال. جارٍ رفع الصورة وإرسال طلبك إلى قائمة الانتظار…", true);

    const image = await handle_file(file);
    const duration = Number(document.querySelector("#duration").value);
    const steps = Number(document.querySelector("#steps").value);

    setStatus("بدأ التوليد. قد يستغرق الأمر وقتًا حسب ازدحام الخدمة…", true);
    const result = await client.predict("/generate_video", [
      image,
      prompt,
      "",
      duration,
      2.5,
      3.5,
      steps,
      42,
      true
    ]);

    const videoUrl = getVideoUrl(result?.data?.[0]);
    if (!videoUrl) {
      throw new Error("انتهى الطلب لكن لم أستطع قراءة رابط الفيديو من استجابة الخدمة.");
    }

    resultVideo.src = videoUrl;
    downloadLink.href = videoUrl;
    resultBox.hidden = false;
    setStatus("اكتمل التوليد. يمكنك مشاهدة الفيديو أو تنزيله.", false);
    spinner.hidden = true;
  } catch (error) {
    console.error(error);
    const message = error?.message || String(error);
    setStatus("تعذّر إكمال التوليد: " + message + " — قد تكون الخدمة مزدحمة أو تغيّرت واجهتها.", false);
    spinner.hidden = true;
  } finally {
    generateButton.disabled = false;
  }
});
