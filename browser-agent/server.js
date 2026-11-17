import express from "express";
import { chromium } from "playwright";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "25mb" }));

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.BROWSER_AGENT_TOKEN || "";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), "joyverse-agent-downloads");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), "joyverse-agent-uploads");
let browser;
let context;
let page;
let busy = false;

if (TOKEN.length < 32) throw new Error("BROWSER_AGENT_TOKEN must be at least 32 characters.");

function authorized(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header);
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function auth(req, res, next) {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function validateUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error("A valid absolute URL is required."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed.");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" ||
      host === "169.254.169.254" || host === "0.0.0.0" || host === "::1" ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("Local and private network destinations are blocked.");
  }
  return u.toString();
}
async function ensurePage() {
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1365, height: 900 } });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
  }
  return page;
}
function exclusive(fn) {
  return async (req, res) => {
    if (busy) return res.status(409).json({ error: "The browser is busy with another action." });
    busy = true;
    try { await ensurePage(); await fn(req, res); }
    catch (e) { res.status(400).json({ error: String(e?.message || e).slice(0, 500) }); }
    finally { busy = false; }
  };
}
app.get("/health", (_req, res) => res.json({ ok: true, service: "joyverse-free-browser-agent", browserStarted: Boolean(browser) }));
app.use("/api", auth);

app.post("/api/navigate", exclusive(async (req, res) => {
  const url = validateUrl(req.body?.url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  res.json({ ok: true, url: page.url(), title: await page.title() });
}));
app.get("/api/snapshot", exclusive(async (_req, res) => {
  const snapshot = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const controls = await page.locator("input,textarea,button,select,[role=button],a").evaluateAll(nodes =>
    nodes.slice(0, 250).map((el, i) => ({
      index: i, tag: el.tagName.toLowerCase(), type: el.getAttribute("type"),
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 180),
      placeholder: el.getAttribute("placeholder"), name: el.getAttribute("name"),
      ariaLabel: el.getAttribute("aria-label"), href: el.tagName === "A" ? el.href : undefined,
      disabled: Boolean(el.disabled)
    }))
  );
  res.json({ url: page.url(), title: await page.title(), text: snapshot.slice(0, 18000), controls });
}));
app.post("/api/click", exclusive(async (req, res) => {
  const { selector, text } = req.body || {};
  if (selector) await page.locator(String(selector)).first().click();
  else if (text) await page.getByText(String(text), { exact: true }).first().click();
  else throw new Error("Provide selector or exact text.");
  res.json({ ok: true, url: page.url(), title: await page.title() });
}));
app.post("/api/fill", exclusive(async (req, res) => {
  const { selector, value } = req.body || {};
  if (!selector || typeof value !== "string") throw new Error("Provide selector and string value.");
  await page.locator(String(selector)).first().fill(value);
  res.json({ ok: true });
}));
app.post("/api/upload", exclusive(async (req, res) => {
  const { selector, filename, contentBase64 } = req.body || {};
  if (!selector || typeof contentBase64 !== "string" || contentBase64.length > 20_000_000) throw new Error("Provide selector and a base64 file up to about 15 MB.");
  const safeName = path.basename(String(filename || "reference-image").replace(/[^\w.\-]/g, "_"));
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const filePath = path.join(UPLOAD_DIR, randomUUID() + "-" + safeName);
  await fs.writeFile(filePath, Buffer.from(contentBase64, "base64"));
  await page.locator(String(selector)).first().setInputFiles(filePath);
  res.json({ ok: true, filename: safeName });
}));
app.post("/api/screenshot", exclusive(async (_req, res) => {
  const image = await page.screenshot({ type: "jpeg", quality: 75, fullPage: false });
  res.json({ ok: true, mimeType: "image/jpeg", imageBase64: image.toString("base64") });
}));
app.post("/api/download", exclusive(async (_req, res) => {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.evaluate(() => {
      const links = [...document.querySelectorAll("a[download],a[href]")];
      const candidate = links.find(a => a.hasAttribute("download")) || links.find(a => /\.mp4(?:$|\?)/i.test(a.href));
      if (!candidate) throw new Error("No obvious downloadable link found. Click the site's download button first.");
      candidate.click();
    })
  ]);
  const filename = path.basename(download.suggestedFilename() || ("video-" + Date.now() + ".mp4"));
  const target = path.join(DOWNLOAD_DIR, randomUUID() + "-" + filename);
  await download.saveAs(target);
  res.json({ ok: true, filename, path: target, failure: await download.failure() });
}));
app.post("/api/click-download", exclusive(async (req, res) => {
  const { selector } = req.body || {};
  if (!selector) throw new Error("Provide the download button selector.");
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.locator(String(selector)).first().click()
  ]);
  const filename = path.basename(download.suggestedFilename() || ("video-" + Date.now() + ".mp4"));
  const target = path.join(DOWNLOAD_DIR, randomUUID() + "-" + filename);
  await download.saveAs(target);
  res.json({ ok: true, filename, path: target });
}));
app.post("/api/close", async (_req, res) => {
  if (busy) return res.status(409).json({ error: "Browser is busy." });
  if (browser) await browser.close();
  browser = context = page = null;
  res.json({ ok: true });
});
app.listen(PORT, "0.0.0.0", () => console.log("JoyVerse browser agent listening on " + PORT));
