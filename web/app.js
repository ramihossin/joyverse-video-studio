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
const promptInput = document.querySelector("#prompt");

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
  if (typeof value.url === "string") return value.url;
  if (typeof value.path === "string" && /^https?:\/\//i.test(value.path)) return value.path;
  if (value.video) return getVideoUrl(value.video);
  return null;
}

function readableError(error) {
  const message = error?.message || String(error);
  if (/queue|wait|pending/i.test(message)) return "الخدمة مشغولة أو يوجد طلب في قائمة الانتظار. حاول لاحقًا.";
  if (/429|quota|rate limit|zerogpu/i.test(message)) return "بلغت الخدمة حد الاستخدام المؤقت أو نفدت حصتها المجانية حاليًا. حاول بعد تجدد الإتاحة.";
  if (/not found|404|api_name|endpoint/i.test(message)) return "واجهة النموذج تغيّرت أو لم تعد متاحة. يلزم تحديث الربط.";
  return message;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = imageInput.files?.[0];
  const prompt = promptInput.value.trim();
  const consent = document.querySelector("#consent").checked;

  if (!file || !prompt || !consent) {
    setStatus("اختر صورة، واكتب وصف الحركة، ثم وافق على إرسالها إلى Hugging Face.", false);
    return;
  }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    setStatus("نوع الصورة غير مدعوم. استخدم PNG أو JPG أو WEBP.", false);
    return;
  }

  generateButton.disabled = true;
  resultBox.hidden = true;
  resultVideo.removeAttribute("src");
  downloadLink.removeAttribute("href");
  setStatus("جارٍ الاتصال بخدمة Hugging Face…", true);

  try {
    const client = await Client.connect(SPACE);
    const image = await handle_file(file);
    const duration = Number(document.querySelector("#duration").value);
    const steps = Number(document.querySelector("#steps").value);

    // Current Space input order, verified against its app.py:
    // image, prompt, negative_prompt, duration_seconds,
    // guidance_scale, guidance_scale_2, steps, seed, randomize_seed.
    setStatus("أُرسل الطلب إلى النموذج. قد يستغرق التوليد عدة دقائق وقد ينتظر في الطابور المجاني.", true);
    const result = await client.predict("/generate_video", [
      image,
      prompt,
      "",
      duration,
      1,
      3,
      steps,
      42,
      true
    ]);

    const videoUrl = getVideoUrl(result?.data?.[0]);
    if (!videoUrl) {
      console.error("Unexpected Gradio response:", result);
      throw new Error("وصل رد من النموذج دون رابط فيديو قابل للعرض.");
    }

    resultVideo.src = videoUrl;
    downloadLink.href = videoUrl;
    resultBox.hidden = false;
    setStatus("اكتمل التوليد. يمكنك مشاهدة المقطع أو تنزيله.", false);
  } catch (error) {
    console.error("JoyVerse generation error:", error);
    setStatus("تعذّر إكمال التوليد: " + readableError(error), false);
  } finally {
    generateButton.disabled = false;
    spinner.hidden = true;
  }
});
