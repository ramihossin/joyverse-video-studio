import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const out = "browser-agent-output";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage({ viewport: { width: 1365, height: 900 } });
const responses = [];
const failures = [];
const errors = [];

page.on("response", async response => {
  if (!/api|generate|video|task/i.test(response.url())) return;
  let body = "";
  try { body = (await response.text()).slice(0, 2500); } catch {}
  responses.push({ url: response.url(), status: response.status(), method: response.request().method(), body });
});
page.on("requestfailed", request => failures.push({url:request.url(), error:request.failure()?.errorText || ""}));
page.on("pageerror", error => errors.push(String(error?.stack || error)));
page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });

try {
  await page.goto("https://freegen.video/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  const details = await page.evaluate(() => {
    const describe = el => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
      id: el.id || null,
      role: el.getAttribute("role"),
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      text: (el.innerText || el.textContent || "").trim().slice(0, 180),
      value: "value" in el ? el.value : null,
      disabled: "disabled" in el ? el.disabled : null,
      options: el.tagName === "SELECT" ? [...el.options].map(o => ({value:o.value,text:(o.textContent||"").trim()})) : undefined
    });
    return {
      title: document.title,
      url: location.href,
      visibleText: (document.body?.innerText || "").slice(0, 6500),
      controls: [...document.querySelectorAll("input,textarea,select,button,[role=button],[role=radio],[role=tab]")].map(describe),
      forms: [...document.forms].map(f => ({action:f.action,method:f.method,controls:f.elements.length}))
    };
  });
  await page.screenshot({ path: `${out}/freegen-inspection.png`, fullPage: true });
  const evidence = {
    site: "https://freegen.video/",
    inspectedAt: new Date().toISOString(),
    browser: "Playwright + Chromium on GitHub-hosted Linux runner",
    details, responses, failures, errors
  };
  await writeFile(`${out}/freegen-inspection.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({title:details.title, url:details.url, controls:details.controls, forms:details.forms, errors, failures}, null, 2));
} catch (error) {
  await writeFile(`${out}/freegen-inspection-error.txt`, String(error?.stack || error));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
