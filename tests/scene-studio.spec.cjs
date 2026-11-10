const { test, expect } = require("@playwright/test");

test("published JoyVerse Studio loads and exposes scene controls", async ({ page }) => {
  const response = await page.goto("/");
  expect(response, "The deployed site should return a response").not.toBeNull();
  expect(response.status()).toBeLessThan(400);
  await expect(page).toHaveTitle(/JoyVerse Scene Studio/);
  await expect(page.getByRole("heading", { name: "JoyVerse Scene Studio" })).toBeVisible();
  await expect(page.locator("#prompt")).toBeVisible();
  await expect(page.locator("#start-queue")).toBeDisabled();
  await expect(page.locator("#aspect")).toHaveValue("portrait");
});

test("scene queue accepts a scene, persists it, and supports YouTube landscape", async ({ page }) => {
  await page.goto("/");
  await page.locator("#scene-title").fill("Automation smoke test");
  await page.locator("#prompt").fill("A safe test scene description. Do not submit to a video provider.");
  await page.locator("#consent").check();
  await page.locator("#studio-form button[type=submit]").click();

  await expect(page.locator("#scene-list")).toContainText("Automation smoke test");
  await expect(page.locator("#scene-list")).toContainText("بانتظار الدور");
  await expect(page.locator("#start-queue")).toBeEnabled();

  await page.locator("#aspect").selectOption("landscape");
  await expect(page.locator("#aspect")).toHaveValue("landscape");

  await page.reload();
  await expect(page.locator("#scene-list")).toContainText("Automation smoke test");
});

test("agent manifest import adds scenes without starting generation", async ({ page }) => {
  await page.goto("/");
  const manifest = {
    schema: "joyverse-scene-manifest",
    version: 1,
    scenes: [{ title: "Agent scene", prompt: "A friendly bear waves in a sunny garden." }]
  };
  await page.locator("#manifest-file").setInputFiles({
    name: "joyverse-scenes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(manifest))
  });
  await expect(page.locator("#scene-list")).toContainText("Agent scene");
  await expect(page.locator("#scene-list")).toContainText("بانتظار الدور");
  await expect(page.locator("#start-queue")).toBeEnabled();
});

test("agent manifest export downloads a reusable JSON file", async ({ page }) => {
  await page.goto("/");
  await page.locator("#scene-title").fill("Export scene");
  await page.locator("#prompt").fill("A friendly bear waves.");
  await page.locator("#consent").check();
  await page.locator("#studio-form button[type=submit]").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-manifest").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("joyverse-scene-manifest.json");
});


test("local assembly stays disabled until two completed clips exist", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#assemble-scenes")).toBeDisabled();
});

test("local assembly becomes available for two completed clips without starting a render", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("joyverse-scene-queue-v1", JSON.stringify([
      { id: "a", title: "Clip A", prompt: "A", status: "done", videoUrl: "https://example.com/a.mp4" },
      { id: "b", title: "Clip B", prompt: "B", status: "done", videoUrl: "https://example.com/b.mp4" }
    ]));
  });
  await page.goto("/");
  await expect(page.locator("#scene-list")).toContainText("Clip A");
  await expect(page.locator("#scene-list")).toContainText("Clip B");
  await expect(page.locator("#assemble-scenes")).toBeEnabled();
  await expect(page.locator("#start-queue")).toBeDisabled();
});


test("vendored FFmpeg wrapper modules load from the Studio origin", async ({ page }) => {
  await page.goto("/");
  const moduleType = await page.evaluate(async () => {
    const { FFmpeg } = await import("/vendor/ffmpeg/esm/index.js");
    return typeof FFmpeg;
  });
  expect(moduleType).toBe("function");

  for (const path of [
    "/vendor/ffmpeg/esm/classes.js",
    "/vendor/ffmpeg/esm/const.js",
    "/vendor/ffmpeg/esm/errors.js",
    "/vendor/ffmpeg/esm/types.js",
    "/vendor/ffmpeg/esm/utils.js",
    "/vendor/ffmpeg/esm/worker.js"
  ]) {
    const status = await page.evaluate(async (assetPath) => (await fetch(assetPath)).status, path);
    expect(status, path + " should be served locally").toBe(200);
  }
});


test("agent manifest import accepts files larger than 1 MB", async ({ page }) => {
  await page.goto("/");
  const manifest = JSON.stringify({
    schema: "joyverse-scene-manifest",
    version: 1,
    scenes: [{ title: "Large file scene", prompt: "A friendly bear waves." }]
  });
  const padding = " ".repeat(1024 * 1024 + 128);
  const buffer = Buffer.from(manifest + padding);
  expect(buffer.byteLength).toBeGreaterThan(1024 * 1024);
  expect(buffer.byteLength).toBeLessThan(30 * 1024 * 1024);

  await page.locator("#manifest-file").setInputFiles({
    name: "joyverse-scenes-large.json",
    mimeType: "application/json",
    buffer
  });
  await expect(page.locator("#scene-list")).toContainText("Large file scene");
  await expect(page.locator("#scene-list")).toContainText("بانتظار الدور");
});


test("local video import adds phone clips to the completed queue and enables assembly", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#import-videos")).toBeVisible();
  await page.locator("#video-files").setInputFiles([
    { name: "clip-one.mp4", mimeType: "video/mp4", buffer: Buffer.from("fake-mp4-one") },
    { name: "clip-two.mp4", mimeType: "video/mp4", buffer: Buffer.from("fake-mp4-two") }
  ]);

  await expect(page.locator("#scene-list")).toContainText("clip-one");
  await expect(page.locator("#scene-list")).toContainText("clip-two");
  await expect(page.locator("#scene-list")).toContainText("فيديو محلي محفوظ على الهاتف");
  await expect(page.locator("#assemble-scenes")).toBeEnabled();

  const storedCount = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("joyverse-video-storage", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const request = db.transaction("clips", "readonly").objectStore("clips").count();
      request.onsuccess = () => { db.close(); resolve(request.result); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  });
  expect(storedCount).toBe(2);
});
