"""Secure Render entrypoint for the upstream Agnes Video Generator.

Required Render environment variables:
  APP_USERNAME
  APP_PASSWORD
Optional:
  AGNES_API_KEY
  GOOGLE_GEMINI_API_KEY
  GOOGLE_GEMINI_MODEL (defaults to gemini-3.8-flash)

No API requests are made at startup. The health endpoint remains reachable by
Render; every other route requires HTTP Basic authentication.
"""
from __future__ import annotations

import base64
import hmac
import json
import os
from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import PlainTextResponse, Response


def seed_env_config() -> None:
    """Recreate provider/model settings from Render secrets after each restart."""
    config_dir = Path(os.environ.get("AGNES_CONFIG_DIR", "/tmp/agnes_config"))
    config_dir.mkdir(parents=True, exist_ok=True)
    config_file = config_dir / "config.json"

    try:
        config = json.loads(config_file.read_text("utf-8")) if config_file.exists() else {}
    except (OSError, json.JSONDecodeError):
        config = {}

    if not isinstance(config, dict):
        config = {}

    models = config.get("models")
    if not isinstance(models, dict):
        models = {}

    # Pin the built-in free Flash video/image models. Paid variants are not selected.
    models.setdefault("video", "agnes-video-2.5-flash")
    models.setdefault("image", "agnes-image-2.5-flash")

    gemini_key = os.environ.get("GOOGLE_GEMINI_API_KEY", "").strip()
    if gemini_key:
        model_id = os.environ.get("GOOGLE_GEMINI_MODEL", "gemini-3.8-flash").strip()
        provider_id = "google_gemini"
        providers = config.get("text_providers")
        if not isinstance(providers, list):
            providers = []
        providers = [
            p for p in providers
            if not (isinstance(p, dict) and p.get("provider") == provider_id)
        ]
        providers.append({
            "provider": provider_id,
            "display_name": "Google Gemini",
            "api": "openai-completions",
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
            "api_key": gemini_key,
            "models": [model_id],
        })
        config["text_providers"] = providers
        models["text_provider"] = provider_id
        models["text"] = model_id

    config["models"] = models
    tmp_file = config_file.with_suffix(".json.tmp")
    tmp_file.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp_file, 0o600)
    tmp_file.replace(config_file)
    os.chmod(config_file, 0o600)


class BasicAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        # Required for the upstream container's own health check.
        if request.url.path == "/api/health":
            return await call_next(request)

        username = os.environ.get("APP_USERNAME", "").strip()
        password = os.environ.get("APP_PASSWORD", "")
        if not username or not password:
            return PlainTextResponse(
                "Setup required: set APP_USERNAME and APP_PASSWORD in Render Environment.",
                status_code=503,
            )

        header = request.headers.get("authorization", "")
        supplied_user = ""
        supplied_password = ""
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
                supplied_user, supplied_password = decoded.split(":", 1)
            except (ValueError, UnicodeDecodeError):
                supplied_user = supplied_password = ""

        valid_user = hmac.compare_digest(supplied_user, username)
        valid_password = hmac.compare_digest(supplied_password, password)
        if not (valid_user and valid_password):
            return Response(
                content="Authentication required",
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="Agnes Video Studio"'},
                media_type="text/plain",
            )

        return await call_next(request)


def main() -> None:
    # Keep the free Render instance's temporary configuration reproducible from
    # environment secrets. Render free storage is ephemeral, so outputs must be
    # downloaded before the instance sleeps/restarts.
    os.environ.setdefault("AGNES_CONFIG_DIR", "/tmp/agnes_config")
    seed_env_config()

    import server  # upstream app, loaded only after env-backed config is ready
    server.app.add_middleware(BasicAuthMiddleware)

    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(server.app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
