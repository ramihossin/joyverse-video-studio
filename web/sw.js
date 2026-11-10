const CACHE_NAME = "joyverse-ffmpeg-0.12.10-local";
const CORE_CDN = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/";
const CORE_MIRRORS = [
  "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/",
  "https://fastly.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/"
];

const localAssets = [
  "esm/index.js",
  "esm/classes.js",
  "esm/const.js",
  "esm/errors.js",
  "esm/types.js",
  "esm/utils.js",
  "esm/worker.js"
].map((path) => {
  const url = new URL("./vendor/ffmpeg/" + path, self.location.href).href;
  return { key: url, urls: [url] };
});

const coreAssets = ["ffmpeg-core.js", "ffmpeg-core.wasm"].map((file) => ({
  key: CORE_CDN + file,
  urls: [CORE_CDN, ...CORE_MIRRORS].map((base) => base + file)
}));

const ASSETS = [...localAssets, ...coreAssets];

async function fetchFirstAvailable(urls) {
  let lastError;
  for (const url of urls) {
    try {
      const response = await fetch(url, { mode: "cors", credentials: "omit", cache: "reload" });
      if (response.ok && response.type !== "opaque") return response;
      lastError = new Error("HTTP " + response.status + " from " + url);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("تعذّر الوصول إلى ملف FFmpeg عبر مصادره الاحتياطية: " + (lastError?.message || "unknown error"));
}

async function getCachedAsset(entry) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(entry.key);
  if (cached) return cached;
  const response = await fetchFirstAvailable(entry.urls);
  await cache.put(entry.key, response.clone());
  return response;
}

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
  const entry = ASSETS.find((asset) => asset.urls.includes(event.request.url) || asset.key === event.request.url);
  if (entry) event.respondWith(getCachedAsset(entry));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "JOYVERSE_PRECACHE_FFMPEG") return;
  const port = event.ports?.[0];
  const send = (payload) => port?.postMessage(payload);
  event.waitUntil((async () => {
    try {
      let completed = 0;
      for (const entry of ASSETS) {
        send({ type: "progress", completed, total: ASSETS.length, current: entry.key });
        await getCachedAsset(entry);
        completed += 1;
        send({ type: "progress", completed, total: ASSETS.length, current: entry.key });
      }
      send({ type: "complete", cached: true });
    } catch (error) {
      send({ type: "error", message: error?.message || String(error) });
    }
  })());
});
