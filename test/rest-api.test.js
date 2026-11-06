import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const TOKEN = "test-only-token-with-at-least-32-characters";
let child;
let baseUrl;

before(async () => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["bridge/server.js"], {
    env: { ...process.env, PORT: String(port), MCP_ACCESS_TOKEN: TOKEN },
    stdio: "ignore"
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error("Bridge process exited before becoming ready");
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "bridge should become healthy");
});

after(() => {
  if (child && child.exitCode === null) child.kill("SIGTERM");
});

test("REST status rejects missing bearer token", async () => {
  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 401);
});

test("REST command rejects missing bearer token", async () => {
  const response = await fetch(`${baseUrl}/api/command`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "stop", webhook_url: "https://trigger.macrodroid.com/abcdefgh/identifier" })
  });
  assert.equal(response.status, 401);
});

test("REST command rejects malformed webhook URLs", async () => {
  const response = await fetch(`${baseUrl}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "stop", webhook_url: "https://example.com/not-a-webhook" })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_webhook_url" });
});

test("REST command requires a prompt for scene submission", async () => {
  const response = await fetch(`${baseUrl}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "submit_scene", webhook_url: "https://trigger.macrodroid.com/abcdefgh/identifier" })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "prompt_required" });
});

test("root serves the Arabic status dashboard without exposing the access token", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const html = await response.text();
  assert.match(html, /lang="ar"/);
  assert.match(html, /لوحة حالة JoyVerse/);
  assert.match(html, /Authorization/);
  assert.doesNotMatch(html, new RegExp(TOKEN));
});

test("health endpoint remains available and reports runtime metadata", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, "joyverse-macrodroid-bridge");
  assert.equal(typeof health.uptime_seconds, "number");
  assert.equal(typeof health.timestamp, "string");
});

test("authenticated status reports real service metadata without exposing secrets", async () => {
  const response = await fetch(`${baseUrl}/api/status`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const status = await response.json();
  assert.equal(status.service.status, "running");
  assert.equal(status.rest_api.status, "authenticated");
  assert.equal(status.mcp.configured, true);
  assert.equal(status.mcp.connectivity_probe, "not_performed");
  assert.equal(status.last_command, null);
  assert.equal(status.last_device_result, null);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
});
