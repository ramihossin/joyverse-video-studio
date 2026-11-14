import { chromium } from "playwright";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const out = "pika-browser-proof";
await mkdir(out, { recursive: true });

const prompt = "A joyful tiny turquoise dragon with small golden horns and golden wings gently waves beside a colorful flower garden. The dragon smiles warmly as a few butterflies flutter nearby. Polished friendly 3D cartoon animation, expressive face, rounded appealing design, bright saturated colors, soft warm morning sunlight, smooth gentle camera push-in, one continuous simple action, no words or captions.";
const soundscape = "Soft birdsong, a gentle breeze through leaves, and a few light magical chimes. No speech.";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage({ viewport: { width: 1365, height: 950 } });
const events = [], errors = [], downloads = [];
let savedFile = null;

const safeUrl = value => {
  try { const u = new URL(value); return u.origin + u.pathname; }
  catch { return String(value || "").slice(0, 300); }
};

page.on("response", response => {
  if (/run|queue|predict|api|video|file|generate|gradio/i.test(response.url())) {
    events.push({
      type: "response",
      url: safeUrl(response.url()),
      status: response.status(),
      contentType: response.headers()["content-type"] || ""
    });
  }
});
page.on("requestfailed", request => {
  errors.push({ type: "requestfailed", url: safeUrl(request.url()), error: request.failure()?.errorText || "" });
});
page.on("pageerror", error => errors.push({ type: "pageerror", message: String(error?.message || error).slice(0, 500) }));
page.on("console", message => {
  if (message.type() === "error") errors.push({ type: "console", message: message.text().slice(0, 500) });
});
page.on("download", async download => {
  const name = path.basename(download.suggestedFilename() || "pika-generated.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(out, name);
  try {
    await download.saveAs(filePath);
    savedFile = filePath;
    downloads.push({ name, saved: true });
  } catch (error) {
    downloads.push({ name, saved: false, error: String(error).slice(0, 300) });
  }
});

async function snapshot() {
  return page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText || "").slice(0, 10000),
    videos: [...document.querySelectorAll("video")].map(video => ({
      src: video.currentSrc || video.src,
      readyState: video.readyState,
      duration: Number.isFinite(video.duration) ? video.duration : null
    })),
    links: [...document.querySelectorAll("a")].map(anchor => ({
      text: (anchor.innerText || anchor.textContent || "").trim().slice(0, 100),
      href: anchor.href
    })).filter(link => /download|\.mp4|file=/i.test(link.text + " " + link.href)).slice(0, 15),
    buttons: [...document.querySelectorAll("button")].map(button => ({
      text: (button.innerText || button.textContent || "").trim().slice(0, 100),
      disabled: button.disabled,
      id: button.id || null
    })).filter(button => button.text || button.id).slice(0, 50),
    visibleTextareas: [...document.querySelectorAll("textarea")].filter(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }).map(el => ({
      placeholder: el.placeholder,
      aria: el.getAttribute("aria-label"),
      value: (el.value || "").slice(0, 400)
    }))
  }));
}

async function saveVideo(state) {
  if (savedFile) return;
  const video = state.videos.find(item => item.src && item.readyState >= 2) ||
                state.videos.find(item => item.src);
  if (!video?.src) return;

  try {
    if (video.src.startsWith("blob:")) {
      const base64 = await page.evaluate(async source => {
        const response = await fetch(source);
        if (!response.ok) throw new Error("Blob fetch HTTP " + response.status);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        }
        return btoa(binary);
      }, video.src);
      const filePath = path.join(out, "pika-h3-flex-generated.mp4");
      await writeFile(filePath, Buffer.from(base64, "base64"));
      savedFile = filePath;
    } else if (/^https:\/\//i.test(video.src)) {
      const response = await context.request.get(video.src, { timeout: 90000 });
      if (!response.ok()) throw new Error("Video HTTP " + response.status());
      const filePath = path.join(out, "pika-h3-flex-generated.mp4");
      await writeFile(filePath, await response.body());
      savedFile = filePath;
    }
  } catch (error) {
    errors.push({ type: "video-save", message: String(error?.stack || error).slice(0, 1000) });
  }
}

try {
  console.log("Opening public Pika H3 Flex interface…");
  await page.goto("https://pika-labs-pika-h3-flex.hf.space/", {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });
  await page.waitForTimeout(7000);

  const initial = await snapshot();
  await page.screenshot({ path: path.join(out, "pika-before-generation.png"), fullPage: true });

  const textMode = page.getByLabel("Text", { exact: true }).first();
  if (await textMode.count() && !(await textMode.isChecked().catch(() => false))) {
    await textMode.check({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  // The visible first shot textarea is the Builder's Shot 1 field.
  const visibleShotFields = page.locator("textarea:visible");
  const count = await visibleShotFields.count();
  if (count < 1) throw new Error("No visible shot prompt textarea is available.");

  await visibleShotFields.first().fill(prompt, { timeout: 10000 });

  // Use the visible soundscape field when present. Keep music off for this test.
  const soundscapeField = page.getByLabel("Soundscape").first();
  if (await soundscapeField.count()) {
    await soundscapeField.fill(soundscape).catch(() => {});
  }
  const musicField = page.getByLabel("Music").first();
  if (await musicField.count()) await musicField.fill("N/A").catch(() => {});

  // Use the supported visible 480p, landscape 16:9 and 5-second controls.
  const resolution480 = page.getByLabel("480p", { exact: true }).first();
  if (await resolution480.count()) await resolution480.check().catch(() => {});
  const aspect = page.getByLabel("Aspect").first();
  if (await aspect.count()) await aspect.fill("16:9").catch(() => {});
  const secondsInput = page.getByLabel("number input for Seconds").first();
  if (await secondsInput.count()) await secondsInput.fill("5").catch(() => {});

  await page.waitForTimeout(1000);
  const ready = await snapshot();
  const turnstile = await page.locator('iframe[src*="challenges.cloudflare.com"], input[name*="cf-turnstile"]').count();
  if (turnstile > 0) {
    throw new Error("Human verification appeared in the Pika page; stopping without attempting to bypass it.");
  }

  const generate = page.locator("#pk-go");
  if (!(await generate.count())) throw new Error("Pika Generate button #pk-go was not found.");
  if (!(await generate.isEnabled())) throw new Error("Pika Generate button is disabled before submission.");

  console.log("Pika form ready; starting one five-second generation request.");
  await generate.click({ timeout: 15000 });
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < 360000) {
    await page.waitForTimeout(4000);
    lastState = await snapshot();
    await saveVideo(lastState);
    if (savedFile || lastState.videos.some(video => video.src && video.readyState >= 2)) break;

    const text = lastState.text.toLowerCase();
    if (Math.floor((Date.now() - startedAt) / 30000) !== Math.floor((Date.now() - startedAt - 4000) / 30000)) {
      console.log("PIKA_GENERATION_PROGRESS", JSON.stringify({
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
        status_text: lastState.text.slice(-900)
      }));
    }
    // "Waiting for a GPU to become available" is a normal shared-queue state, not a failure.
    // Stop only on an explicit rejection, quota block, login gate, or verification challenge.
    if (/no gpu (?:was )?available|gpu quota.*exhaust|queue is full|failed to load|error while|generation failed|try again later|please sign in|log in to generate|verification required/.test(text)) {
      break;
    }
  }

  const finalState = lastState || await snapshot();
  await saveVideo(finalState);
  await page.screenshot({ path: path.join(out, "pika-after-generation.png"), fullPage: true });

  const report = {
    status: savedFile ? "video-downloaded" : "generation-not-confirmed",
    prompt,
    settings: { duration_seconds: 5, resolution: "480p", aspect_ratio: "16:9" },
    initial: {
      title: initial.title,
      text: initial.text.slice(0, 1800),
      visibleTextareas: initial.visibleTextareas
    },
    ready: {
      text: ready.text.slice(0, 1800),
      visibleTextareas: ready.visibleTextareas
    },
    final: {
      text: finalState.text.slice(0, 6000),
      videos: finalState.videos,
      links: finalState.links
    },
    submitted: true,
    savedFile,
    events: events.slice(-80),
    downloads,
    errors: errors.slice(0, 40)
  };

  if (savedFile) {
    const info = await stat(savedFile);
    const fs = await import("node:fs/promises");
    const bytes = await fs.readFile(savedFile);
    report.file = {
      name: path.basename(savedFile),
      bytes: info.size,
      signature: bytes.subarray(4, 8).toString("ascii"),
      validMp4: bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp"
    };
    if (!report.file.validMp4) report.status = "downloaded-invalid-media";
  }

  await writeFile(path.join(out, "result.json"), JSON.stringify(report, null, 2));
  console.log("PIKA_BROWSER_PROOF", JSON.stringify({
    status: report.status,
    file: report.file || null,
    events: report.events.slice(-20),
    tailText: finalState.text.slice(-2200),
    errors: report.errors.slice(-10)
  }, null, 2));

  if (report.status !== "video-downloaded" || !report.file?.validMp4) process.exitCode = 2;
} catch (error) {
  const report = {
    status: "failed",
    error: String(error?.stack || error).slice(0, 5000),
    events: events.slice(-50),
    errors: errors.slice(0, 30)
  };
  await writeFile(path.join(out, "result.json"), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(out, "pika-failure.png"), fullPage: true }).catch(() => {});
  console.error("PIKA_BROWSER_FAILURE", report.error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
