import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const INBOX = path.resolve("jvb-agent/inbox");
const RESULTS = path.resolve("jvb-agent/results");
const OUTPUT = path.resolve("jvb-agent/output");
const ALLOWED_HOSTS = new Set([
  "pavoai.app",
  "www.pavoai.app",
  "loremotion.com",
  "www.loremotion.com",
]);
const MAX_STEPS = 16;
const MAX_TEXT = 5000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15000;
const UPLOAD_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

function safeId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,80}$/.test(value);
}

function safeFileName(value, fallback) {
  const name = typeof value === "string" ? value : fallback;
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function validateUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("Navigation is restricted to the approved JVB video sites.");
  }
  return url;
}

function validateTask(task) {
  if (!task || !safeId(task.taskId)) {
    throw new Error("taskId must contain 3-80 letters, digits, underscores, or hyphens.");
  }
  if (!["inspect", "sequence"].includes(task.operation)) {
    throw new Error("Supported operations are inspect and sequence.");
  }
  const url = validateUrl(task.url);
  if (task.operation === "sequence") {
    if (!Array.isArray(task.steps) || task.steps.length < 1 || task.steps.length > MAX_STEPS) {
      throw new Error("A sequence must contain 1-16 steps.");
    }
  }
  return url;
}

function safeSelector(selector) {
  if (typeof selector !== "string" || !selector.trim() || selector.length > 300) {
    throw new Error("Each step requires a CSS selector of at most 300 characters.");
  }
  if (/password|passwd|credit.?card|card.?number|cvv|cvc|billing|payment|checkout|delete|logout|sign.?out|admin/i.test(selector)) {
    throw new Error("This selector targets a protected account, payment, or destructive control.");
  }
  return selector;
}

function timeoutFor(step) {
  const value = Number(step.timeoutMs);
  return Number.isInteger(value) ? Math.max(1000, Math.min(value, 45000)) : DEFAULT_TIMEOUT;
}

async function pageState(page) {
  return page.evaluate(() => {
    const txt = node => (node?.innerText || node?.textContent || "").trim();
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 6500),
      inputs: [...document.querySelectorAll("input, textarea, select, [contenteditable='true']")]
        .filter(node => {
          const r = node.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 35)
        .map(node => ({
          tag: node.tagName.toLowerCase(),
          type: node.getAttribute("type") || "",
          id: node.id || "",
          name: node.getAttribute("name") || "",
          placeholder: node.getAttribute("placeholder") || "",
          aria: node.getAttribute("aria-label") || "",
          valueLength: typeof node.value === "string" ? node.value.length : 0,
          disabled: Boolean(node.disabled),
        })),
      buttons: [...document.querySelectorAll("button")]
        .filter(node => {
          const r = node.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 70)
        .map(node => ({
          text: txt(node).slice(0, 120),
          aria: node.getAttribute("aria-label") || "",
          disabled: Boolean(node.disabled),
        })),
      videos: [...document.querySelectorAll("video")].slice(0, 12).map(node => ({
        src: node.currentSrc || node.src || "",
        readyState: node.readyState,
        duration: Number.isFinite(node.duration) ? node.duration : null,
      })),
      downloadLinks: [...document.querySelectorAll("a[href]")]
        .filter(node => /download|\.mp4|\.webm/i.test(txt(node) + " " + node.href))
        .slice(0, 20)
        .map(node => ({ text: txt(node).slice(0, 100), href: node.href })),
      verification: {
        cloudflareChallenge: document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]').length > 0,
        turnstileResponsePresent: [...document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')]
          .some(node => Boolean((node.value || "").trim())),
      },
    };
  });
}

async function saveVideoFromPage(page, step, taskId, index) {
  const selector = step.selector ? safeSelector(step.selector) : "video";
  const source = await page.locator(selector).first().evaluate(node => {
    if (node.tagName.toLowerCase() === "video") return node.currentSrc || node.src || "";
    return node.getAttribute("src") || node.href || "";
  });
  if (!source) throw new Error("No video source was found in the selected page element.");

  let buffer;
  let contentType = "";
  if (source.startsWith("blob:") || source.startsWith("data:")) {
    const data = await page.evaluate(async src => {
      const response = await fetch(src);
      const blob = await response.blob();
      if (blob.size > 80 * 1024 * 1024) throw new Error("Video exceeds the 80 MB download limit.");
      return {
        type: blob.type || "",
        base64: await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = () => reject(new Error("Could not read the video blob."));
          reader.readAsDataURL(blob);
        }),
      };
    }, source);
    buffer = Buffer.from(data.base64, "base64");
    contentType = data.type;
  } else {
    const target = new URL(source, page.url());
    if (target.protocol !== "https:") throw new Error("Only HTTPS video downloads are allowed.");
    const response = await page.request.get(target.href, { timeout: 45000 });
    if (!response.ok()) throw new Error("Video download returned HTTP " + response.status() + ".");
    const length = Number(response.headers()["content-length"] || 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new Error("Video exceeds the 80 MB download limit.");
    buffer = await response.body();
    contentType = response.headers()["content-type"] || "";
  }
  if (!buffer?.length || buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new Error("Video is empty or exceeds the 80 MB download limit.");
  }
  const ext = /webm/i.test(contentType) || /\.webm(?:$|\?)/i.test(source) ? ".webm" : ".mp4";
  const name = safeFileName(step.fileName, taskId + "-" + index + ext);
  const filePath = path.join(OUTPUT, name);
  await fs.writeFile(filePath, buffer);
  return { name, bytes: buffer.length, contentType };
}

async function performStep(page, context, task, step, index, downloads) {
  if (!step || typeof step !== "object" || typeof step.type !== "string") {
    throw new Error("Malformed step at index " + index + ".");
  }
  const timeout = timeoutFor(step);
  let detail = {};

  if (step.type === "inspect") {
    detail.state = await pageState(page);
  } else if (step.type === "navigate") {
    const target = validateUrl(step.url, page.url());
    const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout });
    detail.navigation = { url: page.url(), httpStatus: response?.status() ?? null };
  } else if (step.type === "screenshot") {
    const name = safeFileName(step.fileName, task.taskId + "-" + index + ".png");
    const filePath = path.join(OUTPUT, name.endsWith(".png") ? name : name + ".png");
    await page.screenshot({ path: filePath, fullPage: Boolean(step.fullPage) });
    detail.file = path.basename(filePath);
  } else if (step.type === "wait") {
    if (step.selector) {
      const selector = safeSelector(step.selector);
      await page.locator(selector).first().waitFor({ state: "visible", timeout });
      detail.waitedFor = selector;
    } else if (typeof step.text === "string" && step.text.length <= 250) {
      await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout });
      detail.waitedForText = step.text;
    } else {
      await page.waitForTimeout(Math.max(250, Math.min(Number(step.milliseconds) || 1000, 10000)));
    }
  } else if (step.type === "fill") {
    const selector = safeSelector(step.selector);
    if (typeof step.value !== "string" || step.value.length > MAX_TEXT) {
      throw new Error("fill value must be text of at most 5000 characters.");
    }
    const locator = page.locator(selector).first();
    const meta = await locator.evaluate(node => ({
      tag: node.tagName.toLowerCase(),
      type: (node.getAttribute("type") || "").toLowerCase(),
      name: (node.getAttribute("name") || "").toLowerCase(),
      id: (node.id || "").toLowerCase(),
      placeholder: (node.getAttribute("placeholder") || "").toLowerCase(),
      editable: node.getAttribute("contenteditable") === "true",
    }));
    if (!["textarea", "input"].includes(meta.tag) && !meta.editable) {
      throw new Error("fill is restricted to text inputs, textareas, and contenteditable fields.");
    }
    if (["password", "email", "tel", "hidden"].includes(meta.type) ||
        /pass|email|phone|card|billing|payment|secret|token/i.test(meta.name + " " + meta.id + " " + meta.placeholder)) {
      throw new Error("Credential and payment fields cannot be filled.");
    }
    await locator.fill(step.value, { timeout });
    detail.filled = selector;
    detail.valueLength = step.value.length;
  } else if (step.type === "select") {
    const selector = safeSelector(step.selector);
    if (typeof step.value !== "string" || step.value.length > 150) {
      throw new Error("select value must be text of at most 150 characters.");
    }
    await page.locator(selector).first().selectOption(step.value, { timeout });
    detail.selected = selector;
  } else if (step.type === "click") {
    const selector = safeSelector(step.selector);
    const locator = page.locator(selector).first();
    const label = await locator.evaluate(node => (
      (node.innerText || node.textContent || "") + " " +
      (node.getAttribute("aria-label") || "") + " " +
      (node.getAttribute("title") || "")
    ).trim().slice(0, 250));
    if (/login|log in|sign in|password|checkout|payment|purchase|buy credits|subscribe|upgrade|delete account|sign out|logout/i.test(label)) {
      throw new Error("This action requires login, payment, subscription, or a destructive account change and is blocked.");
    }
    if (/generate|create video|render video/i.test(label) && task.allowFreeGeneration !== true) {
      throw new Error("Video generation is disabled unless allowFreeGeneration is explicitly true for this task.");
    }
    if (/generate|create video|render video/i.test(label) && task.allowFreeGeneration === true) {
      const pageText = (await page.locator("body").innerText({ timeout })).toLowerCase();
      const explicitZeroCost = /(?:cost|price|تكلفة|السعر)\\s*[:：]?\\s*(?:0|0\\.00|\\$0|€0|£0)(?:\\b|\\s|$)/i.test(pageText) ||
        /(?:0|0\\.00)\\s*(?:credits?|coins?|tokens?|رصيد|اعتمادات)/i.test(pageText);
      const explicitlyFree = /\\bfree\\b|مجاني/i.test(label + " " + pageText);
      if (!explicitZeroCost && !explicitlyFree) {
        throw new Error("No explicit zero-cost or free indicator is visible beside the generation flow; submission is blocked.");
      }
      if (/not enough credits|buy credits|payment required|subscribe to generate|upgrade to generate|daily limit reached|credits required|لا يوجد رصيد كاف|اشتر رصيد/.test(pageText)) {
        throw new Error("The site indicates that generation requires credits, payment, or an upgrade; no generation was submitted.");
      }
    }
    await locator.click({ timeout });
    detail.clicked = selector;
    detail.label = label;
  } else if (step.type === "clickIfVisible") {
    const selector = safeSelector(step.selector);
    const locator = page.locator(selector).first();
    const count = await locator.count();
    const visible = count > 0 && await locator.isVisible().catch(() => false);
    if (!visible) {
      detail.skipped = "not-visible";
    } else {
      const label = await locator.evaluate(node => (
        (node.innerText || node.textContent || "") + " " +
        (node.getAttribute("aria-label") || "") + " " +
        (node.getAttribute("title") || "")
      ).trim().slice(0, 250));
      if (/login|log in|sign in|password|checkout|payment|purchase|buy credits|subscribe|upgrade|delete account|sign out|logout/i.test(label)) {
        throw new Error("This action requires login, payment, subscription, or a destructive account change and is blocked.");
      }
      await locator.click({ timeout });
      detail.clicked = selector;
      detail.label = label;
    }
  } else if (step.type === "upload") {
    const selector = safeSelector(step.selector);
    if (typeof step.fileBase64 !== "string" || step.fileBase64.length < 16 ||
        step.fileBase64.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 16) {
      throw new Error("upload requires fileBase64 for a file no larger than 10 MB.");
    }
    const fileName = safeFileName(step.fileName, "jvb-reference.png");
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = UPLOAD_MIME.get(ext);
    if (!mimeType) throw new Error("Unsupported upload type. Use PNG, JPG, WEBP, MP4, WEBM, MP3, or WAV.");
    const buffer = Buffer.from(step.fileBase64, "base64");
    if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) {
      throw new Error("Uploaded file is empty or exceeds the 10 MB limit.");
    }
    const locator = page.locator(selector).first();
    const inputMeta = await locator.evaluate(node => ({
      tag: node.tagName.toLowerCase(),
      type: (node.getAttribute("type") || "").toLowerCase(),
      accept: node.getAttribute("accept") || "",
    }));
    if (inputMeta.tag !== "input" || inputMeta.type !== "file") {
      throw new Error("upload can target only an input[type=file] element.");
    }
    if (inputMeta.accept && !inputMeta.accept.includes("*") &&
        !inputMeta.accept.split(",").some(value => value.trim().startsWith(ext) || value.trim() === mimeType)) {
      throw new Error("The selected file type is not accepted by this upload control.");
    }
    await locator.setInputFiles({ name: fileName, mimeType, buffer }, { timeout });
    detail.uploaded = { fileName, bytes: buffer.length, mimeType };
  } else if (step.type === "download") {
    const selector = safeSelector(step.selector);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout }),
      page.locator(selector).first().click({ timeout }),
    ]);
    const name = safeFileName(download.suggestedFilename(), task.taskId + "-" + index + ".bin");
    const filePath = path.join(OUTPUT, name);
    await download.saveAs(filePath);
    const info = await fs.stat(filePath);
    if (info.size > MAX_DOWNLOAD_BYTES) {
      await fs.unlink(filePath).catch(() => {});
      throw new Error("Downloaded file exceeds the 80 MB limit.");
    }
    const item = { name, bytes: info.size };
    downloads.push(item);
    detail.download = item;
  } else if (step.type === "saveVideo") {
    const item = await saveVideoFromPage(page, step, task.taskId, index);
    downloads.push(item);
    detail.video = item;
  } else {
    throw new Error("Unsupported step type: " + step.type);
  }

  const current = validateUrl(page.url());
  return {
    index,
    type: step.type,
    detail,
    page: { url: current.href, title: await page.title().catch(() => "") },
  };
}

await fs.mkdir(RESULTS, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
const files = (await fs.readdir(INBOX).catch(() => []))
  .filter(name => name.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.log("No queued JVB tasks.");
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const file of files) {
    const taskPath = path.join(INBOX, file);
    let taskId = path.basename(file, ".json");
    let report;

    try {
      const task = JSON.parse(await fs.readFile(taskPath, "utf8"));
      taskId = task.taskId;
      if (!safeId(taskId)) throw new Error("Invalid taskId.");
      const finalResultPath = path.join(RESULTS, taskId + ".json");
      try {
        await fs.access(finalResultPath);
        console.log("Skipping completed task " + taskId);
        continue;
      } catch {}

      const url = validateTask(task);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(DEFAULT_TIMEOUT);
      await context.route("**/*", async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
          try {
            const target = new URL(request.url());
            if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
              return route.abort();
            }
          } catch {
            return route.abort();
          }
        }
        return route.continue();
      });
      context.on("page", popup => {
        if (popup !== page) void popup.close().catch(() => {});
      });

      const network = [];
      page.on("response", response => {
        if (/api|generate|video|task|queue|render|turnstile/i.test(response.url())) {
          network.push({
            url: response.url().split("?")[0].slice(0, 250),
            method: response.request().method(),
            status: response.status(),
          });
        }
      });

      try {
        const response = await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        await page.waitForTimeout(1200);
        const steps = [];
        const downloads = [];

        if (task.operation === "sequence") {
          for (let i = 0; i < task.steps.length; i++) {
            const stepResult = await performStep(page, context, task, task.steps[i], i, downloads);
            steps.push(stepResult);
          }
        }

        const state = await pageState(page);
        report = {
          taskId,
          ok: true,
          operation: task.operation,
          url: url.href,
          httpStatus: response?.status() ?? null,
          state,
          steps,
          downloads,
          network: network.slice(-35),
          completedAt: new Date().toISOString(),
          note: "Navigation is limited to Pavo AI and LoreMotion. Login, passwords, payments, subscriptions, destructive account changes, and Cloudflare bypasses are blocked. Free generation requires an explicit task flag and a visible Free-labeled button.",
        };
        await fs.writeFile(finalResultPath, JSON.stringify(report, null, 2) + "\n");
        console.log("Completed " + taskId + ": " + state.title);
      } finally {
        await context.close();
      }
    } catch (error) {
      report = {
        taskId,
        ok: false,
        error: String(error?.message ?? error).slice(0, 1000),
        completedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(RESULTS, taskId + ".json"), JSON.stringify(report, null, 2) + "\n");
      console.error("Task " + taskId + " failed: " + report.error);
    }
  }
} finally {
  await browser.close();
}
