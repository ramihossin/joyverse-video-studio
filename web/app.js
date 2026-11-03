import { Client, handle_file } from "https://esm.sh/@gradio/client@2.0.0";

const PROVIDER = {
  id: "ltx25",
  label: "LTX-2.5",
  space: "Lightricks/LTX-2.5",
  endpoint: "/run"
};

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
const resultMeta = document.querySelector("#result-meta");
const promptOutput = document.querySelector("#prompt-output");

let previewUrl = null;

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  preview.hidden = false;
  uploadTitle.textContent = file.name;
  uploadHelp.textContent = Math.ceil(file.size / 1024) + " KB";
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

function dimensionsFor(aspect) {
  if (aspect === "landscape") return { width: 1472, height: 832 };
  if (aspect === "square") return { width: 1024, height: 1024 };
  return { width: 832, height: 1472 };
}

function describeQueue(message) {
  if (message?.stage === "error") return message.message || "تعذّر تنفيذ الطلب.";
  if (Number.isInteger(message?.rank)) {
    return "طلبك في قائمة الانتظار، ترتيبه التقريبي: " + message.rank;
  }
  if (message?.message) return message.message;
  return "يجري تنفيذ طلبك على خادم التوليد المجاني…";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const prompt = document.querySelector("#prompt").value.trim();
  const file = imageInput.files?.[0] || null;
  const consent = document.querySelector("#consent").checked;

  if (!prompt) {
    setStatus("اكتب وصف الفيديو أولاً.");
    return;
  }
  if (!consent) {
    setStatus("يرجى الموافقة على إرسال الوصف والصورة الاختيارية إلى خدمة التوليد.");
    return;
  }

  generateButton.disabled = true;
  resultBox.hidden = true;
  resultVideo.removeAttribute("src");
  setStatus("جارٍ الاتصال بمحرك " + PROVIDER.label + "…", true);

  try {
    const client = await Client.connect(PROVIDER.space);
    const duration = Number(document.querySelector("#duration").value);
    const seedValue = Number(document.querySelector("#seed").value);
    const { width, height } = dimensionsFor(document.querySelector("#aspect").value);
    const image = file ? await handle_file(file) : null;

    // Public Space input order: prompt, image, height, width, duration, seed,
    // decoder, auto length, randomize seed, prompt enhancement.
    const args = [
      prompt,
      image,
      height,
      width,
      duration,
      seedValue,
      "conv",
      false,
      document.querySelector("#random-seed").checked,
      false
    ];

    setStatus("تم الاتصال. يجري إرسال طلب التوليد إلى قائمة الانتظار العامة…", true);
    const job = client.submit(PROVIDER.endpoint, args);
    let output = null;

    for await (const message of job) {
      if (message.type === "status") {
        setStatus(describeQueue(message), true);
      } else if (message.type === "data") {
        output = message.data;
      }
    }

    const videoUrl = getVideoUrl(output?.[0]);
    if (!videoUrl) {
      throw new Error("انتهى الطلب دون أن تعيد الخدمة ملف فيديو قابلاً للعرض.");
    }

    resultVideo.src = videoUrl;
    downloadLink.href = videoUrl;
    promptOutput.textContent = output?.[1] || prompt;
    const usedSeed = output?.[2] ?? seedValue;
    const durationText = output?.[3] || (duration + " ثانية");
    resultMeta.textContent = "المحرك: " + PROVIDER.label + " · " + durationText + " · Seed: " + usedSeed;
    resultBox.hidden = false;
    setStatus("اكتمل التوليد. الفيديو جاهز للمشاهدة.", false);
  } catch (error) {
    console.error(error);
    const message = error?.message || String(error);
    setStatus("لم يكتمل التوليد: " + message + " — قد تكون قائمة GPU مزدحمة أو وصلت إلى حد الاستخدام المجاني.");
  } finally {
    generateButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});
