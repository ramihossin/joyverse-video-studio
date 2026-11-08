import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;
const MACRODROID_WEBHOOK_URL = process.env.MACRODROID_WEBHOOK_URL || "";
if (!ACCESS_TOKEN || ACCESS_TOKEN.length < 32) {
  throw new Error("MCP_ACCESS_TOKEN must be set to a random value of at least 32 characters.");
}

const DASHBOARD_PATH = fileURLToPath(new URL("./dashboard.html", import.meta.url));
let lastDeviceResult = null;
let lastCommand = null;
const seenCommandIds = new Set();

// Prototype queue: in-memory only; a Render restart clears queued tasks.
const hermesTasks = new Map();
const HERMES_TOOLSETS = new Set(["web", "browser", "video_gen"]);
const HERMES_MAX_PROMPT = 12000;


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
      hermesTasks.set(taskId, task);
      return { content: [{ type: "text", text: JSON.stringify({
        accepted: true, task_id: taskId, scene_id, status: "queued",
        note: "Queued in Render memory. The Android worker must claim and execute it; acceptance is not completion. Tasks are lost if the service restarts."
      }) }] };
    }
  );

  server.tool(
    "get_hermes_task_status",
    "Check the status and result of a task previously dispatched to the Android Hermes worker.",
    { task_id: z.string().min(1).max(100) },
    async ({ task_id }) => {
      const task = hermesTasks.get(task_id);
      if (!task) {
        return { isError: true, content: [{ type: "text", text: "Hermes task not found. It may have expired or Render may have restarted." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({
        task_id: task.task_id, scene_id: task.scene_id, status: task.status,
        result: task.result, error: task.error,
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

// Public dashboard shell. Private operational data remains behind /api/status.
app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(DASHBOARD_PATH);
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

// Hermes phone-worker queue. All endpoints use the existing bearer token.
app.post("/api/hermes/dispatch", (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { scene_id, prompt, toolsets = ["web"], confirm_video_generation = false } = req.body ?? {};
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
  const taskId = "hermes_" + randomUUID();
  hermesTasks.set(taskId, {
    task_id: taskId, scene_id, prompt, toolsets: selected,
    confirm_video_generation, status: "queued",
    created_at: new Date().toISOString(), claimed_at: null,
    result: null, error: null
  });
  return res.status(202).json({ accepted: true, task_id: taskId, scene_id, status: "queued" });
});

app.get("/api/hermes/next", (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const now = Date.now();
  const task = [...hermesTasks.values()].find(t =>
    t.status === "queued" ||
    (t.status === "claimed" && t.claimed_at && now - Date.parse(t.claimed_at) > 300000)
  );
  if (!task) return res.status(204).end();
  task.status = "claimed";
  task.claimed_at = new Date().toISOString();
  res.set("Cache-Control", "no-store");
  return res.json({
    task_id: task.task_id, scene_id: task.scene_id,
    prompt: task.prompt, toolsets: task.toolsets,
    confirm_video_generation: task.confirm_video_generation
  });
});

app.post("/api/hermes/result", (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { task_id, status, result, error } = req.body ?? {};
  const task = typeof task_id === "string" ? hermesTasks.get(task_id) : null;
  if (!task) return res.status(404).json({ error: "task_not_found" });
  if (!["completed", "failed"].includes(status)) return res.status(400).json({ error: "invalid_status" });
  task.status = status;
  task.result = status === "completed" && result && typeof result === "object"
    ? JSON.stringify(result).slice(0, 14000) : null;
  task.error = status === "failed" ? String(error || "Hermes task failed").slice(0, 1000) : null;
  task.finished_at = new Date().toISOString();
  return res.json({ accepted: true, task_id, status: task.status });
});

app.get("/api/hermes/tasks/:taskId", (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const task = hermesTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: "task_not_found" });
  res.set("Cache-Control", "no-store");
  return res.json({
    task_id: task.task_id, scene_id: task.scene_id, status: task.status,
    result: task.result, error: task.error, created_at: task.created_at,
    finished_at: task.finished_at ?? null
  });
});

app.get("/api/status", (req, res) => {
  if (!bearerAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
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
    hermes_queue: { queued: [...hermesTasks.values()].filter(t => t.status === "queued").length,
      active: [...hermesTasks.values()].filter(t => t.status === "claimed").length,
      persistence: "in-memory; reset on service restart" },
    persistence: "in-memory; reset on service restart"
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

app.post("/mcp/:token", async (req, res) => {
  if (req.params.token !== ACCESS_TOKEN) return res.status(404).end();
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
});

app.all("/mcp/:token", (_req, res) => res.status(405).json({ error: "Use POST for Streamable HTTP MCP." }));

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", () => {
  console.log("JoyVerse MacroDroid bridge listening on port " + port);
});
