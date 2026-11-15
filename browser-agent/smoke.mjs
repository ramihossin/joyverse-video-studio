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
let savedFile = null;

const cleanUrl = value => {
  try { const u = new URL(value); return u.origin + u.pathname; }
  catch { return String(value || "").slice(0, 300); }
};

page.on("response", response => {
  if (/api|generate|video|task|queue|render|turnstile|challenge/i.test(response.url())) {
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
  return page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        rect.width > 0 && rect.height > 0;
    };
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").slice(0, 6500),
      prompt: document.querySelector("#generate-prompt-dock")?.value || null,
      textareas: [...document.querySelectorAll("textarea")].filter(visible).map(node => ({
        id: node.id || null,
        placeholder: node.placeholder || "",
        value: (node.value || "").slice(0, 600)
      })),
      contenteditables: [...document.querySelectorAll('[contenteditable="true"]')].filter(visible).map(node => ({
        id: node.id || null,
        role: node.getAttribute("role"),
        text: (node.innerText || node.textContent || "").slice(0, 600)
      })),
      settingsLabel: document.querySelector('button[aria-label^="Settings:"]')?.getAttribute("aria-label") || null,
      videos: [...document.querySelectorAll("video")].map(video => ({
        src: video.currentSrc || video.src,
        readyState: video.readyState,
        duration: Number.isFinite(video.duration) ? video.duration : null
      })),
      turnstile: {
        frames: [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')].map(frame => frame.src),
        responseInputs: [...document.querySelectorAll('input[id*="cf-chl-widget"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')]
          .map(input => ({ id: input.id, valuePresent: Boolean((input.value || "").trim()) }))
      },
      generateButtons: [...document.querySelectorAll("button")].filter(button =>
        /generate/i.test((button.innerText || button.textContent || "").trim())
      ).map(button => ({
        text: (button.innerText || button.textContent || "").trim().slice(0, 100),
        disabled: button.disabled,
        aria: button.getAttribute("aria-label")
      })),
      visibleDialogs: [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter(visible).map(dialog => ({
        text: (dialog.innerText || dialog.textContent || "").trim().slice(0, 1000),
        buttons: [...dialog.querySelectorAll("button")].map(button => ({
          text: (button.innerText || button.textContent || "").trim(),
          aria: button.getAttribute("aria-label")
        }))
      }))
    };
  });
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

async function clickIfVisible(locator, label) {
  try {
    if (await locator.count() && await locator.last().isVisible()) {
      await locator.last().click({ timeout: 8000 });
      console.log("LOREMOTION_UI_ACTION", label);
      await page.waitForTimeout(1000);
      return true;
    }
  } catch (error) {
    errors.push(label + ": " + String(error).slice(0, 250));
  }
  return false;
}

let report = { stage: "starting" };
try {
  await page.goto("https://loremotion.com/generate/", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.waitForTimeout(5000);

  // Choose privacy-preserving options in the site's own dialogs.
  const privacyChoice = [];
  if (await clickIfVisible(page.getByRole("button", { name: /Reject non-essential/i }), "reject optional cookies")) {
    privacyChoice.push("reject-non-essential");
  }
  if (await clickIfVisible(page.getByRole("button", { name: /^Opt out$/i }), "opt out of data sale/sharing")) {
    privacyChoice.push("opt-out-of-sale-sharing");
  }

  // Dismiss first-visit tour using the site's ordinary UI controls.
  let onboardingDismissed = false;
  onboardingDismissed = await clickIfVisible(page.getByRole("button", { name: /Skip tour/i }), "skip onboarding tour");
  if (!onboardingDismissed) {
    onboardingDismissed = await clickIfVisible(page.getByRole("button", { name: /^Close$/i }), "close onboarding tour");
  }
  await page.waitForTimeout(1200);

  const before = await inspect();
  await page.screenshot({ path: path.join(out, "loremotion-before.png"), fullPage: true });

  // Select the site's own LTX 2.5 free scene template if available.
  const ltxTemplate = page.getByRole("button", { name: /Use Write a scene with LTX 2\.5/i }).first();
  if (await ltxTemplate.count() && await ltxTemplate.isVisible().catch(() => false)) {
    await ltxTemplate.click({ timeout: 8000 });
    await page.waitForTimeout(1200);
  }

  // Choose LTX 2.5 through the site's own model selector if it is not already selected.
  let state = await inspect();
  if (!/LTX 2\.5/i.test(state.settingsLabel || "") && !/LTX 2\.5/i.test(state.text.slice(0, 1800))) {
    const modelCard = page.getByRole("button", { name: /MiniMax H3/i }).first();
    if (await modelCard.count() && await modelCard.isVisible().catch(() => false)) {
      await modelCard.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(700);
      const choices = page.getByRole("button", { name: /^LTX 2\.5$/i });
      if (await choices.count()) await choices.first().click({ timeout: 8000 });
      await page.waitForTimeout(1200);
    }
  }

  // Current LoreMotion layout can present either the older dock or a new first-run editor.
  let promptFilled = false;
  const dock = page.locator("#generate-prompt-dock");
  if (await dock.count() && await dock.isVisible().catch(() => false)) {
    await dock.fill(prompt);
    promptFilled = true;
  }
  if (!promptFilled) {
    const fields = page.locator("textarea:visible");
    const count = await fields.count();
    if (count > 0) {
      let chosen = 0;
      for (let i = 0; i < count; i++) {
        const placeholder = await fields.nth(i).getAttribute("placeholder").catch(() => "");
        if (/shot|scene|prompt|describe/i.test(placeholder || "")) { chosen = i; break; }
      }
      await fields.nth(chosen).fill(prompt);
      promptFilled = true;
    }
  }
  if (!promptFilled) {
    const textboxes = page.getByRole("textbox");
    const count = await textboxes.count();
    if (count > 0) {
      await textboxes.first().fill(prompt);
      promptFilled = true;
    }
  }

  // Set portrait, short duration and low-cost resolution where those native controls are available.
  const ratioButton = page.getByRole("button", { name: "9:16", exact: true }).first();
  if (await ratioButton.count() && await ratioButton.isVisible().catch(() => false)) {
    await ratioButton.click({ timeout: 5000 }).catch(() => {});
  }
  const resolutionButton = page.getByRole("button", { name: "480p", exact: true }).first();
  if (await resolutionButton.count() && await resolutionButton.isVisible().catch(() => false)) {
    await resolutionButton.click({ timeout: 5000 }).catch(() => {});
  }

  state = await inspect();
  report = {
    stage: "ready-check",
    privacyChoice,
    onboardingDismissed,
    promptFilled,
    before: { url: before.url, title: before.title, settingsLabel: before.settingsLabel },
    configured: state
  };
  await page.screenshot({ path: path.join(out, "loremotion-ready.png"), fullPage: true });

  if (!promptFilled) throw new Error("No visible prompt field was available after dismissing privacy and onboarding dialogs.");

  // The website may show an enabled Generate button before its Turnstile response is issued.
  // Wait for a response token created by the official site script; never click or forge the challenge.
  const readTokenPresence = async () => page.locator(
    'input[id*="cf-chl-widget"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
  ).evaluateAll(nodes => nodes.some(node => Boolean((node.value || "").trim()))).catch(() => false);

  let tokenPresent = await readTokenPresence();
  if (!tokenPresent) {
    report.siteVerificationWaitSeconds = 90000;
    tokenPresent = await page.waitForFunction(() => {
      const inputs = [...document.querySelectorAll(
        'input[id*="cf-chl-widget"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
      )];
      return inputs.some(node => Boolean((node.value || "").trim()));
    }, null, { timeout: 90000 }).then(() => true).catch(() => false);
  }

  state = await inspect();
  const generate = page.getByRole("button", { name: /Generate/i }).last();
  const generateExists = await generate.count() > 0;
  const generateEnabled = generateExists && await generate.isEnabled().catch(() => false);

  report.generateButtonFound = Boolean(generateExists);
  report.generateEnabledBySite = Boolean(generateEnabled);
  report.turnstileResponseIssuedBySite = Boolean(tokenPresent);
  report.afterSiteWait = state;

  if (tokenPresent && generateEnabled) {
    await page.screenshot({ path: path.join(out, "loremotion-before-submit.png"), fullPage: true });
    await generate.click({ timeout: 12000 });
    report.stage = "submitted";
    report.submittedAt = new Date().toISOString();

    const start = Date.now();
    while (Date.now() - start < 240000) {
      await page.waitForTimeout(4000);
      const current = await inspect();
      await saveVideo(current);

      if (savedFile || current.videos.some(video => video.src && video.readyState >= 2) ||
          current.links.some(link => /download/i.test(link.text))) {
        report.stage = savedFile ? "video-downloaded" : "video-ready";
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
    report.stage = "human-verification-required";
    report.reason = !tokenPresent
      ? "LoreMotion did not issue a Turnstile response token during the normal wait; generation was not submitted."
      : "Generate was not enabled by LoreMotion; generation was not submitted.";
  }

  report.savedFile = savedFile;
  report.network = network.slice(-80);
  report.failures = failures.slice(0, 50);
  report.errors = errors.slice(0, 40);

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
  console.log("LOREMOTION FINAL RESULT", JSON.stringify({
    stage: report.stage,
    privacyChoice,
    onboardingDismissed,
    promptFilled,
    settingsLabel: state.settingsLabel,
    generateButtonFound: report.generateButtonFound,
    generateEnabled: report.generateEnabledBySite,
    turnstileResponseIssued: report.turnstileResponseIssuedBySite,
    file: report.file || null,
    reason: report.reason || null,
    failures: failures.slice(0, 12),
    errors: errors.slice(0, 12)
  }, null, 2));

  if (report.stage === "human-verification-required") process.exitCode = 2;
  else if (report.stage === "generation-error") process.exitCode = 3;
  else if (report.stage === "downloaded-invalid-media") process.exitCode = 4;
  else if (report.stage !== "video-downloaded") process.exitCode = 5;
} catch (error) {
  report.stage = "failed";
  report.error = String(error?.stack || error).slice(0, 5000);
  report.network = network.slice(-80);
  report.failures = failures.slice(0, 30);
  report.errors = errors.slice(0, 30);
  await writeFile(path.join(out, "loremotion-result.json"), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(out, "loremotion-failure.png"), fullPage: true }).catch(() => {});
  console.error("LOREMOTION FINAL FAILURE", report.error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
