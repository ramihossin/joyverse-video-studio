import { chromium } from "playwright";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const out = "browser-agent-output";
await mkdir(out, { recursive: true });
const prompt = "A tiny cheerful turquoise dragon with small golden wings gently waves beside a colorful flower garden. Polished friendly 3D cartoon animation, bright joyful colors, soft warm daylight, one simple continuous action, smooth camera movement, no text.";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage({ viewport: { width: 1365, height: 900 } });
const network = [], failures = [], errors = [], downloads = [];
let savedFile = null;

function safeUrl(raw) {
  try { const u = new URL(raw); return u.origin + u.pathname; }
  catch { return String(raw).split("?")[0]; }
}
page.on("response", r => {
  if (!/api|generate|video|task|queue|render|ad|reward/i.test(r.url())) return;
  network.push({ url: safeUrl(r.url()), method: r.request().method(), status: r.status(), contentType: r.headers()["content-type"] || "" });
});
page.on("requestfailed", r => failures.push({ url: safeUrl(r.url()), error: r.failure()?.errorText || "" }));
page.on("pageerror", e => errors.push(String(e?.message || e).slice(0, 500)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("download", async d => {
  const name = path.basename(d.suggestedFilename() || "loremotion-generated.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  const target = path.join(out, name);
  try {
    await d.saveAs(target);
    savedFile = target;
    downloads.push({ name, path: target, failure: null });
  } catch (e) { downloads.push({ name, path: null, failure: String(e).slice(0, 300) }); }
});
const inspect = () => page.evaluate(() => ({
  url: location.href, title: document.title,
  text: (document.body?.innerText || "").slice(0, 10000),
  videos: [...document.querySelectorAll("video")].map(v => ({ src: v.currentSrc || v.src, readyState: v.readyState, duration: Number.isFinite(v.duration) ? v.duration : null, poster: v.poster || null })),
  links: [...document.querySelectorAll("a")].map(a => ({ text: (a.innerText || a.textContent || "").trim().slice(0, 100), href: a.href })).filter(a => /download|\.mp4/i.test(a.text + " " + a.href)).slice(0, 30),
  selects: [...document.querySelectorAll("select")].map(s => ({ name: s.name, id: s.id, value: s.value, options: [...s.options].map(o => ({ label: o.textContent.trim(), value: o.value })) })),
  controls: [...document.querySelectorAll("input,textarea,select,button,[role=button],[role=combobox]")].map(e => ({
    tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), type: e.getAttribute("type"), id: e.id || null,
    placeholder: e.getAttribute("placeholder"), aria: e.getAttribute("aria-label"),
    text: (e.innerText || e.textContent || "").trim().slice(0, 140),
    value: "value" in e ? e.value : null, disabled: "disabled" in e ? e.disabled : null
  }))
}));
async function saveVideoFromElement(state) {
  const vid = state.videos?.find(v => v.src && v.readyState >= 2) || state.videos?.find(v => v.src);
  if (!vid?.src || savedFile) return;
  try {
    const bytes = await page.evaluate(async src => {
      const response = await fetch(src);
      if (!response.ok) throw new Error("video fetch returned " + response.status);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, vid.src);
    const p = path.join(out, "loremotion-generated.mp4");
    await writeFile(p, Buffer.from(bytes));
    savedFile = p;
  } catch (e) {
    try {
      if (/^https?:/i.test(vid.src)) {
        const response = await context.request.get(vid.src, { timeout: 90000 });
        if (response.ok()) {
          const p = path.join(out, "loremotion-generated.mp4");
          await writeFile(p, await response.body());
          savedFile = p;
        }
      }
    } catch (e2) { errors.push("video download: " + String(e2).slice(0, 300)); }
  }
}
try {
  await page.goto("https://loremotion.com/generate/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  const before = await inspect();
  await page.screenshot({ path: path.join(out, "loremotion-before.png"), fullPage: true });

  // Fill the text-to-video prompt without signing in or using any premium-credit model.
  const promptCandidates = [page.locator("textarea").first(), page.locator('input[placeholder*="prompt" i]').first(), page.locator('[contenteditable="true"]').first()];
  let promptFilled = false;
  for (const candidate of promptCandidates) {
    if (await candidate.count()) {
      try { await candidate.fill(prompt); promptFilled = true; break; } catch {}
    }
  }
  await page.waitForTimeout(800);

  // Select a genuinely free model if the page exposes model selection.
  let modelSelection = "not-detected";
  for (const sel of await page.locator("select").all()) {
    const opts = await sel.locator("option").allTextContents().catch(() => []);
    const target = opts.find(t => /LTX.*2\.5|MiniMax.*H3/i.test(t));
    if (target) {
      const value = await sel.locator("option").filter({ hasText: target }).first().getAttribute("value");
      if (value) {
        await sel.selectOption(value).catch(() => {});
        modelSelection = target;
        break;
      }
    }
  }
  // Some custom model pickers are buttons/comboboxes rather than native selects.
  if (modelSelection === "not-detected") {
    const picker = page.getByRole("combobox").first();
    if (await picker.count()) {
      try {
        await picker.click();
        const option = page.getByText(/LTX[- ]Video 2\.5|MiniMax H3/i).first();
        if (await option.count()) { await option.click(); modelSelection = "free model selected in picker"; }
      } catch {}
    }
  }

  let ready = await inspect();
  await writeFile(path.join(out, "loremotion-before.json"), JSON.stringify({ before, ready, promptFilled, modelSelection }, null, 2));
  console.log("LOREMOTION PAGE", JSON.stringify({ url: ready.url, title: ready.title, text: ready.text.slice(0, 3200), promptFilled, modelSelection, controls: ready.controls, selects: ready.selects }, null, 2));

  // Stop rather than attempting to defeat CAPTCHA, account checks, or other access controls.
  const securityBlocked = /captcha|verify you are human|security check|checking your browser|access denied/i.test(ready.text) ||
    await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"]').count() > 0;
  const signInRequired = /sign in to continue|log in to continue|create an account to generate/i.test(ready.text);
  let result = { stage: "inspection-only", promptFilled, modelSelection, securityBlocked, signInRequired, before, ready };

  const button = page.getByRole("button", { name: /generate/i }).filter({ visible: true }).first();
  const buttonCount = await button.count();
  const buttonEnabled = buttonCount ? await button.isEnabled().catch(() => false) : false;
  result.buttonCount = buttonCount;
  result.buttonEnabled = buttonEnabled;

  if (!securityBlocked && !signInRequired && promptFilled && buttonEnabled) {
    await button.click();
    result.stage = "submitted";
    const start = Date.now();
    while (Date.now() - start < 240000) {
      await page.waitForTimeout(4000);
      const state = await inspect();
      if (state.videos.some(v => v.src && v.readyState >= 2) || state.links.some(a => /download/i.test(a.text)) || savedFile) {
        result.stage = "video-ready";
        result.state = state;
        await saveVideoFromElement(state);
        break;
      }
      if (/generation failed|request failed|something went wrong|queue is full|try again later|daily limit|limit reached/i.test(state.text)) {
        result.stage = "generation-stopped";
        result.state = state;
        break;
      }
    }
    if (!result.state) result.state = await inspect();
  }

  if (!savedFile && result.state) await saveVideoFromElement(result.state);
  result.savedFile = savedFile;
  result.downloads = downloads;
  result.network = network;
  result.failures = failures;
  result.errors = errors;
  if (savedFile) {
    try {
      const info = await stat(savedFile);
      const fs = await import("node:fs/promises");
      const head = await fs.readFile(savedFile);
      result.file = { bytes: info.size, ftyp: head.subarray(4, 8).toString("ascii"), validMp4Signature: head.subarray(4, 8).toString("ascii") === "ftyp" };
    } catch {}
  }
  await page.screenshot({ path: path.join(out, "loremotion-after.png"), fullPage: true });
  await writeFile(path.join(out, "loremotion-result.json"), JSON.stringify(result, null, 2));
  console.log("LOREMOTION RESULT", JSON.stringify({
    stage: result.stage, promptFilled, modelSelection, securityBlocked, signInRequired,
    buttonCount, buttonEnabled, videoCount: result.state?.videos?.length || 0,
    savedFile, file: result.file, failures: failures.slice(0, 12), errors: errors.slice(0, 12)
  }, null, 2));
  if (result.stage === "inspection-only" && (securityBlocked || signInRequired)) process.exitCode = 2;
  else if (result.stage === "inspection-only" && !buttonEnabled) process.exitCode = 3;
  else if (result.stage === "generation-stopped") process.exitCode = 4;
  else if (result.stage === "video-ready" && !savedFile) process.exitCode = 5;
} catch (e) {
  await writeFile(path.join(out, "loremotion-exception.txt"), String(e?.stack || e));
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
