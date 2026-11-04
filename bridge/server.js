import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;
if (!ACCESS_TOKEN || ACCESS_TOKEN.length < 32) {
  throw new Error("MCP_ACCESS_TOKEN must be set to a random value of at least 32 characters.");
}

let lastDeviceResult = null;
let lastCommand = null;
const seenCommandIds = new Set();

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
    "Send one command to the user's MacroDroid webhook to control the Android browser. The webhook URL is a private device capability; use only the URL the user supplies. A successful response means MacroDroid accepted the webhook request, not that Loremotion completed the action.",
    {
      webhook_url: z.string().url().describe("Private MacroDroid Webhook URL from the user's own device."),
      command: z.enum(["open_loremotion", "submit_scene", "check_page", "stop"]).describe("Command for the user's MacroDroid command macro."),
      prompt: z.string().max(3000).optional().describe("Scene prompt; required for submit_scene."),
      scene_id: z.string().max(80).optional()
    },
    async ({ webhook_url, command, prompt, scene_id }) => {
      if (!isValidMacroDroidWebhook(webhook_url)) {
        return { isError: true, content: [{ type: "text", text: "Rejected URL. Only a valid https://trigger.macrodroid.com/<device-id>/<identifier> webhook is accepted." }] };
      }
      if (command === "submit_scene" && !prompt?.trim()) {
        return { isError: true, content: [{ type: "text", text: "prompt is required for submit_scene." }] };
      }
      const commandId = randomUUID();
      const target = new URL(webhook_url);
      target.searchParams.set("command", command);
      target.searchParams.set("command_id", commandId);
      if (prompt) target.searchParams.set("prompt", prompt);
      if (scene_id) target.searchParams.set("scene_id", scene_id);

      try {
        const response = await fetch(target, { method: "GET", redirect: "error", signal: AbortSignal.timeout(12000) });
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

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "joyverse-macrodroid-bridge",
  mcp: "/mcp/<private-token>",
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
