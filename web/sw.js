const CACHE_NAME = "joyverse-ffmpeg-0.12.10-local";
const ASSETS = [
  "core/ffmpeg-core.js",
  "core/ffmpeg-core.wasm",
  "esm/index.js",
  "esm/classes.js",
  "esm/const.js",
  "esm/errors.js",
  "esm/types.js",
  "esm/utils.js",
  "esm/worker.js"
].map((path) => new URL("./vendor/ffmpeg/" + path, self.location.href).href);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("joyverse-ffmpeg-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (ASSETS.includes(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok && response.type !== "opaque") await cache.put(url, response.clone());
      return response;
    })());
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "JOYVERSE_PRECACHE_FFMPEG") return;
  const port = event.ports?.[0];
  const send = (payload) => port?.postMessage(payload);
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      let completed = 0;
      for (const url of ASSETS) {
        const existing = await cache.match(url);
        if (!existing) {
          send({ type: "progress", completed, total: ASSETS.length, current: url });
          const response = await fetch(url, { cache: "reload" });
          if (!response.ok || response.type === "opaque") throw new Error("تعذّر تنزيل أحد ملفات FFmpeg المستضافة داخل الاستوديو.");
          await cache.put(url, response);
        }
        completed += 1;
        send({ type: "progress", completed, total: ASSETS.length, current: url });
      }
      send({ type: "complete", cached: true });
    } catch (error) {
      send({ type: "error", message: error?.message || String(error) });
    }
  })());
});
