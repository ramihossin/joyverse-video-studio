#!/usr/bin/env python3
"""Phone-side worker: Render queue -> local authenticated Hermes bridge."""
from __future__ import annotations

import getpass
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
RENDER_BASE = "https://joyverse-mcp-bridge.onrender.com"
LOCAL_BASE = "http://127.0.0.1:9120"
TOKEN_FILE = Path.home() / ".joyverse_render_worker_token"
BRIDGE_KEY_FILE = BASE / ".bridge_api_key"
POLL_SECONDS = 5
TASK_WAIT_SECONDS = 225


def load_token() -> str:
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    token = getpass.getpass("Render MCP_ACCESS_TOKEN (input hidden): ").strip()
    if len(token) < 32:
        raise SystemExit("Token is missing or too short; no token was saved.")
    TOKEN_FILE.write_text(token, encoding="utf-8")
    os.chmod(TOKEN_FILE, 0o600)
    return token


def request_json(url: str, token: str, method: str = "GET", payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/json",
                 "Cache-Control": "no-store"}
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            raw = response.read()
            return response.status, (json.loads(raw.decode("utf-8")) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        if exc.code == 204:
            return 204, None
        raise RuntimeError(f"HTTP {exc.code}: {raw[:300].decode('utf-8', 'replace')}") from exc


def local_request(url: str, key: str, method: str = "GET", payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        raw = response.read()
        return response.status, (json.loads(raw.decode("utf-8")) if raw else None)


def main():
    if not BRIDGE_KEY_FILE.is_file():
        raise SystemExit("Local bridge key file is missing.")
    bridge_key = BRIDGE_KEY_FILE.read_text(encoding="utf-8").strip()
    if not bridge_key:
        raise SystemExit("Local bridge key file is empty.")
    render_token = load_token()

    status, health = request_json(RENDER_BASE + "/health", render_token)
    print("Render reachable; authenticated worker starting.")
    status, _ = local_request(LOCAL_BASE + "/health", bridge_key)
    print("Local Hermes bridge reachable. Polling for tasks; Ctrl+C to stop.")

    while True:
        try:
            status, task = request_json(RENDER_BASE + "/api/hermes/next", render_token)
            if status == 204 or not task:
                time.sleep(POLL_SECONDS)
                continue

            task_id = task["task_id"]
            print(f"Received task {task_id} ({task.get('scene_id', 'no scene id')}).")
            local_payload = {
                "scene_id": task["scene_id"],
                "prompt": task["prompt"],
                "toolsets": task.get("toolsets", ["web"]),
                "confirm_video_generation": task.get("confirm_video_generation", False)
            }
            _, submitted = local_request(LOCAL_BASE + "/tasks", bridge_key, "POST", local_payload)
            local_id = submitted["task_id"]
            deadline = time.time() + TASK_WAIT_SECONDS
            final = None

            while time.time() < deadline:
                _, current = local_request(LOCAL_BASE + "/tasks/" + local_id, bridge_key)
                if current["status"] in ("completed", "failed"):
                    final = current
                    break
                time.sleep(3)

            if final and final["status"] == "completed":
                result = final.get("result") or {}
                report = {"task_id": task_id, "status": "completed", "result": result}
            else:
                error = (final or {}).get("error") or "Local Hermes task timed out."
                report = {"task_id": task_id, "status": "failed", "error": error}

            _, acknowledged = request_json(
                RENDER_BASE + "/api/hermes/result", render_token, "POST", report
            )
            print(f"Task {task_id}: {acknowledged.get('status', 'reported')}.")
        except KeyboardInterrupt:
            print("\nWorker stopped.")
            return
        except Exception as exc:
            print("Worker error:", str(exc)[:300])
            time.sleep(10)


if __name__ == "__main__":
    main()
