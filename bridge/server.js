import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { initializeTaskStore, enqueueTask, getTask, claimNextTask, finishTask, getQueueCounts, updateTaskCheckpoint, setTaskReferenceImage } from "./task-store.js";
import { normalizeVideoOptions, assertVideoOptionsForProvider } from "./video-job.js";
import { createObjectStorage } from "./object-storage.js";
import { assembleMp4 } from "./ffmpeg-assembler.js";
import { createVideoWorker } from "./video-worker.js";
import { verifyGithubActionsToken } from "./github-oidc.js";

const app = express();
app.disable("x-powered-by");
const DEFAULT_STUDIO_ORIGINS = [
  "https://ramihossin.github.io",
  "https://joyverse-video-studio.onrender.com"
];
const STUDIO_ALLOWED_ORIGINS = new Set([
  ...DEFAULT_STUDIO_ORIGINS,
  ...(process.env.STUDIO_ALLOWED_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean)
]);
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && STUDIO_ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(origin && STUDIO_ALLOWED_ORIGINS.has(origin) ? 204 : 403).end();
  next();
});
app.use(express.json({ limit: "20kb" }));

const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;
const HERMES_WORKER_TOKEN = process.env.HERMES_WORKER_TOKEN || "";
const JOYVERSE_STUDIO_TOKEN = process.env.JOYVERSE_STUDIO_TOKEN || "";
const CHATGPT_DISPATCH_TOKEN = process.env.CHATGPT_DISPATCH_TOKEN || "";
const MACRODROID_WEBHOOK_URL = process.env.MACRODROID_WEBHOOK_URL || "";
if (!ACCESS_TOKEN || ACCESS_TOKEN.length < 32) {
  throw new Error("MCP_ACCESS_TOKEN must be set to a random value of at least 32 characters.");
}

const DASHBOARD_PATH = fileURLToPath(new URL("./dashboard.html", import.meta.url));
let lastDeviceResult = null;
let lastCommand = null;
const seenCommandIds = new Set();

// Task records are stored in PostgreSQL; process memory is not used for queue state.
const HERMES_TOOLSETS = new Set(["web", "browser", "video_gen"]);
const HERMES_MAX_PROMPT = 12000;

const VIDEO_WORKER_REPOSITORY = process.env.GITHUB_OIDC_REPOSITORY || "ramihossin/joyverse-video-studio";
const VIDEO_WORKER_WORKFLOW = ".github/workflows/video-worker.yml";
const VIDEO_WORKER_BRANCH = process.env.GITHUB_OIDC_BRANCH || "main";
const VIDEO_WORKER_AUDIENCE = "joyverse-video-worker";
const SELECTED_VIDEO_PROVIDER = String(process.env.VIDEO_PROVIDER || (process.env.AGNES_API_KEY ? "agnes" : "ltx")).toLowerCase();
let backgroundVideoWorker = null;
let backgroundVideoWorkerBusy = false;

function getBackgroundVideoWorker() {
  if (backgroundVideoWorker) return backgroundVideoWorker;
  try {
    backgroundVideoWorker = createVideoWorker();
    return backgroundVideoWorker;
  } catch (error) {
    console.warn("Video worker is unavailable until durable object storage is configured:",
      String(error?.message || error).slice(0, 240));
    return null;
  }
}

function startBackgroundVideoTask() {
  // The persistent worker is already polling the durable queue; do not spawn a duplicate.
  if (backgroundVideoWorkerBusy) return true;
  const worker = getBackgroundVideoWorker();
  if (!worker) return false;
  backgroundVideoWorkerBusy = true;
  void worker.runOnce()
    .catch(error => console.error("Background video worker failed:", String(error?.message || error).slice(0, 300)))
    .finally(() => { backgroundVideoWorkerBusy = false; });
  return true;
}



function isValidMacroDroidWebhook(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname === "trigger.macrodroid.com" &&
      u.username === "" && u.password === "" &&
      /^\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{1,80}$/.test(u.pathname);
  } catch {
    return false;
  }
}

function createMcpServer() {
  const server = new McpServer({ name: "joyverse-macrodroid-bridge", version: "1.0.0" });

  server.tool(
    "send_macro_command",
    "Send one command to the user's MacroDroid webhook to control the Android browser. The private MacroDroid webhook is read only from the server-side MACRODROID_WEBHOOK_URL environment variable and is never returned to clients. A successful response means MacroDroid accepted the webhook request, not that Loremotion completed the action.",
    {
      command: z.enum(["open_loremotion", "submit_scene", "check_page", "stop"]).describe("Command for the user's MacroDroid command macro."),
      prompt: z.string().max(3000).optional().describe("Scene prompt; required for submit_scene."),
      scene_id: z.string().max(80).optional()
    },
    async ({ command, prompt, scene_id }) => {
      if (!isValidMacroDroidWebhook(MACRODROID_WEBHOOK_URL)) {
        return { isError: true, content: [{ type: "text", text: "MacroDroid webhook is not configured. Set a valid private https://trigger.macrodroid.com/<device-id>/<identifier> URL in the Render MACRODROID_WEBHOOK_URL environment variable." }] };
      }
      if (command === "submit_scene" && !prompt?.trim()) {
        return { isError: true, content: [{ type: "text", text: "prompt is required for submit_scene." }] };
      }
      const commandId = randomUUID();
      const payload = { command, command_id: commandId };
      if (prompt) payload.prompt = prompt;
      if (scene_id) payload.scene_id = scene_id;

      try {
        const response = await fetch(MACRODROID_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: AbortSignal.timeout(12000)
        });
        lastCommand = { commandId, command, sceneId: scene_id ?? null, dispatchedAt: new Date().toISOString(), httpStatus: response.status };
        if (!response.ok) {
          return { isError: true, content: [{ type: "text", text: "MacroDroid webhook returned HTTP " + response.status + ". No execution is confirmed." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({
          accepted: true,
          command_id: commandId,
          command,
          http_status: response.status,
          note: "Webhook request accepted by MacroDroid's cloud endpoint. This does not prove that the on-device macro ran or that Loremotion completed the requested action. Await a device callback or inspect the phone."
        }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: "Webhook dispatch failed: " + (error?.message || String(error)) }] };
      }
    }
  );

  server.tool(
    "dispatch_hermes_task",
    "Queue a task for the user's Android Hermes worker. The phone must be online and polling. Video generation requires explicit confirmation for each task.",
    {
      scene_id: z.string().min(1).max(100),
      prompt: z.string().min(1).max(HERMES_MAX_PROMPT),
      toolsets: z.array(z.enum(["web", "browser", "video_gen"])).min(1).default(["web"]),
      confirm_video_generation: z.boolean().default(false)
    },
    async ({ scene_id, prompt, toolsets, confirm_video_generation }) => {
      const selected = [...new Set(toolsets)];
      if (selected.includes("video_gen") && !confirm_video_generation) {
        return { isError: true, content: [{ type: "text", text: "Video generation requires explicit confirmation." }] };
      }
      if (confirm_video_generation && !selected.includes("video_gen")) {
        return { isError: true, content: [{ type: "text", text: "Confirmation requires video_gen in toolsets." }] };
      }
      const taskId = "hermes_" + randomUUID();
      const task = {
        task_id: taskId, scene_id, prompt, toolsets: selected,
        confirm_video_generation, status: "queued",
        created_at: new Date().toISOString(), claimed_at: null,
        result: null, error: null
      };
      await enqueueTask(task);
      return { content: [{ type: "text", text: JSON.stringify({
        accepted: true, task_id: taskId, scene_id, status: "queued",
        note: "Queued in PostgreSQL. The Android worker must claim and execute it; acceptance is not completion."
      }) }] };
    }
  );

  server.tool(
    "get_hermes_task_status",
    "Check the status and result of a task previously dispatched to the Android Hermes worker.",
    { task_id: z.string().min(1).max(100) },
    async ({ task_id }) => {
      const task = await getTask(task_id);
      if (!task) {
        return { isError: true, content: [{ type: "text", text: "Hermes task not found." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({
        task_id: task.task_id, scene_id: task.scene_id, status: task.status,
        video_options: task.video_options || {}, result: task.result, error: task.error,
        stage: task.stage, provider: task.provider,
        provider_job_id: task.provider_job_id, output_url: task.output_url,
        storage_key: task.storage_key, heartbeat_at: task.heartbeat_at,
        attempts: task.attempts,
        created_at: task.created_at, finished_at: task.finished_at ?? null
      }) }] };
    }
  );

  server.tool(
    "get_device_result",
    "Read the latest status callback posted by the user's MacroDroid macro. Returns only the latest callback held in server memory.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify({
        last_command: lastCommand,
        last_device_result: lastDeviceResult,
        persistence: "in-memory only; cleared when the service restarts"
      }) }]
    })
  );

  return server;
}


// Authenticated REST endpoint for clients that cannot speak MCP.
// Uses the existing secret only in the Authorization header, never in the URL.
function bearerAuthorized(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header);
  return Boolean(match && match[1] === ACCESS_TOKEN);
}

function hermesWorkerAuthorized(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header);
  if (!HERMES_WORKER_TOKEN || !match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(HERMES_WORKER_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function studioAuthorized(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header);
  if (!JOYVERSE_STUDIO_TOKEN || !match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(JOYVERSE_STUDIO_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function studioOrWorkerAuthorized(req) {
  return studioAuthorized(req) || hermesWorkerAuthorized(req);
}

function chatgptDispatchAuthorized(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header);
  if (!CHATGPT_DISPATCH_TOKEN || !match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(CHATGPT_DISPATCH_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Public dashboard shell. Private operational data remains behind /api/status.
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(DASHBOARD_PATH);
});

app.get("/chatgpt-console", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JoyVerse Task Console</title>
<style>
body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 16px;color:#172033}
label{display:block;margin:14px 0 6px;font-weight:600}input,textarea,select{box-sizing:border-box;width:100%;padding:10px;border:1px solid #9aa5b5;border-radius:8px;font:inherit}
textarea{min-height:130px}button{margin-top:16px;padding:11px 18px;border:0;border-radius:8px;background:#174ea6;color:white;font-weight:700}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f8;padding:12px;border-radius:8px}
small{color:#586174}
</style>
<h1>JoyVerse Task Console</h1><p>Secure task dispatch to the connected Android Hermes worker. Video generation is intentionally unavailable in this console.</p>
<form id="f">
<label for="token">Dispatch credential</label><input id="token" type="password" autocomplete="off" required>
<label for="scene">Task ID label</label><input id="scene" value="chatgpt-diagnostic" maxlength="100" required>
<label for="prompt">Instruction for Hermes</label><textarea id="prompt" maxlength="12000" required>Reply exactly: HERMES_LINK_OK. Do not use browser, web, video_gen, or any paid external services.</textarea>
<label for="tools">Tool access</label><select id="tools"><option value="web">Text only (web tool disabled by instruction)</option><option value="browser">Browser</option></select>
<button type="submit">Send task</button>
</form>
<pre id="out" aria-live="polite">Ready. No task has been sent.</pre>
<script>
const form=document.getElementById('f'),out=document.getElementById('out');
form.addEventListener('submit',async e=>{
 e.preventDefault();const token=document.getElementById('token').value;
 const payload={scene_id:document.getElementById('scene').value,prompt:document.getElementById('prompt').value,toolsets:['web'],confirm_video_generation:false};
 out.textContent='Sending task…';
 try{
  const r=await fetch('/api/hermes/dispatch-chatgpt',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(payload),cache:'no-store'});
  const data=await r.json();if(!r.ok)throw new Error('HTTP '+r.status+' '+JSON.stringify(data));
  out.textContent='Accepted: '+JSON.stringify(data)+'\\nWaiting for Hermes…';
  const id=data.task_id;
  for(let i=0;i<80;i++){await new Promise(resolve=>setTimeout(resolve,3000));
   const s=await fetch('/api/hermes/status-chatgpt/'+encodeURIComponent(id),{headers:{'Authorization':'Bearer '+token},cache:'no-store'});
   const state=await s.json();if(!s.ok)throw new Error('Status HTTP '+s.status);
   out.textContent='Task status: '+JSON.stringify(state,null,2);
   if(state.status==='completed'||state.status==='failed')break;
  }
 }catch(err){out.textContent='ERROR: '+err.message;}
});
</script></html>`);
});

app.post("/api/command", async (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { command, prompt, scene_id } = req.body ?? {};
  if (!["open_loremotion", "submit_scene", "check_page", "stop"].includes(command)) {
    return res.status(400).json({ error: "invalid_command" });
  }
  if (command === "submit_scene" && (typeof prompt !== "string" || !prompt.trim())) {
    return res.status(400).json({ error: "prompt_required" });
  }
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > 3000)) {
    return res.status(400).json({ error: "invalid_prompt" });
  }
  if (scene_id !== undefined && (typeof scene_id !== "string" || scene_id.length > 80)) {
    return res.status(400).json({ error: "invalid_scene_id" });
  }
  if (!isValidMacroDroidWebhook(MACRODROID_WEBHOOK_URL)) {
    return res.status(503).json({ error: "macrodroid_webhook_not_configured" });
  }

  const commandId = randomUUID();
  const payload = { command, command_id: commandId };
  if (prompt) payload.prompt = prompt;
  if (scene_id) payload.scene_id = scene_id;

  try {
    const response = await fetch(MACRODROID_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(12000)
    });
    lastCommand = {
      commandId, command, sceneId: scene_id ?? null,
      dispatchedAt: new Date().toISOString(), httpStatus: response.status
    };
    if (!response.ok) {
      return res.status(502).json({
        accepted: false, command_id: commandId,
        error: "macrodroid_webhook_rejected", upstream_status: response.status
      });
    }
    return res.status(202).json({
      accepted: true, command_id: commandId, command,
      note: "Webhook accepted by MacroDroid cloud; on-device execution is not yet confirmed."
    });
  } catch (error) {
    return res.status(502).json({
      accepted: false, command_id: commandId,
      error: "webhook_dispatch_failed",
      message: String(error?.message || error).slice(0, 200)
    });
  }
});

// ChatGPT-controlled relay endpoint, protected by a dedicated credential distinct from the phone worker token.
app.post("/api/hermes/dispatch-chatgpt", async (req, res) => {
  if (!CHATGPT_DISPATCH_TOKEN) return res.status(503).json({ error: "chatgpt_dispatch_not_configured" });
  if (!chatgptDispatchAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { scene_id, prompt, toolsets = ["web"] } = req.body ?? {};
  if (typeof scene_id !== "string" || !scene_id.trim() || scene_id.length > 100)
    return res.status(400).json({ error: "invalid_scene_id" });
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > HERMES_MAX_PROMPT)
    return res.status(400).json({ error: "invalid_prompt" });
  if (!Array.isArray(toolsets) || toolsets.length < 1 ||
      toolsets.some(x => !["web", "browser"].includes(x)))
    return res.status(400).json({ error: "invalid_toolsets" });
  const selected = [...new Set(toolsets)];
  const taskId = "hermes_" + randomUUID();
  await enqueueTask({
    task_id: taskId, scene_id, prompt, toolsets: selected,
    confirm_video_generation: false, status: "queued",
    created_at: new Date().toISOString(), claimed_at: null,
    result: null, error: null
  });
  res.set("Cache-Control", "no-store");
  return res.status(202).json({ accepted: true, task_id: taskId, scene_id, status: "queued" });
});

app.get("/api/hermes/status-chatgpt/:taskId", async (req, res) => {
  if (!CHATGPT_DISPATCH_TOKEN) return res.status(503).json({ error: "chatgpt_dispatch_not_configured" });
  if (!chatgptDispatchAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const task = await getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "task_not_found" });
  res.set("Cache-Control", "no-store");
  return res.json({ task_id: task.task_id, scene_id: task.scene_id, status: task.status,
    video_options: task.video_options || {}, result: task.result, error: task.error, stage: task.stage,
    provider: task.provider, provider_job_id: task.provider_job_id,
    output_url: task.output_url, storage_key: task.storage_key,
    heartbeat_at: task.heartbeat_at, attempts: task.attempts,
    created_at: task.created_at, finished_at: task.finished_at ?? null });
});

// Upload a staged reference image before dispatch; dispatch atomically associates its key with the new task.
app.post("/api/hermes/reference-upload", express.raw({
  type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
  limit: "10mb"
}), async (req, res) => {
  if (!JOYVERSE_STUDIO_TOKEN && !HERMES_WORKER_TOKEN) return res.status(503).json({ error: "studio_api_not_configured" });
  if (!studioOrWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  if (!Buffer.isBuffer(req.body) || req.body.length < 12 || req.body.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: "invalid_image_body", max_bytes: 10485760 });
  }
  const bytes = req.body;
  let extension, contentType;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    extension = "png"; contentType = "image/png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    extension = "jpg"; contentType = "image/jpeg";
  } else if (bytes.toString("ascii", 0, 4) === "RIFF" &&
             bytes.toString("ascii", 8, 12) === "WEBP") {
    extension = "webp"; contentType = "image/webp";
  } else {
    return res.status(415).json({ error: "unsupported_image_format" });
  }
  const key = "references/pending/" + randomUUID() + "." + extension;
  try {
    await createObjectStorage().put(key, bytes, contentType);
    res.set("Cache-Control", "no-store");
    return res.status(201).json({ reference_image_key: key, content_type: contentType, bytes: bytes.length });
  } catch (error) {
    console.error("Staged reference upload failed:", String(error?.message || error).slice(0, 200));
    return res.status(502).json({ error: "reference_image_storage_failed" });
  }
});

// Upload one validated reference image and bind it to a queued, explicitly confirmed video task.
app.post("/api/hermes/reference/:taskId", express.raw({
  type: ["image/png", "image/jpeg", "image/webp", "application/octet-stream"],
  limit: "10mb"
}), async (req, res) => {
  if (!JOYVERSE_STUDIO_TOKEN && !HERMES_WORKER_TOKEN) return res.status(503).json({ error: "studio_api_not_configured" });
  if (!studioOrWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const taskId = req.params.taskId;
  if (typeof taskId !== "string" || !/^hermes_[0-9a-f-]{36}$/i.test(taskId)) {
    return res.status(400).json({ error: "invalid_task_id" });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length < 12 || req.body.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: "invalid_image_body", max_bytes: 10485760 });
  }
  const bytes = req.body;
  let extension, contentType;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    extension = "png"; contentType = "image/png";
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    extension = "jpg"; contentType = "image/jpeg";
  } else if (bytes.toString("ascii", 0, 4) === "RIFF" &&
             bytes.toString("ascii", 8, 12) === "WEBP") {
    extension = "webp"; contentType = "image/webp";
  } else {
    return res.status(415).json({ error: "unsupported_image_format" });
  }
  const task = await getTask(taskId);
  if (!task) return res.status(404).json({ error: "task_not_found" });
  if (task.status !== "queued" || task.confirm_video_generation !== true ||
      !Array.isArray(task.toolsets) || !task.toolsets.includes("video_gen")) {
    return res.status(409).json({ error: "task_not_eligible_for_reference_image" });
  }
  const key = "references/" + taskId + "/" + randomUUID() + "." + extension;
  try {
    await createObjectStorage().put(key, bytes, contentType);
    const linked = await setTaskReferenceImage(taskId, key);
    if (!linked) return res.status(409).json({ error: "task_no_longer_queued" });
    res.set("Cache-Control", "no-store");
    return res.status(201).json({
      task_id: taskId, reference_image_key: key,
      content_type: contentType, bytes: bytes.length
    });
  } catch (error) {
    console.error("Reference image upload failed:", String(error?.message || error).slice(0, 200));
    return res.status(502).json({ error: "reference_image_storage_failed" });
  }
});

// Hermes phone-worker queue. All endpoints use the existing bearer token.
app.post("/api/hermes/dispatch", async (req, res) => {
  if (!JOYVERSE_STUDIO_TOKEN && !HERMES_WORKER_TOKEN) return res.status(503).json({ error: "studio_api_not_configured" });
  if (!studioOrWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { scene_id, prompt, toolsets = ["web"], confirm_video_generation = false, video_options, reference_image_key } = req.body ?? {};
  if (typeof scene_id !== "string" || !scene_id.trim() || scene_id.length > 100) {
    return res.status(400).json({ error: "invalid_scene_id" });
  }
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > HERMES_MAX_PROMPT) {
    return res.status(400).json({ error: "invalid_prompt" });
  }
  if (!Array.isArray(toolsets) || toolsets.length < 1 ||
      toolsets.some(x => typeof x !== "string" || !HERMES_TOOLSETS.has(x))) {
    return res.status(400).json({ error: "invalid_toolsets" });
  }
  const selected = [...new Set(toolsets)];
  if (selected.includes("video_gen") && confirm_video_generation !== true) {
    return res.status(403).json({ error: "video_generation_confirmation_required" });
  }
  if (confirm_video_generation === true && !selected.includes("video_gen")) {
    return res.status(400).json({ error: "confirmation_without_video_gen" });
  }
  let normalizedVideoOptions = {};
  if (selected.includes("video_gen")) {
    try {
      normalizedVideoOptions = normalizeVideoOptions(video_options === undefined ? {} : video_options);
      assertVideoOptionsForProvider(normalizedVideoOptions, SELECTED_VIDEO_PROVIDER);
    } catch (error) { return res.status(400).json({ error: "invalid_video_options", message: error.message }); }
  } else if (video_options !== undefined) {
    return res.status(400).json({ error: "video_options_require_video_gen" });
  }
  if (reference_image_key !== undefined &&
      (typeof reference_image_key !== "string" ||
       !/^references\/pending\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(reference_image_key))) {
    return res.status(400).json({ error: "invalid_reference_image_key" });
  }
  if (reference_image_key && !selected.includes("video_gen")) {
    return res.status(400).json({ error: "reference_image_requires_video_gen" });
  }
  const taskId = "hermes_" + randomUUID();
  await enqueueTask({
    task_id: taskId, scene_id, prompt, toolsets: selected,
    confirm_video_generation, video_options: normalizedVideoOptions,
    reference_image_key: reference_image_key || null, status: "queued",
    created_at: new Date().toISOString(), claimed_at: null,
    result: null, error: null
  });
  return res.status(202).json({ accepted: true, task_id: taskId, scene_id, status: "queued" });
});

// Owner-only issue inbox: GitHub Actions exchanges OIDC for a confirmed task.
app.post("/api/hermes/worker/dispatch", async (req, res) => {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  try {
    await verifyGithubActionsToken(token, {
      repository: VIDEO_WORKER_REPOSITORY, workflowFile: VIDEO_WORKER_WORKFLOW,
      branch: VIDEO_WORKER_BRANCH, audience: VIDEO_WORKER_AUDIENCE
    });
  } catch {
    return res.status(401).json({ error: "invalid_github_actions_identity" });
  }
  const { scene_id, prompt, video_options } = req.body ?? {};
  if (typeof scene_id !== "string" || !scene_id.trim() || scene_id.length > 100)
    return res.status(400).json({ error: "invalid_scene_id" });
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > HERMES_MAX_PROMPT)
    return res.status(400).json({ error: "invalid_prompt" });
  let normalizedVideoOptions;
  try {
    normalizedVideoOptions = normalizeVideoOptions(video_options ?? {});
    assertVideoOptionsForProvider(normalizedVideoOptions, SELECTED_VIDEO_PROVIDER);
  } catch (error) { return res.status(400).json({ error: "invalid_video_options", message: String(error?.message || error).slice(0, 200) }); }
  const taskId = "hermes_" + randomUUID();
  await enqueueTask({
    task_id: taskId, scene_id, prompt, toolsets: ["video_gen"],
    confirm_video_generation: true, video_options: normalizedVideoOptions,
    status: "queued", created_at: new Date().toISOString(), claimed_at: null,
    result: null, error: null
  });
  const workerStarted = startBackgroundVideoTask();
  res.set("Cache-Control", "no-store");
  return res.status(202).json({ accepted: true, task_id: taskId, scene_id,
    status: "queued", worker_started: workerStarted });
});

// GitHub Actions uses short-lived OIDC identity tokens; no database or storage secret is copied into GitHub.
app.post("/api/hermes/worker/tick", async (req, res) => {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  try {
    await verifyGithubActionsToken(token, {
      repository: VIDEO_WORKER_REPOSITORY,
      workflowFile: VIDEO_WORKER_WORKFLOW,
      branch: VIDEO_WORKER_BRANCH,
      audience: VIDEO_WORKER_AUDIENCE
    });
  } catch {
    return res.status(401).json({ error: "invalid_github_actions_identity" });
  }
  if (!startBackgroundVideoTask()) {
    res.set("Cache-Control", "no-store");
    return res.status(202).json({ accepted: true, status: "busy" });
  }
  res.set("Cache-Control", "no-store");
  return res.status(202).json({ accepted: true, status: "worker_started" });
});

app.get("/api/hermes/next", async (req, res) => {
  if (!HERMES_WORKER_TOKEN) return res.status(503).json({ error: "hermes_worker_token_not_configured" });
  if (!hermesWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const task = await claimNextTask();
  if (!task) return res.status(204).end();
  res.set("Cache-Control", "no-store");
  return res.json({
    task_id: task.task_id, scene_id: task.scene_id,
    prompt: task.prompt, toolsets: task.toolsets,
    confirm_video_generation: task.confirm_video_generation,
    video_options: task.video_options || {},
    // Checkpoint metadata is essential for restart-safe provider polling.
    stage: task.stage, provider: task.provider,
    provider_job_id: task.provider_job_id,
    output_url: task.output_url, storage_key: task.storage_key,
    reference_image_key: task.reference_image_key || null,
    attempts: task.attempts, claim_token: task.claim_token
  });
});

app.post("/api/hermes/checkpoint", async (req, res) => {
  if (!HERMES_WORKER_TOKEN) return res.status(503).json({ error: "hermes_worker_token_not_configured" });
  if (!hermesWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { task_id, claim_token, stage, provider, provider_job_id, output_url, storage_key } = req.body ?? {};
  if (typeof task_id !== "string" || !task_id.trim() || task_id.length > 100)
    return res.status(400).json({ error: "invalid_task_id" });
  if (typeof claim_token !== "string" || claim_token.length < 32 || claim_token.length > 128)
    return res.status(400).json({ error: "invalid_claim_token" });
  if (output_url !== undefined) {
    try {
      const url = new URL(output_url);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("invalid protocol");
    } catch {
      return res.status(400).json({ error: "invalid_output_url" });
    }
  }
  try {
    const checkpoint = await updateTaskCheckpoint(task_id, claim_token, {
      stage, provider, provider_job_id, output_url, storage_key
    });
    if (!checkpoint) return res.status(404).json({ error: "task_not_found_or_not_claimed" });
    res.set("Cache-Control", "no-store");
    return res.json({ accepted: true, ...checkpoint });
  } catch (error) {
    return res.status(400).json({ error: "invalid_checkpoint", message: String(error?.message || error).slice(0, 160) });
  }
});

app.post("/api/hermes/result", async (req, res) => {
  if (!HERMES_WORKER_TOKEN) return res.status(503).json({ error: "hermes_worker_token_not_configured" });
  if (!hermesWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { task_id, claim_token, status, result, error } = req.body ?? {};
  if (typeof task_id !== "string") return res.status(404).json({ error: "task_not_found" });
  if (typeof claim_token !== "string" || claim_token.length < 32 || claim_token.length > 128)
    return res.status(400).json({ error: "invalid_claim_token" });
  if (!["completed", "failed"].includes(status)) return res.status(400).json({ error: "invalid_status" });
  const updated = await finishTask(task_id, claim_token, status,
    status === "completed" && result && typeof result === "object" ? result : null, error);
  if (!updated) return res.status(404).json({ error: "task_not_found_or_not_claimed" });
  return res.json({ accepted: true, task_id, status: updated.status });
});

app.get("/api/hermes/tasks/:taskId", async (req, res) => {
  if (!JOYVERSE_STUDIO_TOKEN && !HERMES_WORKER_TOKEN) return res.status(503).json({ error: "studio_api_not_configured" });
  if (!studioOrWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const task = await getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "task_not_found" });
  res.set("Cache-Control", "no-store");
  return res.json({
    task_id: task.task_id, scene_id: task.scene_id, status: task.status,
    result: task.result, error: task.error,
    stage: task.stage, provider: task.provider,
    provider_job_id: task.provider_job_id, output_url: task.output_url,
    storage_key: task.storage_key, reference_image_attached: Boolean(task.reference_image_key),
    heartbeat_at: task.heartbeat_at, attempts: task.attempts, created_at: task.created_at,
    finished_at: task.finished_at ?? null
  });
});

app.post("/api/hermes/assemble", async (req, res) => {
  if (!JOYVERSE_STUDIO_TOKEN && !HERMES_WORKER_TOKEN) return res.status(503).json({ error: "studio_api_not_configured" });
  if (!studioOrWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { task_ids } = req.body ?? {};
  if (!Array.isArray(task_ids) || task_ids.length < 1 || task_ids.length > 40 ||
      task_ids.some(id => typeof id !== "string" || !id.trim() || id.length > 100)) {
    return res.status(400).json({ error: "task_ids_must_contain_1_to_40_valid_ids_in_playback_order" });
  }
  if (new Set(task_ids).size !== task_ids.length) return res.status(400).json({ error: "duplicate_task_ids" });
  try {
    const tasks = [];
    for (const id of task_ids) {
      const task = await getTask(id);
      if (!task || task.status !== "completed") {
        return res.status(409).json({ error: "scene_not_completed", task_id: id });
      }
      const key = task.storage_key || task.result?.storage_key;
      if (typeof key !== "string" || !key.startsWith("jobs/")) {
        return res.status(409).json({ error: "scene_video_missing", task_id: id });
      }
      tasks.push({ id, key });
    }
    const storage = createObjectStorage();
    const clips = [];
    for (const task of tasks) clips.push(await storage.get(task.key));
    const finalVideo = await assembleMp4(clips);
    const finalId = randomUUID();
    const finalKey = "finals/" + finalId + ".mp4";
    await storage.put(finalKey, finalVideo, "video/mp4");
    res.set("Cache-Control", "no-store");
    return res.status(201).json({
      status: "completed", final_id: finalId, storage_key: finalKey,
      scene_count: tasks.length, bytes: finalVideo.length,
      download_path: "/api/hermes/final/" + finalId
    });
  } catch (error) {
    console.error("Server-side assembly failed:", String(error?.message || error).slice(0, 300));
    return res.status(502).json({ error: "assembly_failed", message: String(error?.message || error).slice(0, 180) });
  }
});

app.get("/api/hermes/final/:finalId", async (req, res) => {
  if (!JOYVERSE_STUDIO_TOKEN && !HERMES_WORKER_TOKEN) return res.status(503).json({ error: "studio_api_not_configured" });
  if (!studioOrWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  if (!/^[0-9a-f-]{36}$/i.test(req.params.finalId)) return res.status(400).json({ error: "invalid_final_id" });
  try {
    const video = await createObjectStorage().get("finals/" + req.params.finalId + ".mp4");
    res.set({
      "Content-Type": "video/mp4",
      "Content-Length": String(video.length),
      "Content-Disposition": 'attachment; filename="joyverse-final.mp4"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return res.status(200).send(video);
  } catch (error) {
    return res.status(404).json({ error: "final_video_not_found" });
  }
});

// Short-lived public download for the single free LTX smoke-test artifact.
app.get("/temporary-download/joyverse-ltx-square-smoke-20261112", async (_req, res) => {
  if (Date.now() >= Date.parse("2026-11-12T03:00:00Z")) {
    return res.status(410).json({ error: "temporary_download_expired" });
  }
  const taskId = "hermes_6639ed58-c408-4b66-9e60-350ce6432639";
  const key = "jobs/hermes_6639ed58-c408-4b66-9e60-350ce6432639/issue-31.mp4";
  const task = await getTask(taskId);
  if (!task || task.status !== "completed" ||
      (task.storage_key || task.result?.storage_key) !== key) {
    return res.status(404).json({ error: "smoke_test_video_not_available" });
  }
  try {
    const video = await createObjectStorage().get(key);
    if (video.length < 12 || video.subarray(4, 8).toString("ascii") !== "ftyp") {
      return res.status(502).json({ error: "stored_output_is_not_a_valid_mp4" });
    }
    res.set({
      "Content-Type": "video/mp4",
      "Content-Length": String(video.length),
      "Content-Disposition": 'attachment; filename="joyverse-ltx-square-smoke-test.mp4"',
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    });
    return res.status(200).send(video);
  } catch (error) {
    console.error("Temporary smoke-test video retrieval failed:", String(error?.message || error).slice(0, 200));
    return res.status(502).json({ error: "video_storage_unavailable" });
  }
});

// Temporary public download for the single user-approved diagnostic video.
// This narrow exception expires automatically and does not alter other download routes.
app.get("/temporary-download/joyverse-single-ltx-test-3s-20261111", async (_req, res) => {
  if (Date.now() >= Date.parse("2026-11-12T03:00:00Z")) {
    return res.status(410).json({ error: "temporary_download_expired" });
  }
  const task = await getTask("joyverse-single-ltx-test-3s-20261111");
  if (!task || task.status !== "completed" ||
      (task.storage_key || task.result?.storage_key) !==
        "jobs/joyverse-single-ltx-test-3s-20261111/colorful-bouncing-ball-test.mp4") {
    return res.status(404).json({ error: "diagnostic_video_not_available" });
  }
  try {
    const video = await createObjectStorage().get(
      "jobs/joyverse-single-ltx-test-3s-20261111/colorful-bouncing-ball-test.mp4"
    );
    res.set({
      "Content-Type": "video/mp4",
      "Content-Length": String(video.length),
      "Content-Disposition": 'attachment; filename="joyverse-colorful-bouncing-ball-test.mp4"',
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    });
    return res.status(200).send(video);
  } catch (error) {
    console.error("Temporary diagnostic video retrieval failed:", String(error?.message || error).slice(0, 200));
    return res.status(502).json({ error: "video_storage_unavailable" });
  }
});

app.get("/api/hermes/video/:taskId", async (req, res) => {
  if (!JOYVERSE_STUDIO_TOKEN && !HERMES_WORKER_TOKEN) return res.status(503).json({ error: "studio_api_not_configured" });
  if (!studioOrWorkerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const task = await getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "task_not_found" });
  const key = task.storage_key || task.result?.storage_key;
  if (task.status !== "completed" || typeof key !== "string" || !key) {
    return res.status(409).json({ error: "video_not_ready", status: task.status, stage: task.stage });
  }
  try {
    const storage = createObjectStorage();
    const video = await storage.get(key);
    res.set({
      "Content-Type": "video/mp4",
      "Content-Length": String(video.length),
      "Content-Disposition": 'attachment; filename="joyverse-' + encodeURIComponent(task.scene_id).replace(/%/g, "_") + '.mp4"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return res.status(200).send(video);
  } catch (error) {
    console.error("Stored video retrieval failed:", String(error?.message || error).slice(0, 200));
    return res.status(502).json({ error: "video_storage_unavailable" });
  }
});

app.get("/api/status", async (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const queueCounts = await getQueueCounts();
  res.set("Cache-Control", "no-store");
  res.json({
    service: {
      name: "joyverse-macrodroid-bridge",
      status: "running",
      uptime_seconds: Math.floor(process.uptime())
    },
    rest_api: {
      status: "authenticated",
      endpoint: "/api/status"
    },
    mcp: {
      configured: true,
      transport: "Streamable HTTP",
      macrodroid_webhook_configured: isValidMacroDroidWebhook(MACRODROID_WEBHOOK_URL),
      endpoint: "/mcp/<private-token>",
      connectivity_probe: "not_performed"
    },
    last_command: lastCommand,
    last_device_result: lastDeviceResult,
    hermes_queue: { persistence: "PostgreSQL durable storage", queued: queueCounts.queued, active: queueCounts.active },
    persistence: "PostgreSQL required; service refuses startup without DATABASE_URL"
  });
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "joyverse-macrodroid-bridge",
  uptime_seconds: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
  mcp: "/mcp/<private-token>",
  macrodroid_webhook_configured: isValidMacroDroidWebhook(MACRODROID_WEBHOOK_URL),
  callback: "/device-result/<private-token>"
}));

app.post("/device-result/:token", (req, res) => {
  if (req.params.token !== ACCESS_TOKEN) return res.status(404).end();
  const body = req.body ?? {};
  lastDeviceResult = {
    receivedAt: new Date().toISOString(),
    commandId: String(body.command_id ?? "").slice(0, 80),
    status: String(body.status ?? "unknown").slice(0, 40),
    page: String(body.page ?? "").slice(0, 300),
    message: String(body.message ?? "").slice(0, 500)
  };
  res.status(202).json({ accepted: true });
});

async function handleMcpRequest(req, res) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
}

// Header-authenticated MCP endpoint for ChatGPT custom plugin connections.
// The API key is supplied by the client as Authorization: Bearer <MCP_ACCESS_TOKEN>.
app.post("/mcp", async (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  return handleMcpRequest(req, res);
});

app.post("/mcp/:token", async (req, res) => {
  if (req.params.token !== ACCESS_TOKEN) return res.status(404).end();
  return handleMcpRequest(req, res);
});

app.all("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for Streamable HTTP MCP." }));
app.all("/mcp/:token", (_req, res) => res.status(405).json({ error: "Use POST for Streamable HTTP MCP." }));

const port = Number(process.env.PORT || 10000);
initializeTaskStore().then(async () => {
  // A fixed task ID makes this one-shot diagnostic idempotent across Render restarts.
  if (process.env.JOYVERSE_SINGLE_LTX_TEST === "1") {
    const taskId = "joyverse-single-ltx-test-3s-20261111";
    const existing = await getTask(taskId);
    if (!existing) {
      await enqueueTask({
        task_id: taskId,
        scene_id: "colorful-bouncing-ball-test",
        prompt: "A single glossy rainbow-colored ball gently bounces twice on a clean pastel studio floor, tiny colorful sparkles appear around it, cheerful child-friendly 3D animation, smooth motion, bright soft lighting, centered composition, no text, no logos, no people.",
        toolsets: ["video_gen"],
        confirm_video_generation: true,
        video_options: normalizeVideoOptions({ aspect: "square", duration: 3, seed: 42, randomize_seed: false, enhance_prompt: false }),
        status: "queued",
        created_at: new Date().toISOString(),
        claimed_at: null,
        result: null,
        error: null
      });
      console.log("Queued the authorized one-time diagnostic generation.");
    } else {
      console.log("One-time diagnostic task already exists; not submitting again.");
    }
  }
  app.listen(port, "0.0.0.0", () => {
    console.log("JoyVerse MacroDroid bridge listening on port " + port + " with durable PostgreSQL task storage");
    // Run the configured video provider inside this service so confirmed scenes
    // are processed without relying on an external scheduled wake-up.
    const worker = getBackgroundVideoWorker();
    if (worker) {
      backgroundVideoWorkerBusy = true;
      console.log("Starting persistent JoyVerse " + (worker.name || "configured video") + " worker.");
      void worker.run()
        .catch(error => console.error("Persistent video worker stopped:", String(error?.message || error).slice(0, 300)))
        .finally(() => { backgroundVideoWorkerBusy = false; });
    }
  });
}).catch(error => {
  console.error("Durable task store initialization failed:", error);
  process.exit(1);
});
