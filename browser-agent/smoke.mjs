import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const out = "browser-agent-output";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage({ viewport: { width: 1365, height: 900 } });
const networkResponses = [];
const evidence = {
  startedAt: new Date().toISOString(),
  browser: "Playwright + Chromium on GitHub-hosted Linux runner",
  target: "https://utilmesh.com/tools/free-ai-video-generator",
  prompt: "A small orange cat walks across a rainy neon street, slow tracking shot, cinematic reflections",
  steps: []
};

page.on("response", async response => {
  const request = response.request();
  if (request.method() !== "POST" && !/api|generate|video|task/i.test(response.url())) return;
  let responseBody = "";
  try { responseBody = (await response.text()).slice(0, 1600); } catch {}
  networkResponses.push({ url: response.url(), method: request.method(), status: response.status(), contentType: response.headers()["content-type"] || "", requestBody: request.postData() || "", body: responseBody });
});

try {
  await page.goto(evidence.target, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);

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
  await selects.nth(0).selectOption({ label: "Landscape 16:9" });
  await selects.nth(1).selectOption({ label: "About 3 seconds" });

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
    await writeFile(`${out}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ success: true, result: evidence.result, downloadedFile: evidence.downloadedFile, lastState }, null, 2));
  }
} catch (error) {
  evidence.error = String(error?.stack || error);
  evidence.networkResponses = networkResponses;
  await page.screenshot({ path: `${out}/generation-error.png`, fullPage: true }).catch(() => {});
  await writeFile(`${out}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
