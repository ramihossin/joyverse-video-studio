import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const INBOX = path.resolve("jvb-agent/inbox");
const RESULTS = path.resolve("jvb-agent/results");
const ALLOWED_HOSTS = new Set([
  "pavoai.app",
  "www.pavoai.app",
  "loremotion.com",
  "www.loremotion.com",
  "theresanaiforthat.com",
  "www.theresanaiforthat.com",
]);

function safeId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,80}$/.test(value);
}

function validateTask(task) {
  if (!task || task.operation !== "inspect") {
    throw new Error("Only the read-only inspect operation is enabled.");
  }
  if (!safeId(task.taskId)) {
    throw new Error("taskId must contain 3-80 letters, digits, underscores, or hyphens.");
  }
  const url = new URL(task.url);
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error("URL is outside the JVB video-site allowlist.");
  }
  return url;
}

await fs.mkdir(RESULTS, { recursive: true });
const files = (await fs.readdir(INBOX).catch(() => []))
  .filter((name) => name.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.log("No queued JVB inspection tasks.");
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const file of files) {
    const taskPath = path.join(INBOX, file);
    let task;
    let taskId = path.basename(file, ".json");
    const resultPath = path.join(RESULTS, `${taskId}.json`);

    try {
      task = JSON.parse(await fs.readFile(taskPath, "utf8"));
      taskId = task.taskId;
      if (!safeId(taskId)) throw new Error("Invalid taskId.");
      const finalResultPath = path.join(RESULTS, `${taskId}.json`);
      try {
        await fs.access(finalResultPath);
        console.log(`Skipping completed task ${taskId}`);
        continue;
      } catch {}

      const url = validateTask(task);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      let response;
      let pageTitle = "";
      let textPreview = "";
      try {
        response = await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
        await page.waitForTimeout(1500);
        pageTitle = await page.title();
        textPreview = (await page.locator("body").innerText({ timeout: 10000 }).catch(() => ""))
          .replace(/\s+/g, " ")
          .slice(0, 1800);
      } finally {
        await context.close();
      }

      const result = {
        taskId,
        ok: true,
        operation: "inspect",
        url: url.href,
        httpStatus: response?.status() ?? null,
        title: pageTitle,
        textPreview,
        completedAt: new Date().toISOString(),
        note: "Read-only inspection. No login, form submission, payment, or account changes were attempted.",
      };
      await fs.writeFile(finalResultPath, JSON.stringify(result, null, 2) + "\n");
      console.log(`Completed ${taskId}: ${pageTitle}`);
    } catch (error) {
      const failure = {
        taskId,
        ok: false,
        error: String(error?.message ?? error).slice(0, 500),
        completedAt: new Date().toISOString(),
      };
      await fs.writeFile(resultPath, JSON.stringify(failure, null, 2) + "\n");
      console.error(`Task ${taskId} failed: ${failure.error}`);
    }
  }
} finally {
  await browser.close();
}
