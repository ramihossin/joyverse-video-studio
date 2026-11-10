const CACHE_NAME = "joyverse-ffmpeg-0.12.10";
const ASSETS = [
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js",
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm",
  "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js"
];

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
          const response = await fetch(url, { mode: "cors", credentials: "omit", cache: "reload" });
          if (!response.ok || response.type === "opaque") throw new Error("تعذّر تنزيل أحد ملفات FFmpeg من CDN.");
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
