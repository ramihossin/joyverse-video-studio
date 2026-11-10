// Cache the same-origin MIT wrapper locally; retrieve the separately licensed FFmpeg core through fallback CDNs.
export async function preloadFfmpegRuntime(onStatus = () => {}) {
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    onStatus({ state: "unsupported", message: "التخزين المسبق غير مدعوم في هذا المتصفح." });
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register(new URL("./sw.js", import.meta.url), {
      scope: new URL("./", import.meta.url).pathname
    });
    await navigator.serviceWorker.ready;
    const worker = registration.active || navigator.serviceWorker.controller;
    if (!worker) throw new Error("لم يبدأ عامل التخزين في المتصفح بعد.");

    await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => reject(new Error("انتهت مهلة تنزيل مكتبة الدمج وملفات المحرك.")), 600000);
      channel.port1.onmessage = ({ data }) => {
        if (data.type === "progress") {
          onStatus({ state: "downloading", completed: data.completed, total: data.total });
        } else if (data.type === "complete") {
          clearTimeout(timeout);
          onStatus({ state: "ready", message: "مكتبة الدمج وملفات المحرك محفوظة في ذاكرة المتصفح." });
          resolve();
        } else if (data.type === "error") {
          clearTimeout(timeout);
          reject(new Error(data.message || "فشل تنزيل محرك الدمج المحلي."));
        }
      };
      worker.postMessage({ type: "JOYVERSE_PRECACHE_FFMPEG" }, [channel.port2]);
    });
  } catch (error) {
    onStatus({ state: "error", message: error?.message || String(error) });
  }
}
