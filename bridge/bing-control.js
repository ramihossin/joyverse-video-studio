import express from "express";
import { getTaskPool } from "./task-store.js";
import { createObjectStorage } from "./object-storage.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_VIDEO_BYTES = 48 * 1024 * 1024;

export async function initializeBingControlStore() {
  await getTaskPool().query(`
    CREATE TABLE IF NOT EXISTS joyverse_bing_commands (
      command_id UUID PRIMARY KEY,
      command TEXT NOT NULL CHECK (command IN ('check_page','submit_scene')),
      scene_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      device_status TEXT,
      page TEXT,
      message TEXT,
      storage_key TEXT,
      byte_length BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS joyverse_bing_commands_updated_idx
      ON joyverse_bing_commands (updated_at);
  `);
}

export async function dispatchConfiguredBingCommand(raw, { webhookUrl, isValidWebhook }) {
  if (!raw || !String(raw).trim()) return;
  let task;
  try {
    task = JSON.parse(raw);
  } catch {
    console.error("Bing command was not dispatched: BING_COMMAND_JSON is invalid JSON.");
    return;
  }

  const commandId = String(task.command_id || "");
  const command = String(task.command || "");
  const prompt = typeof task.prompt === "string" ? task.prompt.trim() : "";
  const sceneId = String(task.scene_id || ("bing-" + commandId)).slice(0, 80);
  if (!UUID_RE.test(commandId) || !["check_page", "submit_scene"].includes(command) ||
      (command === "submit_scene" && (!prompt || prompt.length > 3000))) {
    console.error("Bing command was not dispatched: invalid command payload.");
    return;
  }

  const db = getTaskPool();
  const inserted = await db.query(
    `INSERT INTO joyverse_bing_commands (command_id, command, scene_id, status)
     VALUES ($1,$2,$3,'queued')
     ON CONFLICT (command_id) DO NOTHING
     RETURNING command_id`,
    [commandId, command, sceneId]
  );
  if (!inserted.rows.length) {
    console.log("Bing command already processed; duplicate dispatch skipped: " + commandId);
    return;
  }

  if (!isValidWebhook(webhookUrl)) {
    await db.query(
      "UPDATE joyverse_bing_commands SET status='failed', message=$2, updated_at=NOW() WHERE command_id=$1",
      [commandId, "MacroDroid webhook is not configured."]
    );
    console.error("Bing command failed: MacroDroid webhook is not configured.");
    return;
  }

  const payload = { command, command_id: commandId, scene_id: sceneId };
  if (prompt) payload.prompt = prompt;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error("MacroDroid webhook returned HTTP " + response.status);
    await db.query(
      "UPDATE joyverse_bing_commands SET status='webhook_accepted', updated_at=NOW() WHERE command_id=$1",
      [commandId]
    );
    console.log("Bing command accepted by MacroDroid cloud: " + commandId + " (" + command + "). Device execution is not yet confirmed.");
  } catch (error) {
    const message = String(error?.message || error).slice(0, 240);
    await db.query(
      "UPDATE joyverse_bing_commands SET status='failed', message=$2, updated_at=NOW() WHERE command_id=$1",
      [commandId, message]
    );
    console.error("Bing command dispatch failed: " + message);
  }
}

export async function logBingCommandStatus(commandId) {
  if (!UUID_RE.test(String(commandId || ""))) return;
  const { rows } = await getTaskPool().query(
    `SELECT command_id, command, status, device_status, page, message,
            storage_key, byte_length, updated_at
       FROM joyverse_bing_commands WHERE command_id=$1`,
    [commandId]
  );
  if (!rows.length) {
    console.log("Bing command status not found: " + commandId);
    return;
  }
  const row = rows[0];
  console.log("Bing command status: " + JSON.stringify({
    command_id: row.command_id,
    command: row.command,
    status: row.status,
    device_status: row.device_status,
    page: row.page,
    message: row.message,
    video_uploaded: Boolean(row.storage_key),
    byte_length: row.byte_length ? Number(row.byte_length) : null,
    download_url: row.storage_key ? "/api/bing/download/" + row.command_id : null,
    updated_at: row.updated_at
  }));
}

export async function recordBingDeviceResult(result) {
  if (!result || !UUID_RE.test(String(result.commandId || ""))) return;
  const status = String(result.status || "unknown").slice(0, 40);
  const page = String(result.page || "").slice(0, 300);
  const message = String(result.message || "").slice(0, 500);
  try {
    const db = getTaskPool();
    await db.query(
      `UPDATE joyverse_bing_commands
          SET device_status=$2, page=$3, message=$4,
              status=CASE
                WHEN storage_key IS NOT NULL THEN 'completed'
                WHEN $2 IN ('failed','error') THEN 'failed'
                ELSE 'device_callback'
              END,
              updated_at=NOW()
        WHERE command_id=$1`,
      [result.commandId, status, page, message]
    );
    console.log("Bing device callback received: " + result.commandId + " (" + status + ").");
  } catch (error) {
    console.error("Unable to persist Bing device callback: " + String(error?.message || error).slice(0, 180));
  }
}

export function installBingControlRoutes(app) {
  app.get("/api/bing/status/:commandId", async (req, res) => {
    const commandId = String(req.params.commandId || "");
    if (!UUID_RE.test(commandId)) return res.status(400).json({ error: "invalid_command_id" });
    try {
      const { rows } = await getTaskPool().query(
        `SELECT command_id, command, scene_id, status, device_status, page, message,
                storage_key, byte_length, created_at, updated_at
           FROM joyverse_bing_commands WHERE command_id=$1`,
        [commandId]
      );
      if (!rows.length) return res.status(404).json({ error: "command_not_found" });
      const row = rows[0];
      res.set("Cache-Control", "no-store");
      return res.json({
        command_id: row.command_id,
        command: row.command,
        scene_id: row.scene_id,
        status: row.status,
        device_status: row.device_status,
        page: row.page,
        message: row.message,
        video_uploaded: Boolean(row.storage_key),
        byte_length: row.byte_length ? Number(row.byte_length) : null,
        download_url: row.storage_key ? "/api/bing/download/" + row.command_id : null,
        created_at: row.created_at,
        updated_at: row.updated_at
      });
    } catch (error) {
      console.error("Bing command status lookup failed:", String(error?.message || error).slice(0, 180));
      return res.status(502).json({ error: "status_lookup_failed" });
    }
  });

  app.post("/api/bing/upload/:commandId", express.raw({
    type: ["video/mp4", "application/octet-stream"],
    limit: MAX_VIDEO_BYTES
  }), async (req, res) => {
    const commandId = String(req.params.commandId || "");
    if (!UUID_RE.test(commandId)) return res.status(400).json({ error: "invalid_command_id" });
    if (!Buffer.isBuffer(req.body) || req.body.length < 12 || req.body.length > MAX_VIDEO_BYTES ||
        req.body.subarray(4, 8).toString("ascii") !== "ftyp") {
      return res.status(400).json({ error: "invalid_mp4_body", max_bytes: MAX_VIDEO_BYTES });
    }
    try {
      const db = getTaskPool();
      const existing = await db.query(
        "SELECT command_id FROM joyverse_bing_commands WHERE command_id=$1",
        [commandId]
      );
      if (!existing.rows.length) return res.status(404).json({ error: "command_not_found" });
      const key = "bing/" + commandId + ".mp4";
      await createObjectStorage().put(key, req.body, "video/mp4");
      await db.query(
        `UPDATE joyverse_bing_commands SET storage_key=$2, byte_length=$3,
                status=CASE WHEN device_status IN ('completed','success','done') THEN 'completed' ELSE 'video_uploaded' END,
                updated_at=NOW()
          WHERE command_id=$1`,
        [commandId, key, req.body.length]
      );
      res.set("Cache-Control", "no-store");
      console.log("Bing MP4 uploaded and stored: " + commandId + " (" + req.body.length + " bytes).");
      return res.status(201).json({
        accepted: true, command_id: commandId, bytes: req.body.length,
        download_url: "/api/bing/download/" + commandId
      });
    } catch (error) {
      console.error("Bing MP4 upload failed:", String(error?.message || error).slice(0, 200));
      return res.status(502).json({ error: "video_storage_failed" });
    }
  });

  app.get("/api/bing/download/:commandId", async (req, res) => {
    const commandId = String(req.params.commandId || "");
    if (!UUID_RE.test(commandId)) return res.status(400).json({ error: "invalid_command_id" });
    try {
      const { rows } = await getTaskPool().query(
        "SELECT storage_key FROM joyverse_bing_commands WHERE command_id=$1",
        [commandId]
      );
      if (!rows[0]?.storage_key) return res.status(404).json({ error: "video_not_uploaded" });
      const video = await createObjectStorage().get(rows[0].storage_key);
      res.set({
        "Content-Type": "video/mp4",
        "Content-Length": String(video.length),
        "Content-Disposition": 'attachment; filename="joyverse-bing-' + commandId + '.mp4"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      });
      return res.status(200).send(video);
    } catch (error) {
      console.error("Bing MP4 download failed:", String(error?.message || error).slice(0, 180));
      return res.status(502).json({ error: "video_download_failed" });
    }
  });
}
