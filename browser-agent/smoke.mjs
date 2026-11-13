import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const out = "browser-agent-output";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage({ viewport: { width: 1365, height: 900 } });
const networkResponses = [];
const networkFailures = [];
const requestMetadata = [];
const evidence = {
  startedAt: new Date().toISOString(),
  browser: "Playwright + Chromium on GitHub-hosted Linux runner",
  target: "https://utilmesh.com/tools/free-ai-video-generator",
  prompt: "A red ball bounces once on a white floor.",
  steps: []
};

page.on("request", async request => {
  if (request.method() !== "POST" && !/api|generate|video|task/i.test(request.url())) return;
  let headers = {};
  try { headers = await request.allHeaders(); } catch {}
  const allowedHeaders = ["accept", "content-type", "origin", "referer", "sec-fetch-site", "sec-fetch-mode", "user-agent"];
  requestMetadata.push({
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    headers: Object.fromEntries(allowedHeaders.filter(k => headers[k]).map(k => [k, headers[k]])),
    body: request.postData() || ""
  });
});
page.on("requestfailed", request => {
  networkFailures.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText || "unknown" });
});
page.on("response", async response => {
  const request = response.request();
  if (request.method() !== "POST" && !/api|generate|video|task/i.test(response.url())) return;
  let responseBody = "";
  let headers = {};
  try { responseBody = (await response.text()).slice(0, 2500); } catch {}
  try { headers = await response.allHeaders(); } catch {}
  networkResponses.push({
    url: response.url(), method: request.method(), status: response.status(),
    contentType: headers["content-type"] || "",
    retryAfter: headers["retry-after"] || null,
    server: headers["server"] || null,
    cfRay: headers["cf-ray"] || null,
    requestBody: request.postData() || "",
    body: responseBody
  });
});

try {
  await page.goto(evidence.target, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  evidence.browserRuntime = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    online: navigator.onLine,
    visibilityState: document.visibilityState,
    loadedScriptUrls: [...document.scripts].map(s => s.src).filter(Boolean)
  }));

  // Inspect only the publicly loaded same-origin page bundles for the documented
  // client request contract. This is diagnostic; it does not call private endpoints.
  evidence.clientBundleFindings = await page.evaluate(async () => {
    const urls = [...document.scripts].map(s => s.src).filter(src => {
      try { return new URL(src).origin === location.origin && src.includes("/_next/static/chunks/"); }
      catch { return false; }
    });
    const findings = [];
    for (const url of urls) {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) continue;
        const source = await response.text();
        for (const needle of ["/api/ai-media/video", "generation request was not accepted"]) {
          const at = source.indexOf(needle);
          if (at >= 0) findings.push({ url, needle, excerpt: source.slice(Math.max(0, at - 900), Math.min(source.length, at + 1600)) });
        }
      } catch {}
    }
    return findings.slice(0, 8);
  });

  const consent = page.getByRole("button", { name: /got it/i });
  if (await consent.isVisible().catch(() => false)) {
    await consent.click();
    evidence.steps.push({ action: "dismiss consent notice", result: "clicked Got it" });
  }

  const formInfo = await page.locator("select").evaluateAll(selects =>
    selects.map(s => [...s.options].map(o => ({ value: o.value, text: (o.textContent || "").trim() })))
  );
  evidence.steps.push({ action: "inspect generation options", selects: formInfo });

  await page.locator("textarea").first().fill(evidence.prompt);
  const selects = page.locator("select");
  await selects.nth(0).selectOption("16:9");
  await selects.nth(1).selectOption("5");
  await page.waitForFunction(() => {
    const s = [...document.querySelectorAll("select")];
    return s.length >= 2 && s[0].value === "16:9" && s[1].value === "5";
  }, { timeout: 10000 });
  evidence.selectedValues = await selects.evaluateAll(s => s.map(x => x.value));
  if (evidence.selectedValues[0] !== "16:9" || evidence.selectedValues[1] !== "5") {
    throw new Error("UI selection state mismatch: " + JSON.stringify(evidence.selectedValues));
  }
  await page.waitForTimeout(800);

  const generate = page.getByRole("button", { name: /generate free video/i });
  await generate.click();
  evidence.steps.push({ action: "submit free video generation", result: "clicked Generate free video" });
  await writeFile(`${out}/generation-started.json`, JSON.stringify(evidence, null, 2));

  const deadline = Date.now() + 150000;
  let ready = false;
  let rejection = null;
  let lastState = {};
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    lastState = await page.evaluate(() => {
      const video = document.querySelector("video");
      const download = [...document.querySelectorAll("button,a")].find(x =>
        /download mp4/i.test((x.innerText || x.getAttribute("aria-label") || "").trim())
      );
      return {
        title: document.title,
        bodyText: (document.body?.innerText || "").slice(0, 5000),
        videoSrc: video?.currentSrc || video?.src || video?.querySelector("source")?.src || null,
        videoReadyState: video?.readyState ?? null,
        downloadText: download ? (download.innerText || download.getAttribute("aria-label") || "").trim() : null,
        downloadDisabled: download && "disabled" in download ? download.disabled : null,
        downloadHref: download?.href || null
      };
    });
    evidence.lastObservedState = lastState;
    if (/generation request was not accepted|try a different prompt/i.test(lastState.bodyText || "")) {
      rejection = "The page displayed a generation rejection message";
      break;
    }
    if (lastState.videoSrc || (lastState.downloadText && lastState.downloadDisabled === false)) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    evidence.result = rejection || "No generated video became available within the 150-second observation window";
    evidence.networkResponses = networkResponses;
    evidence.requestMetadata = requestMetadata;
    evidence.networkFailures = networkFailures;
    await page.screenshot({ path: `${out}/generation-status.png`, fullPage: true });
    await writeFile(`${out}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ success: false, result: evidence.result, lastState }, null, 2));
    process.exitCode = 2;
  } else {
    await page.screenshot({ path: `${out}/generated-video-page.png`, fullPage: true });
    const downloadButton = page.getByRole("button", { name: /download mp4/i });
    if (await downloadButton.count()) {
      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
      await downloadButton.click();
      const download = await downloadPromise;
      await download.saveAs(`${out}/joyverse-browser-test.mp4`);
      evidence.downloadedFile = "joyverse-browser-test.mp4";
      evidence.downloadSuggestedFilename = download.suggestedFilename();
    } else if (lastState.videoSrc) {
      const response = await page.request.get(lastState.videoSrc, { timeout: 60000 });
      if (!response.ok()) throw new Error(`Video fetch failed: HTTP ${response.status()}`);
      await writeFile(`${out}/joyverse-browser-test.mp4`, await response.body());
      evidence.downloadedFile = "joyverse-browser-test.mp4";
      evidence.downloadMethod = "Playwright request from generated video URL";
    }
    evidence.result = "Video became available and download was attempted";
    evidence.networkResponses = networkResponses;
    evidence.requestMetadata = requestMetadata;
    evidence.networkFailures = networkFailures;
    await writeFile(`${out}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ success: true, result: evidence.result, downloadedFile: evidence.downloadedFile, lastState }, null, 2));
  }
} catch (error) {
  evidence.error = String(error?.stack || error);
  evidence.networkResponses = networkResponses;
  evidence.requestMetadata = requestMetadata;
  evidence.networkFailures = networkFailures;
  await page.screenshot({ path: `${out}/generation-error.png`, fullPage: true }).catch(() => {});
  await writeFile(`${out}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
