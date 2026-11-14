import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const out = "browser-agent-output";
await mkdir(out, { recursive: true });
const prompt = "A tiny cheerful turquoise dragon with small golden wings gently waves beside a colorful flower garden. Polished friendly 3D cartoon animation, bright joyful colors, soft warm daylight, one simple continuous action, smooth camera, no text.";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage({ viewport: { width: 1365, height: 900 } });
const network = [], failures = [], errors = [], downloads = [];
let savedFile = null;

page.on("response", r => {
  if (!/api|generate|video|task|queue|gradio|8scale/i.test(r.url())) return;
  let safeUrl;
  try { const u = new URL(r.url()); safeUrl = u.origin + u.pathname; } catch { safeUrl = r.url().split("?")[0]; }
  network.push({ url: safeUrl, method: r.request().method(), status: r.status(), contentType: r.headers()["content-type"] || "" });
});
page.on("requestfailed", r => {
  let safeUrl;
  try { const u = new URL(r.url()); safeUrl = u.origin + u.pathname; } catch { safeUrl = r.url().split("?")[0]; }
  failures.push({ url: safeUrl, error: r.failure()?.errorText || "" });
});
page.on("pageerror", e => errors.push(String(e?.message || e).slice(0, 500)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("download", async d => {
  const name = path.basename(d.suggestedFilename() || "wan2-video.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  const target = path.join(out, name.toLowerCase().endsWith(".mp4") ? name : name + ".mp4");
  try { await d.saveAs(target); savedFile = target; downloads.push({ name, path: target, failure: null }); }
  catch (e) { downloads.push({ name, path: null, failure: String(e).slice(0, 300) }); }
});
const inspect = () => page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: (document.body?.innerText || "").slice(0, 7000),
  videos: [...document.querySelectorAll("video")].map(v => ({ src: v.currentSrc || v.src, readyState: v.readyState, duration: Number.isFinite(v.duration) ? v.duration : null })),
  links: [...document.querySelectorAll("a")].map(a => ({ text: (a.innerText || a.textContent || "").trim().slice(0, 80), href: a.href })).filter(a => /download|\.mp4/i.test(a.text + " " + a.href)).slice(0, 20),
  controls: [...document.querySelectorAll("input,textarea,select,button,[role=button]")].map(e => ({
    tag: e.tagName.toLowerCase(), type: e.getAttribute("type"), id: e.id || null,
    placeholder: e.getAttribute("placeholder"),
    text: (e.innerText || e.textContent || "").trim().slice(0, 100),
    value: "value" in e ? e.value : null,
    disabled: "disabled" in e ? e.disabled : null
  }))
}));
try {
  await page.goto("https://wan2.video/ai-video-generator-free", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  let before = await inspect();
  await page.screenshot({ path: path.join(out, "wan2-before.png"), fullPage: true });
  const promptBox = page.locator("textarea").first();
  if (await promptBox.count()) await promptBox.fill(prompt);
  await page.waitForTimeout(1000);
  let ready = await inspect();
  await writeFile(path.join(out, "wan2-before.json"), JSON.stringify({ before, ready }, null, 2));
  console.log("WAN2 PAGE", JSON.stringify({ title: ready.title, text: ready.text.slice(0, 2500), controls: ready.controls }, null, 2));

  const start = Date.now();
  let generateButton = page.getByRole("button", { name: /generate free video/i }).first();
  while (Date.now() - start < 45000) {
    ready = await inspect();
    const blocked = /complete the security check|verify you are human|checking your browser|access denied|captcha/i.test(ready.text) ||
      await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"], #cf-chl-widget').count() > 0;
    if (blocked) {
      await writeFile(path.join(out, "wan2-blocked.json"), JSON.stringify({ ready, network, failures, errors }, null, 2));
      break;
    }
    if (await generateButton.count() && await generateButton.isEnabled()) break;
    await page.waitForTimeout(3000);
  }

  ready = await inspect();
  const buttonExists = await generateButton.count();
  const buttonEnabled = buttonExists ? await generateButton.isEnabled() : false;
  const securityBlocked = /complete the security check|verify you are human|checking your browser|access denied|captcha/i.test(ready.text) ||
    await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"], #cf-chl-widget').count() > 0;
  let result = { stage: "not-submitted", ready, securityBlocked, buttonExists, buttonEnabled, network, failures, errors };

  if (!securityBlocked && buttonEnabled) {
    await generateButton.click();
    result.stage = "submitted";
    const generationStart = Date.now();
    while (Date.now() - generationStart < 240000) {
      await page.waitForTimeout(4000);
      const state = await inspect();
      const hasVideo = state.videos.some(v => v.src && v.readyState >= 2);
      const hasDownload = state.links.some(a => /download/i.test(a.text));
      if (hasVideo || hasDownload || savedFile) {
        result.stage = "video-visible";
        result.state = state;
        break;
      }
      if (/generation failed|request failed|something went wrong|queue is full|try again later/i.test(state.text)) {
        result.stage = "generation-error";
        result.state = state;
        break;
      }
    }
    if (!result.state) result.state = await inspect();

    if (!savedFile && result.state.videos?.length) {
      const video = result.state.videos.find(v => v.src && v.readyState >= 2) || result.state.videos.find(v => v.src);
      if (video?.src) {
        try {
          if (video.src.startsWith("blob:")) {
            const base64 = await page.evaluate(async src => {
              const response = await fetch(src);
              if (!response.ok) throw new Error("blob fetch " + response.status);
              const bytes = new Uint8Array(await response.arrayBuffer());
              let binary = "";
              for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
              return btoa(binary);
            }, video.src);
            const { writeFile } = await import("node:fs/promises");
            const p = path.join(out, "wan2-generated.mp4");
            await writeFile(p, Buffer.from(base64, "base64"));
            savedFile = p;
          } else if (/^https?:/i.test(video.src)) {
            const response = await context.request.get(video.src, { timeout: 90000 });
            if (response.ok()) {
              const p = path.join(out, "wan2-generated.mp4");
              await writeFile(p, await response.body());
              savedFile = p;
            }
          }
        } catch (e) { result.videoSaveError = String(e).slice(0, 500); }
      }
    }
  }

  result.savedFile = savedFile;
  result.network = network;
  result.failures = failures;
  result.errors = errors;
  result.downloads = downloads;
  await page.screenshot({ path: path.join(out, "wan2-after.png"), fullPage: true });
  await writeFile(path.join(out, "wan2-result.json"), JSON.stringify(result, null, 2));
  console.log("WAN2 RESULT", JSON.stringify({
    stage: result.stage, securityBlocked, buttonExists, buttonEnabled,
    videos: result.state?.videos || [],
    savedFile, failures, errors: errors.slice(0, 10)
  }, null, 2));
  if (result.stage === "not-submitted") process.exitCode = securityBlocked ? 2 : 3;
  if (result.stage === "generation-error") process.exitCode = 4;
} catch (e) {
  await writeFile(path.join(out, "wan2-exception.txt"), String(e?.stack || e));
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
