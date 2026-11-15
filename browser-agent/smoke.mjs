import { chromium } from "playwright";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const out = "browser-agent-output";
await mkdir(out, { recursive: true });

const prompt = "Zeno, a small cheerful turquoise dragon with a cream belly, big amber eyes, two small golden horns and delicate golden wings, stands in a colorful flower garden. Zeno blinks, gently waves one wing and takes one happy little step forward. Polished high-quality friendly 3D cartoon animation, smooth natural motion, warm daylight, vibrant cheerful colors, stable camera, no text, no logos.";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage({ viewport: { width: 1365, height: 900 } });
const network = [];
const failures = [];
const errors = [];
const popups = [];
let savedFile = null;

const cleanUrl = value => {
  try { const u = new URL(value); return u.origin + u.pathname; }
  catch { return String(value || "").slice(0, 300); }
};

page.on("response", response => {
  if (/api|generate|video|task|queue|render|turnstile/i.test(response.url())) {
    network.push({
      url: cleanUrl(response.url()),
      method: response.request().method(),
      status: response.status(),
      contentType: response.headers()["content-type"] || ""
    });
  }
});
page.on("requestfailed", request => failures.push({
  url: cleanUrl(request.url()),
  error: request.failure()?.errorText || ""
}));
page.on("pageerror", error => errors.push(String(error?.message || error).slice(0, 400)));
page.on("console", message => {
  if (message.type() === "error") errors.push(message.text().slice(0, 350));
});
context.on("page", popup => {
  if (popup !== page) {
    popups.push({ url: cleanUrl(popup.url()), title: "" });
    popup.title().then(title => { popups[popups.length - 1].title = title; }).catch(() => {});
  }
});
page.on("download", async download => {
  const name = path.basename(download.suggestedFilename() || "loremotion-video.mp4")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(out, name);
  try {
    await download.saveAs(filePath);
    savedFile = filePath;
  } catch (error) {
    errors.push("download: " + String(error).slice(0, 300));
  }
});

async function inspect() {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || "").slice(0, 7000),
    prompt: document.querySelector("#generate-prompt-dock")?.value || null,
    settingsLabel: document.querySelector('button[aria-label^="Settings:"]')?.getAttribute("aria-label") || null,
    videos: [...document.querySelectorAll("video")].map(video => ({
      src: video.currentSrc || video.src,
      readyState: video.readyState,
      duration: Number.isFinite(video.duration) ? video.duration : null
    })),
    links: [...document.querySelectorAll("a")].map(anchor => ({
      text: (anchor.innerText || anchor.textContent || "").trim().slice(0, 100),
      href: anchor.href
    })).filter(link => /download|\.mp4/i.test(link.text + " " + link.href)).slice(0, 20),
    turnstile: {
      iframeCount: document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]').length,
      responseInputs: [...document.querySelectorAll('input[id*="cf-chl-widget"], input[name="cf-turnstile-response"]')]
        .map(input => ({ id: input.id, valuePresent: Boolean((input.value || "").trim()) }))
    },
    generateButtons: [...document.querySelectorAll("button")]
      .filter(button => /^Generate/i.test((button.innerText || button.textContent || "").trim()))
      .map(button => ({ text: (button.innerText || button.textContent || "").trim(), disabled: button.disabled })),
    visibleDialogs: [...document.querySelectorAll('[role="dialog"], dialog[open]')].map(dialog => ({
      text: (dialog.innerText || dialog.textContent || "").trim().slice(0, 1000),
      buttons: [...dialog.querySelectorAll("button")].map(button => ({
        text: (button.innerText || button.textContent || "").trim(),
        aria: button.getAttribute("aria-label")
      }))
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
      savedFile = path.join(out, "loremotion-generated.mp4");
      await writeFile(savedFile, Buffer.from(base64, "base64"));
    } else if (/^https?:/i.test(video.src)) {
      const response = await context.request.get(video.src, { timeout: 90000 });
      if (response.ok()) {
        savedFile = path.join(out, "loremotion-generated.mp4");
        await writeFile(savedFile, await response.body());
      }
    }
  } catch (error) {
    errors.push("video-save: " + String(error?.message || error).slice(0, 400));
  }
}

let report = { stage: "starting" };
try {
  await page.goto("https://loremotion.com/generate/", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.waitForTimeout(4500);
  const before = await inspect();
  await page.screenshot({ path: path.join(out, "loremotion-before.png"), fullPage: true });

  // Select the site's own free LTX 2.5 text-to-video template.
  const ltxTemplate = page.getByRole("button", { name: /Use Write a scene with LTX 2\.5/i }).first();
  if (await ltxTemplate.count()) {
    await ltxTemplate.click({ timeout: 10000 });
    await page.waitForTimeout(1800);
  }

  let state = await inspect();
  if (!/LTX 2\.5/i.test(state.settingsLabel || "") && !/LTX 2\.5/i.test(state.text.slice(0, 1800))) {
    // The visible model selector is the official way to change the current model.
    const modelCard = page.getByRole("button", { name: /MiniMax H3/i }).first();
    if (await modelCard.count()) {
      await modelCard.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(700);
      const choices = page.getByRole("button", { name: /^LTX 2\.5$/i });
      if (await choices.count()) await choices.first().click({ timeout: 8000 });
      await page.waitForTimeout(1200);
    }
  }

  const promptBox = page.locator("#generate-prompt-dock");
  if (!(await promptBox.count())) throw new Error("LoreMotion prompt field #generate-prompt-dock was not found.");
  await promptBox.fill(prompt);
  await page.waitForTimeout(800);

  // Use the vertical short-video format and a low-cost resolution.
  const ratioButton = page.getByRole("button", { name: "9:16", exact: true }).first();
  if (await ratioButton.count()) await ratioButton.click({ timeout: 5000 }).catch(() => {});
  const resolutionButton = page.getByRole("button", { name: "480p", exact: true }).first();
  if (await resolutionButton.count()) await resolutionButton.click({ timeout: 5000 }).catch(() => {});

  state = await inspect();
  report = {
    stage: "ready-check",
    before: { url: before.url, title: before.title, settingsLabel: before.settingsLabel },
    configured: {
      url: state.url,
      title: state.title,
      settingsLabel: state.settingsLabel,
      prompt: state.prompt,
      turnstile: state.turnstile,
      generateButtons: state.generateButtons,
      visibleDialogs: state.visibleDialogs
    }
  };
  await page.screenshot({ path: path.join(out, "loremotion-ready.png"), fullPage: true });

  const generate = page.getByRole("button", { name: /^Generate/i }).first();
  if (!(await generate.count())) throw new Error("Generate button not found.");

  // Wait for the website's own button state. Do not inject, forge or replace any challenge token.
  let enabled = await generate.isEnabled().catch(() => false);
  if (!enabled) {
    report.siteWaitSeconds = 60;
    enabled = await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")]
        .find(item => /^Generate/i.test((item.innerText || item.textContent || "").trim()));
      return Boolean(button && !button.disabled);
    }, null, { timeout: 60000 }).then(() => true).catch(() => false);
  }

  report.generateEnabledBySite = Boolean(enabled);
  report.afterSiteWait = await inspect();

  if (enabled) {
    await page.screenshot({ path: path.join(out, "loremotion-before-submit.png"), fullPage: true });
    await generate.click({ timeout: 12000 });
    report.stage = "submitted";
    report.submittedAt = new Date().toISOString();

    const startedAt = Date.now();
    let rewardedAdWaited = false;
    while (Date.now() - startedAt < 240000) {
      await page.waitForTimeout(4000);
      const current = await inspect();
      await saveVideo(current);

      if (savedFile || current.videos.some(video => video.src && video.readyState >= 2) ||
          current.links.some(link => /download/i.test(link.text))) {
        report.stage = savedFile ? "video-downloaded" : "video-ready";
        report.result = current;
        break;
      }

      const dialogText = current.visibleDialogs.map(dialog => dialog.text).join(" ").toLowerCase();
      const actualRewardedAd = /watch (a|this) (short )?ad|rewarded ad|ad to continue|watch.*to generate/.test(dialogText);
      if (actualRewardedAd && !rewardedAdWaited) {
        rewardedAdWaited = true;
        report.rewardedAdDetected = true;
        report.rewardedAdWaitSeconds = 30;
        await page.waitForTimeout(30000);
        const dialog = page.getByRole("dialog").filter({ hasText: /watch (a|this) (short )?ad|rewarded ad|ad to continue|watch.*to generate/i }).last();
        const close = dialog.getByRole("button", { name: /close/i }).last();
        if (await close.count() && await close.isVisible().catch(() => false)) {
          await close.click({ timeout: 5000 }).catch(error => errors.push("rewarded-ad close: " + String(error).slice(0, 250)));
        }
      }

      if (!/^https:\/\/loremotion\.com\//i.test(current.url)) {
        report.stage = "external-ad-navigation";
        report.result = current;
        break;
      }
      if (/generation failed|request failed|something went wrong|queue is full|try again later|daily limit|limit reached/.test(current.text.toLowerCase())) {
        report.stage = "generation-error";
        report.result = current;
        break;
      }
    }
    if (!report.result) report.result = await inspect();
    if (!savedFile) await saveVideo(report.result);
  } else {
    report.stage = "site-kept-generate-disabled";
    report.reason = "LoreMotion did not enable Generate during the normal 60-second wait; no verification was bypassed.";
  }

  report.savedFile = savedFile;
  report.network = network.slice(-80);
  report.failures = failures.slice(0, 50);
  report.errors = errors.slice(0, 40);
  report.popups = popups;
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
    if (!report.file.validMp4) report.stage = "downloaded-invalid-media";
  }

  await page.screenshot({ path: path.join(out, "loremotion-after.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(out, "loremotion-result.json"), JSON.stringify(report, null, 2));
  console.log("LOREMOTION DIRECT RESULT", JSON.stringify({
    stage: report.stage,
    settingsLabel: report.configured?.settingsLabel,
    generateEnabledBySite: report.generateEnabledBySite,
    rewardedAdDetected: report.rewardedAdDetected,
    file: report.file || null,
    reason: report.reason || null,
    resultUrl: report.result?.url || null,
    failures: failures.slice(0, 10),
    errors: errors.slice(0, 10),
    popups
  }, null, 2));

  if (report.stage === "site-kept-generate-disabled") process.exitCode = 2;
  else if (report.stage === "generation-error" || report.stage === "external-ad-navigation") process.exitCode = 3;
  else if (report.stage === "downloaded-invalid-media") process.exitCode = 4;
  else if (report.stage !== "video-downloaded") process.exitCode = 5;
} catch (error) {
  report.stage = "failed";
  report.error = String(error?.stack || error).slice(0, 5000);
  report.network = network.slice(-50);
  report.failures = failures.slice(0, 30);
  report.errors = errors.slice(0, 30);
  report.popups = popups;
  await writeFile(path.join(out, "loremotion-result.json"), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(out, "loremotion-failure.png"), fullPage: true }).catch(() => {});
  console.error("LOREMOTION DIRECT FAILURE", report.error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
