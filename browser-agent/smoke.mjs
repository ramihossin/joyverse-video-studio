import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const out = "browser-agent-output";
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
const evidence = {
  startedAt: new Date().toISOString(),
  browser: "Playwright + Chromium on GitHub-hosted Linux runner",
  steps: []
};

try {
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  const firstTitle = await page.title();
  const link = page.getByRole("link", { name: /more information/i });
  await link.click({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  evidence.steps.push({
    action: "navigate + click",
    from: "https://example.com",
    titleBeforeClick: firstTitle,
    urlAfterClick: page.url(),
    titleAfterClick: await page.title()
  });

  await page.goto("https://utilmesh.com/tools/free-ai-video-generator", {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });
  await page.waitForTimeout(2500);
  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").slice(0, 12000),
    buttons: [...document.querySelectorAll("button")].map(x => ({
      text: (x.innerText || x.getAttribute("aria-label") || "").trim().slice(0, 160),
      disabled: x.disabled
    })).slice(0, 60),
    inputs: [...document.querySelectorAll("input,textarea,select")].map(x => ({
      tag: x.tagName.toLowerCase(),
      type: x.getAttribute("type"),
      placeholder: x.getAttribute("placeholder"),
      ariaLabel: x.getAttribute("aria-label"),
      accept: x.getAttribute("accept")
    })).slice(0, 60)
  }));
  evidence.steps.push({ action: "inspect target generator page", ...pageInfo });
  await page.screenshot({ path: `${out}/utilmesh-generator.png`, fullPage: true });
  await writeFile(`${out}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    success: true,
    clickedLink: evidence.steps[0],
    targetTitle: pageInfo.title,
    targetUrl: pageInfo.url,
    visibleButtons: pageInfo.buttons.length,
    formFields: pageInfo.inputs.length,
    screenshot: `${out}/utilmesh-generator.png`
  }, null, 2));
} catch (error) {
  evidence.error = String(error?.stack || error);
  await writeFile(`${out}/browser-evidence.json`, JSON.stringify(evidence, null, 2));
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
