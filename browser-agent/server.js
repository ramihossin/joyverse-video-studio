import express from "express";
import { chromium } from "playwright";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  initStore, listSites, getSite, saveSite, deleteSite,
  getSession, saveSession, deleteSession
} from "./store.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.BROWSER_AGENT_TOKEN || "";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(ROOT, "ui");
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "downloads");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), "joyverse-agent-uploads");
const VIEWPORT = { width: 1365, height: 900 };
let browser;
let context;
let page;
let currentSiteId = null;
let busy = false;
const jobs = new Map();

if (TOKEN.length < 32) throw new Error("BROWSER_AGENT_TOKEN must be at least 32 characters.");

function authorized(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+\\/-]+=*)$/.exec(header);
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function auth(req, res, next) {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function assertSafeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("أدخل رابطاً صحيحاً يبدأ بـ https:// أو http://"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS destinations are allowed.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" ||
      host === "169.254.169.254" || host === "0.0.0.0" || host === "::1" ||
      /^127\\./.test(host) || /^10\\./.test(host) || /^192\\.168\\./.test(host) ||
      /^172\\.(1[6-9]|2\\d|3[01])\\./.test(host)) {
    throw new Error("Local and private network destinations are blocked.");
  }
  return url;
}
function hostAllowed(urlValue, site) {
  const url = assertSafeUrl(urlValue);
  const baseHost = new URL(site.baseUrl).hostname.toLowerCase();
  const host = url.hostname.toLowerCase();
  const extras = (site.allowedHosts || []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
  return host === baseHost || host.endsWith("." + baseHost) || extras.includes(host);
}
function validateSiteInput(body, existing = null) {
  const name = String(body.name || existing?.name || "").trim();
  if (name.length < 2 || name.length > 80) throw new Error("اسم الموقع يجب أن يكون بين حرفين و80 حرفاً.");
  const baseUrl = assertSafeUrl(String(body.baseUrl || existing?.baseUrl || "")).toString();
  const baseHost = new URL(baseUrl).hostname.toLowerCase();
  const allowedHosts = [...new Set([baseHost, ...(Array.isArray(body.allowedHosts)
    ? body.allowedHosts : String(body.allowedHosts || "").split(","))
    .map(x => String(x).trim().toLowerCase()).filter(Boolean)])];
  for (const host of allowedHosts) {
    if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
      throw new Error("أحد أسماء النطاقات الإضافية غير صالح.");
    }
  }
  const loginUrl = body.loginUrl || existing?.loginUrl || "";
  if (loginUrl) {
    const u = assertSafeUrl(String(loginUrl));
    if (!allowedHosts.includes(u.hostname.toLowerCase()) && !u.hostname.toLowerCase().endsWith("." + baseHost)) {
      throw new Error("رابط تسجيل الدخول يجب أن يكون ضمن نطاق الموقع أو النطاقات الإضافية المسموح بها.");
    }
  }
  const selectors = { ...(existing?.selectors || {}), ...(body.selectors || {}) };
  for (const [key, value] of Object.entries(selectors)) {
    if (typeof value !== "string" || value.length > 350) throw new Error("Each CSS selector must be a string up to 350 characters.");
  }
  return {
    id: existing?.id || randomUUID(),
    name, baseUrl, loginUrl: loginUrl ? String(loginUrl) : "",
    allowedHosts,
    selectors: {
      promptSelector: selectors.promptSelector || "",
      uploadSelector: selectors.uploadSelector || "",
      generateSelector: selectors.generateSelector || "",
      readySelector: selectors.readySelector || "",
      downloadSelector: selectors.downloadSelector || ""
    },
    waitSeconds: Math.min(600, Math.max(10, Number(body.waitSeconds ?? existing?.waitSeconds ?? 300))),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
function browserRequired() {
  if (!page || !context || !currentSiteId) throw new Error("افتح أحد المواقع أولاً.");
}
async function ensureBrowser() {
  if (!browser) browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
}
async function persistCurrentSession() {
  if (!context || !page || !currentSiteId) return false;
  let storageState;
  try { storageState = await context.storageState({ indexedDB: true }); }
  catch { storageState = await context.storageState(); }
  const sessionStorage = await page.evaluate(() => {
    const values = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      values[key] = window.sessionStorage.getItem(key);
    }
    return { origin: location.origin, values };
  }).catch(() => null);
  await saveSession(currentSiteId, { storageState, sessionStorage, savedAt: new Date().toISOString() });
  return true;
}
async function openSite(site, targetUrl = null) {
  const destination = assertSafeUrl(targetUrl || site.loginUrl || site.baseUrl).toString();
  if (!hostAllowed(destination, site)) throw new Error("هذا النطاق غير مسموح لهذا الموقع. أضفه إلى النطاقات الإضافية أولاً.");
  await ensureBrowser();
  if (context) {
    await persistCurrentSession().catch(() => {});
    await context.close().catch(() => {});
  }
  const saved = await getSession(site.id);
  context = await browser.newContext({
    ...(saved?.storageState ? { storageState: saved.storageState } : {}),
    acceptDownloads: true,
    viewport: VIEWPORT
  });
  if (saved?.sessionStorage?.origin && saved.sessionStorage?.values) {
    await context.addInitScript(({ origin, values }) => {
      if (location.origin === origin) {
        for (const [key, value] of Object.entries(values)) {
          try { sessionStorage.setItem(key, value); } catch {}
        }
      }
    }, saved.sessionStorage);
  }
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const mainPage = page;
  page.on("popup", popup => {
    page = popup;
    popup.setDefaultTimeout(20000);
    popup.once("close", () => { if (mainPage && !mainPage.isClosed()) page = mainPage; });
  });
  currentSiteId = site.id;
  await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 60000 });
  return { url: page.url(), title: await page.title(), sessionRestored: Boolean(saved) };
}
function withBrowser(fn) {
  return async (req, res) => {
    if (busy) return res.status(409).json({ error: "المتصفح ينفذ مهمة أخرى حالياً." });
    busy = true;
    try { await fn(req, res); }
    catch (error) { res.status(400).json({ error: String(error?.message || error).slice(0, 500) }); }
    finally { busy = false; }
  };
}
function selectorFor(el) {
  if (el.id) return "#" + el.id.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  const name = el.getAttribute("name");
  if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && ["INPUT", "TEXTAREA"].includes(el.tagName)) {
    return el.tagName.toLowerCase() + '[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]';
  }
  const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 50);
  if (text && ["BUTTON", "A"].includes(el.tagName)) return el.tagName.toLowerCase() + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
  if (el.type === "file") return 'input[type="file"]';
  return el.tagName.toLowerCase();
}

app.get("/health", (_req, res) => res.json({
  ok: true, service: "joyverse-free-browser-agent", browserStarted: Boolean(browser),
  persistence: process.env.DATABASE_URL ? "postgres-encrypted" : "local-encrypted",
  activeSite: currentSiteId ? "open" : null
}));
app.use("/api", auth);

app.get("/api/sites", async (_req, res) => {
  try {
    const sites = await listSites();
    const results = await Promise.all(sites.map(async site => ({
      ...site, hasSavedSession: Boolean(await getSession(site.id))
    })));
    res.json({ sites: results, activeSiteId: currentSiteId });
  } catch (error) { res.status(500).json({ error: String(error?.message || error) }); }
});
app.post("/api/sites", async (req, res) => {
  try { const site = validateSiteInput(req.body); await saveSite(site); res.status(201).json({ site }); }
  catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
});
app.put("/api/sites/:id", async (req, res) => {
  try {
    const existing = await getSite(req.params.id);
    if (!existing) return res.status(404).json({ error: "Site not found." });
    const site = validateSiteInput(req.body, existing);
    await saveSite(site);
    res.json({ site });
  } catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
});
app.delete("/api/sites/:id", async (req, res) => {
  try {
    if (currentSiteId === req.params.id) {
      if (busy) return res.status(409).json({ error: "Close the active browser before deleting this site." });
      await context?.close().catch(() => {});
      context = page = null; currentSiteId = null;
    }
    await deleteSite(req.params.id);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
});
app.post("/api/sites/:id/open", withBrowser(async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) throw new Error("الموقع غير موجود.");
  const opened = await openSite(site, req.body?.url || null);
  res.json({ ok: true, ...opened });
}));
app.post("/api/browser/navigate", withBrowser(async (req, res) => {
  browserRequired();
  const site = await getSite(currentSiteId);
  const url = assertSafeUrl(String(req.body?.url || ""));
  if (!hostAllowed(url.toString(), site)) throw new Error("النطاق غير موجود في قائمة النطاقات المسموح بها لهذا الموقع.");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
  await persistCurrentSession();
  res.json({ ok: true, url: page.url(), title: await page.title() });
}));
app.get("/api/browser/snapshot", withBrowser(async (_req, res) => {
  browserRequired();
  const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const controls = await page.locator("input,textarea,button,select,[role=button],a,video,canvas").evaluateAll(nodes =>
    nodes.slice(0, 180).map((el, index) => {
      const id = el.id;
      const name = el.getAttribute("name");
      const placeholder = el.getAttribute("placeholder");
      const label = (el.innerText || el.getAttribute("aria-label") || placeholder || "").trim().replace(/\s+/g, " ").slice(0, 150);
      let selector = el.tagName.toLowerCase();
      if (id) selector = "#" + id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      else if (name) selector += '[name="' + name.replace(/"/g, '\\"') + '"]';
      else if (placeholder && ["INPUT", "TEXTAREA"].includes(el.tagName)) selector += '[placeholder="' + placeholder.replace(/"/g, '\\"') + '"]';
      else if (el.type === "file") selector = 'input[type="file"]';
      else if (label && ["BUTTON", "A"].includes(el.tagName)) selector += ':has-text("' + label.replace(/"/g, '\\"') + '")';
      return { index, tag: el.tagName.toLowerCase(), type: el.getAttribute("type"), text: label,
        placeholder, name, disabled: Boolean(el.disabled), selector };
    })
  );
  res.json({ url: page.url(), title: await page.title(), text: text.slice(0, 12000), controls });
}));
app.get("/api/browser/screenshot", withBrowser(async (_req, res) => {
  browserRequired();
  const image = await page.screenshot({ type: "jpeg", quality: 72, fullPage: false });
  res.json({ ok: true, width: VIEWPORT.width, height: VIEWPORT.height, imageBase64: image.toString("base64") });
}));
app.post("/api/browser/click", withBrowser(async (req, res) => {
  browserRequired();
  const x = Number(req.body?.x), y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) throw new Error("نقطة النقر خارج مساحة المتصفح.");
  await page.mouse.click(x, y);
  await persistCurrentSession().catch(() => {});
  res.json({ ok: true, url: page.url() });
}));
app.post("/api/browser/type", withBrowser(async (req, res) => {
  browserRequired();
  const value = String(req.body?.text ?? "");
  if (value.length > 5000) throw new Error("النص أطول من الحد المسموح.");
  await page.keyboard.insertText(value);
  res.json({ ok: true });
}));
app.post("/api/browser/key", withBrowser(async (req, res) => {
  browserRequired();
  const allowed = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Control+A", "Meta+A"]);
  const key = String(req.body?.key || "");
  if (!allowed.has(key)) throw new Error("مفتاح لوحة المفاتيح غير مسموح.");
  await page.keyboard.press(key);
  await persistCurrentSession().catch(() => {});
  res.json({ ok: true });
}));
app.post("/api/browser/scroll", withBrowser(async (req, res) => {
  browserRequired();
  const deltaY = Math.max(-1200, Math.min(1200, Number(req.body?.deltaY || 0)));
  await page.mouse.wheel(0, deltaY);
  res.json({ ok: true });
}));
app.post("/api/browser/fill", withBrowser(async (req, res) => {
  browserRequired();
  const selector = String(req.body?.selector || "");
  const value = String(req.body?.value ?? "");
  if (!selector || value.length > 12000) throw new Error("أدخل محدد الحقل والنص.");
  await page.locator(selector).first().fill(value);
  res.json({ ok: true });
}));
app.post("/api/browser/save-session", withBrowser(async (_req, res) => {
  browserRequired();
  await persistCurrentSession();
  res.json({ ok: true, siteId: currentSiteId, savedAt: new Date().toISOString() });
}));
app.delete("/api/sites/:id/session", async (req, res) => {
  try {
    if (currentSiteId === req.params.id && busy) return res.status(409).json({ error: "Close the active browser before clearing this session." });
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: "Site not found." });
    await deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
});
app.post("/api/generate", async (req, res) => {
  if (busy) return res.status(409).json({ error: "المتصفح ينفذ مهمة أخرى حالياً." });
  const siteId = String(req.body?.siteId || currentSiteId || "");
  const prompt = String(req.body?.prompt || "").trim();
  if (!siteId || !prompt || prompt.length > 12000) return res.status(400).json({ error: "اختر موقعاً وأدخل وصف الفيديو." });
  const site = await getSite(siteId).catch(() => null);
  if (!site) return res.status(404).json({ error: "الموقع غير موجود." });
  const { promptSelector, generateSelector, readySelector, downloadSelector, uploadSelector } = site.selectors;
  if (!promptSelector || !generateSelector || !readySelector || !downloadSelector) {
    return res.status(400).json({ error: "للتوليد بضغطة واحدة، اضبط محدد حقل الوصف وزر التوليد وعنصر جاهزية النتيجة وزر التنزيل أولاً." });
  }
  const imageBase64 = req.body?.imageBase64 || "";
  const imageName = String(req.body?.imageName || "reference.png").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (imageBase64 && (!uploadSelector || typeof imageBase64 !== "string" || imageBase64.length > 20_000_000)) {
    return res.status(400).json({ error: "حدد حقل رفع الصور، ولا يتجاوز حجم الصورة المرسلة الحد المسموح." });
  }
  busy = true;
  const job = {
    id: randomUUID(), siteId, status: "queued", stage: "queued",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    result: null, error: null, prompt: prompt.slice(0, 300)
  };
  jobs.set(job.id, job);
  res.status(202).json({ jobId: job.id, status: job.status });
  void (async () => {
    try {
      job.status = "running"; job.stage = "opening-site"; job.updatedAt = new Date().toISOString();
      if (!context || currentSiteId !== siteId) await openSite(site);
      job.stage = "entering-prompt";
      await page.locator(promptSelector).first().fill(prompt);
      if (imageBase64) {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        const filePath = path.join(UPLOAD_DIR, randomUUID() + "-" + imageName);
        await fs.writeFile(filePath, Buffer.from(imageBase64, "base64"));
        await page.locator(uploadSelector).first().setInputFiles(filePath);
      }
      job.stage = "submitting-generation";
      await page.locator(generateSelector).first().click();
      job.stage = "waiting-for-result"; job.updatedAt = new Date().toISOString();
      await page.locator(readySelector).first().waitFor({ state: "visible", timeout: site.waitSeconds * 1000 });
      await page.waitForFunction(selector => {
        const element = document.querySelector(selector);
        return Boolean(element && !element.disabled && element.getAttribute("aria-disabled") !== "true");
      }, readySelector, { timeout: site.waitSeconds * 1000 });
      job.stage = "downloading";
      await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 120000 }),
        page.locator(downloadSelector).first().click()
      ]);
      const suggested = path.basename(download.suggestedFilename() || ("video-" + Date.now() + ".mp4"));
      const safeFilename = suggested.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
      const downloadId = randomUUID();
      const filePath = path.join(DOWNLOAD_DIR, downloadId + "-" + safeFilename);
      await download.saveAs(filePath);
      await persistCurrentSession().catch(() => {});
      job.status = "completed"; job.stage = "completed";
      job.result = { downloadId, filename: safeFilename, downloadUrl: "/api/downloads/" + downloadId };
      job.updatedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed"; job.stage = "failed";
      job.error = String(error?.message || error).slice(0, 500);
      job.updatedAt = new Date().toISOString();
    } finally { busy = false; }
  })();
});
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "المهمة غير موجودة أو انتهت صلاحية سجلها بعد إعادة تشغيل الخدمة." });
  res.json(job);
});
app.get("/api/downloads/:id", async (req, res) => {
  try {
    const entries = await fs.readdir(DOWNLOAD_DIR);
    const match = entries.find(name => name.startsWith(req.params.id + "-"));
    if (!match) return res.status(404).json({ error: "ملف الفيديو غير موجود." });
    res.download(path.join(DOWNLOAD_DIR, match), match.slice(req.params.id.length + 1));
  } catch (error) { res.status(404).json({ error: String(error?.message || error) }); }
});
app.post("/api/browser/close", async (_req, res) => {
  if (busy) return res.status(409).json({ error: "المتصفح مشغول." });
  try {
    await persistCurrentSession().catch(() => {});
    await context?.close().catch(() => {});
    context = page = null; currentSiteId = null;
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
});

app.use(express.static(UI_DIR, { index: "index.html", maxAge: "1h" }));
app.get("/", (_req, res) => res.sendFile(path.join(UI_DIR, "index.html")));

await initStore();
await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
app.listen(PORT, "0.0.0.0", () => console.log("JoyVerse browser agent listening on " + PORT));
