#!/usr/bin/env python3
"""Phone-side worker: Render queue -> local authenticated Hermes bridge."""
from __future__ import annotations

import secrets
import sys
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
RENDER_BASE = "https://joyverse-mcp-bridge.onrender.com"
LOCAL_BASE = "http://127.0.0.1:9120"
TOKEN_FILE = Path.home() / ".joyverse_hermes_worker_token"
BRIDGE_KEY_FILE = BASE / ".bridge_api_key"
POLL_SECONDS = 5
TASK_WAIT_SECONDS = 225


def initialize_token() -> None:
    token = secrets.token_urlsafe(48)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    os.chmod(TOKEN_FILE, 0o600)
    print("\nCopy this dedicated worker token into Render as HERMES_WORKER_TOKEN.")
    print("Do not send it in this chat or share it with anyone else.\n")
    print(token)
    print("\nToken saved locally with file permissions 600.")


def load_token() -> str:
    if not TOKEN_FILE.is_file():
        raise SystemExit(
            "Dedicated worker token is not set. Run this script once with --init-token, "
            "then add that token to Render as HERMES_WORKER_TOKEN."
        )
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise SystemExit("The local worker token is invalid; initialize a new one.")
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


def local_task_if_present(local_id: str, key: str):
    try:
        return local_request(LOCAL_BASE + "/tasks/" + local_id, key)[1]
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def save_checkpoint(task_id: str, worker_token: str, claim_token: str, **fields):
    payload = {"task_id": task_id, "claim_token": claim_token, **fields}
    status, saved = request_json(
        RENDER_BASE + "/api/hermes/checkpoint", worker_token, "POST", payload
    )
    if status != 200 or not saved or saved.get("accepted") is not True:
        raise RuntimeError("Server did not confirm the durable task checkpoint.")
    return saved


def main():
    if not BRIDGE_KEY_FILE.is_file():
        raise SystemExit("Local bridge key file is missing.")
    bridge_key = BRIDGE_KEY_FILE.read_text(encoding="utf-8").strip()
    if not bridge_key:
        raise SystemExit("Local bridge key file is empty.")
    worker_token = load_token()

    status, health = request_json(RENDER_BASE + "/health", worker_token)
    print("Render reachable; authenticated worker starting.")
    status, _ = local_request(LOCAL_BASE + "/health", bridge_key)
    print("Local Hermes bridge reachable. Polling for tasks; Ctrl+C to stop.")

    while True:
        try:
            status, task = request_json(RENDER_BASE + "/api/hermes/next", worker_token)
            if status == 204 or not task:
                time.sleep(POLL_SECONDS)
                continue

            task_id = task["task_id"]
            claim_token = task.get("claim_token")
            if not isinstance(claim_token, str) or len(claim_token) < 32:
                raise RuntimeError("Server did not provide a valid task-claim token.")
            print(f"Received task {task_id} ({task.get('scene_id', 'no scene id')}).")
            local_payload = {
                "scene_id": task["scene_id"],
                "prompt": task["prompt"],
                "toolsets": task.get("toolsets", ["web"]),
                "confirm_video_generation": task.get("confirm_video_generation", False)
            }

            # Resume a local Hermes task after a worker restart when its ID was
            # checkpointed and the local bridge still has that task.
            local_id = None
            if task.get("provider") == "local-hermes" and task.get("provider_job_id"):
                local_id = task["provider_job_id"]
                current = local_task_if_present(local_id, bridge_key)
                if current is None:
                    local_id = None
                elif current.get("status") in ("completed", "failed"):
                    pass

            if local_id is None:
                save_checkpoint(task_id, worker_token, claim_token, stage="preparing", provider="local-hermes")
                _, submitted = local_request(LOCAL_BASE + "/tasks", bridge_key, "POST", local_payload)
                local_id = submitted["task_id"]
                save_checkpoint(task_id, worker_token, stage="generating",
                                provider="local-hermes", provider_job_id=local_id)

            deadline = time.time() + TASK_WAIT_SECONDS
            final = None
            current = local_task_if_present(local_id, bridge_key)
            if current and current.get("status") in ("completed", "failed"):
                final = current

            while final is None and time.time() < deadline:
                current = local_task_if_present(local_id, bridge_key)
                if current is None:
                    raise RuntimeError("Checkpointed local Hermes task no longer exists.")
                if current["status"] in ("completed", "failed"):
                    final = current
                    break
                # Heartbeat prevents another worker from reclaiming a live task.
                save_checkpoint(task_id, worker_token, stage="generating",
                                provider="local-hermes", provider_job_id=local_id)
                time.sleep(3)

            if final is None:
                # Do not mark a still-running generation as failed merely because
                # this polling window elapsed. Keep its provider task ID checkpointed;
                # the queue lease will expire if this worker process later stops.
                save_checkpoint(task_id, worker_token, stage="generating",
                                provider="local-hermes", provider_job_id=local_id)
                print(f"Task {task_id} is still running; durable checkpoint retained.")
                continue

            if final["status"] == "completed":
                result = final.get("result") or {}
                report = {"task_id": task_id, "claim_token": claim_token, "status": "completed", "result": result}
            else:
                error = final.get("error") or "Local Hermes task failed."
                report = {"task_id": task_id, "claim_token": claim_token, "status": "failed", "error": error}

            _, acknowledged = request_json(
                RENDER_BASE + "/api/hermes/result", worker_token, "POST", report
            )
            if not acknowledged or acknowledged.get("accepted") is not True:
                raise RuntimeError("Server did not acknowledge the task result.")
            print(f"Task {task_id}: {acknowledged.get('status', 'reported')}.")
        except KeyboardInterrupt:
            print("\nWorker stopped.")
            return
        except Exception as exc:
            print("Worker error:", str(exc)[:300])
            time.sleep(10)


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--init-token":
        initialize_token()
    elif len(sys.argv) == 1:
        main()
    else:
        raise SystemExit("Usage: hermes_phone_worker.py [--init-token]")
