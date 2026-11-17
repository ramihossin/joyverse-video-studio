import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"]
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
