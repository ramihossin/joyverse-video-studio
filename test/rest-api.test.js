import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const TOKEN = "test-only-token-with-at-least-32-characters";
const WORKER_TOKEN = "test-worker-token-with-at-least-32-characters";
let child;
let baseUrl;

before(async () => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["bridge/server.js"], {
    env: {
      ...process.env, NODE_ENV: "test", JOYVERSE_TEST_MEMORY_STORE: "1",
      PORT: String(port), MCP_ACCESS_TOKEN: TOKEN,
      HERMES_WORKER_TOKEN: WORKER_TOKEN, MACRODROID_WEBHOOK_URL: ""
    },
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

test("REST command reports missing server-side MacroDroid webhook configuration", async () => {
  const response = await fetch(`${baseUrl}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "open_loremotion" })
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "macrodroid_webhook_not_configured" });
});

test("REST command requires a prompt for scene submission", async () => {
  const response = await fetch(`${baseUrl}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ command: "submit_scene" })
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
  assert.equal(status.mcp.macrodroid_webhook_configured, false);
  assert.equal(status.last_command, null);
  assert.equal(status.last_device_result, null);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
});


test("Hermes task survives dispatch, claim, completion, and status retrieval", async () => {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${WORKER_TOKEN}`
  };
  const dispatch = await fetch(`${baseUrl}/api/hermes/dispatch`, {
    method: "POST", headers,
    body: JSON.stringify({
      scene_id: "scene-test", prompt: "Return a test result.",
      toolsets: ["web"], confirm_video_generation: false
    })
  });
  assert.equal(dispatch.status, 202);
  const accepted = await dispatch.json();
  assert.equal(accepted.status, "queued");

  const claim = await fetch(`${baseUrl}/api/hermes/next`, { headers });
  assert.equal(claim.status, 200);
  const task = await claim.json();
  assert.equal(task.task_id, accepted.task_id);
  assert.equal(task.scene_id, "scene-test");
  assert.equal(task.stage, "queued");
  assert.equal(task.provider, null);
  assert.equal(task.provider_job_id, null);
  assert.equal(task.output_url, null);
  assert.equal(task.storage_key, null);
  assert.equal(task.attempts, 1);
  assert.equal(typeof task.claim_token, "string");
  assert.ok(task.claim_token.length >= 32);
  const claimToken = task.claim_token;

  const staleCheckpoint = await fetch(`${baseUrl}/api/hermes/checkpoint`, {
    method: "POST", headers,
    body: JSON.stringify({ task_id: accepted.task_id, claim_token: "z".repeat(36), stage: "uploading" })
  });
  assert.equal(staleCheckpoint.status, 404);
  assert.equal((await staleCheckpoint.json()).error, "task_not_found_or_not_claimed");

  const checkpoint = await fetch(`${baseUrl}/api/hermes/checkpoint`, {
    method: "POST", headers,
    body: JSON.stringify({
      task_id: accepted.task_id, claim_token: claimToken, stage: "generating",
      provider: "LTX-2.5", provider_job_id: "provider-job-test",
      output_url: "https://example.test/scene.mp4",
      storage_key: "joyverse/scenes/scene-test.mp4"
    })
  });
  assert.equal(checkpoint.status, 200);
  const savedCheckpoint = await checkpoint.json();
  assert.equal(savedCheckpoint.stage, "generating");
  assert.equal(savedCheckpoint.provider_job_id, "provider-job-test");

  const complete = await fetch(`${baseUrl}/api/hermes/result`, {
    method: "POST", headers,
    body: JSON.stringify({
      task_id: accepted.task_id, claim_token: claimToken, status: "completed",
      result: { message: "TEST_OK" }
    })
  });
  assert.equal(complete.status, 200);

  const status = await fetch(`${baseUrl}/api/hermes/tasks/${encodeURIComponent(accepted.task_id)}`, { headers });
  assert.equal(status.status, 200);
  const finalState = await status.json();
  assert.equal(finalState.status, "completed");
  assert.deepEqual(finalState.result, { message: "TEST_OK" });
  assert.equal(finalState.stage, "completed");
  assert.equal(finalState.provider, "LTX-2.5");
  assert.equal(finalState.provider_job_id, "provider-job-test");
  assert.equal(finalState.storage_key, "joyverse/scenes/scene-test.mp4");
});

test("Hermes queue rejects checkpoints and results for unclaimed tasks", async () => {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${WORKER_TOKEN}`
  };
  const dispatch = await fetch(`${baseUrl}/api/hermes/dispatch`, {
    method: "POST", headers,
    body: JSON.stringify({
      scene_id: "scene-unclaimed", prompt: "This task must be claimed first.",
      toolsets: ["web"], confirm_video_generation: false
    })
  });
  assert.equal(dispatch.status, 202);
  const accepted = await dispatch.json();

  const checkpoint = await fetch(`${baseUrl}/api/hermes/checkpoint`, {
    method: "POST", headers,
    body: JSON.stringify({ task_id: accepted.task_id, claim_token: "x".repeat(36), stage: "generating" })
  });
  assert.equal(checkpoint.status, 404);
  assert.equal((await checkpoint.json()).error, "task_not_found_or_not_claimed");

  const result = await fetch(`${baseUrl}/api/hermes/result`, {
    method: "POST", headers,
    body: JSON.stringify({
      task_id: accepted.task_id, claim_token: "x".repeat(36), status: "completed", result: { message: "must not complete" }
    })
  });
  assert.equal(result.status, 404);
  assert.equal((await result.json()).error, "task_not_found_or_not_claimed");

  const status = await fetch(`${baseUrl}/api/hermes/tasks/${encodeURIComponent(accepted.task_id)}`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).status, "queued");

  // Clean up this intentionally unclaimed task so it cannot be picked up by
  // the following test and interfere with its FIFO claim expectation.
  const claim = await fetch(`${baseUrl}/api/hermes/next`, { headers });
  assert.equal(claim.status, 200);
  const claimed = await claim.json();
  assert.equal(claimed.task_id, accepted.task_id);
  const cleanup = await fetch(`${baseUrl}/api/hermes/result`, {
    method: "POST", headers,
    body: JSON.stringify({
      task_id: accepted.task_id, claim_token: claimed.claim_token,
      status: "completed", result: { message: "test cleanup" }
    })
  });
  assert.equal(cleanup.status, 200);
});

test("Hermes queue rejects a second checkpoint after task completion", async () => {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${WORKER_TOKEN}`
  };
  const dispatch = await fetch(`${baseUrl}/api/hermes/dispatch`, {
    method: "POST", headers,
    body: JSON.stringify({
      scene_id: "scene-completed", prompt: "Complete then reject later writes.",
      toolsets: ["web"], confirm_video_generation: false
    })
  });
  assert.equal(dispatch.status, 202);
  const accepted = await dispatch.json();

  const claim = await fetch(`${baseUrl}/api/hermes/next`, { headers });
  assert.equal(claim.status, 200);
  const task = await claim.json();
  assert.equal(task.task_id, accepted.task_id);

  const complete = await fetch(`${baseUrl}/api/hermes/result`, {
    method: "POST", headers,
    body: JSON.stringify({ task_id: accepted.task_id, claim_token: task.claim_token, status: "completed", result: { ok: true } })
  });
  assert.equal(complete.status, 200);

  const lateCheckpoint = await fetch(`${baseUrl}/api/hermes/checkpoint`, {
    method: "POST", headers,
    body: JSON.stringify({ task_id: accepted.task_id, claim_token: task.claim_token, stage: "uploading" })
  });
  assert.equal(lateCheckpoint.status, 404);
  assert.equal((await lateCheckpoint.json()).error, "task_not_found_or_not_claimed");
});


test("private object storage endpoints require worker auth and explicit storage configuration", async () => {
  const unauthorized = await fetch(`${baseUrl}/api/storage/joyverse/scenes/test.mp4`, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: Buffer.from([1, 2, 3])
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

  const headers = {
    authorization: `Bearer ${WORKER_TOKEN}`,
    "content-type": "video/mp4"
  };
  const unavailable = await fetch(`${baseUrl}/api/storage/joyverse/scenes/test.mp4`, {
    method: "PUT", headers, body: Buffer.from([1, 2, 3])
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "object_storage_not_configured" });

  const unavailableRead = await fetch(`${baseUrl}/api/storage/joyverse/scenes/test.mp4`, {
    headers: { authorization: `Bearer ${WORKER_TOKEN}` }
  });
  assert.equal(unavailableRead.status, 503);
  assert.deepEqual(await unavailableRead.json(), { error: "object_storage_not_configured" });
});
