import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  timeout: 30000,
  args: [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--no-first-run",
    "--metrics-recording-only",
    "--renderer-process-limit=2",
    "--disable-features=BackForwardCache,MediaRouter,OptimizationHints"
  ]
});
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>JoyVerse Browser Agent Smoke Test</title><main>ready</main>");
  assert.equal(await page.title(), "JoyVerse Browser Agent Smoke Test");
  assert.equal(await page.locator("main").innerText(), "ready");
  process.stdout.write("Chromium sandbox smoke test passed.\n");
} finally {
  await browser.close();
}
