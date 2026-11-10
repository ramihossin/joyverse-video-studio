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
