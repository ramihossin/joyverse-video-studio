const { test, expect } = require("@playwright/test");

test("published JoyVerse Studio loads backend controls", async ({ page }) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  expect(response.status()).toBeLessThan(400);
  await expect(page).toHaveTitle(/JoyVerse Scene Studio/);
  await expect(page.getByRole("heading", { name: "JoyVerse Scene Studio" })).toBeVisible();
  await expect(page.locator("#prompt")).toBeVisible();
  await expect(page.locator("#bridge-url")).toHaveValue("https://joyverse-mcp-bridge.onrender.com");
  await expect(page.locator("#start-queue")).toBeDisabled();
  await expect(page.locator("#aspect")).toHaveValue("portrait");
});

test("scene queue accepts and persists a scene without submitting it", async ({ page }) => {
  await page.goto("/");
  await page.locator("#scene-title").fill("Automation smoke test");
  await page.locator("#prompt").fill("A safe test scene description. Do not submit to a video provider.");
  await page.locator("#consent").check();
  await page.locator("#studio-form button[type=submit]").click();
  await expect(page.locator("#scene-list")).toContainText("Automation smoke test");
  await expect(page.locator("#scene-list")).toContainText("بانتظار الدور");
  await expect(page.locator("#start-queue")).toBeEnabled();
  await page.locator("#aspect").selectOption("landscape");
  await page.reload();
  await expect(page.locator("#scene-list")).toContainText("Automation smoke test");
});

test("agent manifest import adds scenes without starting generation", async ({ page }) => {
  await page.goto("/");
  const manifest = { schema: "joyverse-scene-manifest", version: 1,
    scenes: [{ title: "Agent scene", prompt: "A friendly bear waves in a sunny garden." }] };
  await page.locator("#manifest-file").setInputFiles({
    name: "joyverse-scenes.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(manifest))
  });
  await expect(page.locator("#scene-list")).toContainText("Agent scene");
  await expect(page.locator("#scene-list")).toContainText("بانتظار الدور");
});

test("agent manifest export downloads reusable JSON", async ({ page }) => {
  await page.goto("/");
  await page.locator("#scene-title").fill("Export scene");
  await page.locator("#prompt").fill("A friendly bear waves.");
  await page.locator("#consent").check();
  await page.locator("#studio-form button[type=submit]").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-manifest").click();
  expect((await downloadPromise).suggestedFilename()).toBe("joyverse-scene-manifest.json");
});

test("server assembly stays disabled until a completed server clip exists", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#assemble-scenes")).toBeDisabled();
});

test("server assembly is enabled for a completed server-backed clip", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("joyverse-scene-queue-v2", JSON.stringify([
      { id: "a", title: "Clip A", prompt: "A", status: "done",
        serverTaskId: "hermes_123e4567-e89b-12d3-a456-426614174000" }
    ]));
  });
  await page.goto("/");
  await expect(page.locator("#scene-list")).toContainText("Clip A");
  await expect(page.locator("#assemble-scenes")).toBeEnabled();
  await expect(page.locator("#start-queue")).toBeDisabled();
});

test("reference image is persisted in IndexedDB with its queued scene", async ({ page }) => {
  await page.goto("/");
  await page.locator("#scene-title").fill("Reference scene");
  await page.locator("#prompt").fill("A friendly dragon waves.");
  await page.locator("#consent").check();
  await page.locator("#image").setInputFiles({
    name: "reference.png", mimeType: "image/png",
    buffer: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])
  });
  await page.locator("#studio-form button[type=submit]").click();
  await expect(page.locator("#scene-list")).toContainText("Reference scene");
  await expect(page.locator("#scene-list")).toContainText("صورة مرجعية مرفقة");
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
  expect(storedCount).toBe(1);
});

test("vendored FFmpeg wrapper modules remain available", async ({ page }) => {
  await page.goto("/");
  const moduleType = await page.evaluate(async () => {
    const { FFmpeg } = await import("/vendor/ffmpeg/esm/index.js");
    return typeof FFmpeg;
  });
  expect(moduleType).toBe("function");
  for (const path of ["/vendor/ffmpeg/esm/classes.js", "/vendor/ffmpeg/esm/const.js",
    "/vendor/ffmpeg/esm/errors.js", "/vendor/ffmpeg/esm/types.js",
    "/vendor/ffmpeg/esm/utils.js", "/vendor/ffmpeg/esm/worker.js"]) {
    expect(await page.evaluate(async assetPath => (await fetch(assetPath)).status, path)).toBe(200);
  }
});


test("Studio dispatches a reference-backed server task, assembles it, and restores after reload", async ({ page }) => {
  let dispatchPayload = null;
  let assemblyPayload = null;
  const taskId = "hermes_123e4567-e89b-12d3-a456-426614174000";
  const finalId = "123e4567-e89b-12d3-a456-426614174001";

  await page.route("https://bridge.test/api/hermes/reference-upload", async route => {
    expect(route.request().headers().authorization).toBe("Bearer studio-test-token-with-32-characters");
    await route.fulfill({ status: 201, contentType: "application/json",
      body: JSON.stringify({ reference_image_key: "references/pending/123e4567-e89b-12d3-a456-426614174002.png" }) });
  });
  await page.route("https://bridge.test/api/hermes/dispatch", async route => {
    dispatchPayload = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json",
      body: JSON.stringify({ accepted: true, task_id: taskId, status: "queued" }) });
  });
  await page.route("https://bridge.test/api/hermes/tasks/" + taskId, async route => {
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ task_id: taskId, status: "completed", storage_key: "jobs/task/scene.mp4", result: { storage_key: "jobs/task/scene.mp4" } }) });
  });
  await page.route("https://bridge.test/api/hermes/assemble", async route => {
    assemblyPayload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json",
      body: JSON.stringify({ status: "completed", final_id: finalId, scene_count: 1 }) });
  });
  await page.route("https://bridge.test/api/hermes/final/" + finalId, async route => {
    await route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.from("fake-mp4-final") });
  });

  await page.goto("/");
  await page.locator("#bridge-url").fill("https://bridge.test");
  await page.locator("#studio-token").fill("studio-test-token-with-32-characters");
  await page.locator("#scene-title").fill("Cloud scene");
  await page.locator("#prompt").fill("A friendly dragon waves.");
  await page.locator("#consent").check();
  await page.locator("#image").setInputFiles({
    name: "reference.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p7sAAAAASUVORK5CYII=", "base64")
  });
  await page.locator("#studio-form button[type=submit]").click();
  await expect(page.locator("#scene-list")).toContainText("Cloud scene");
  await page.locator("#start-queue").click();
  await expect(page.locator("#scene-list")).toContainText("مكتمل ومحفوظ سحابياً");
  expect(dispatchPayload).not.toBeNull();
  expect(dispatchPayload.reference_image_key).toMatch(/^references\/pending\//);
  expect(dispatchPayload.toolsets).toEqual(["video_gen"]);
  await expect(page.locator("#assemble-scenes")).toBeEnabled();
  await page.locator("#assemble-scenes").click();
  await expect(page.locator("#assembly-box")).toBeVisible();
  expect(assemblyPayload.task_ids).toEqual([taskId]);

  await page.reload();
  await expect(page.locator("#assembly-box")).toBeVisible();
  await expect(page.locator("#scene-list")).toContainText("مكتمل ومحفوظ سحابياً");
});
