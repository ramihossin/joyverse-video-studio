# JoyVerse Free Browser Agent

A standalone, authenticated Playwright service for operating browser-based video-generation websites. It is isolated under `browser-agent/`; it does not modify the existing video queue, worker, or Android bridge.

## What it does

- Opens a user-specified public website in Chromium.
- Reads page text and form controls so an AI controller can decide the next action.
- Clicks controls, fills prompts, and uploads reference images.
- Captures screenshots and saves browser downloads (including MP4 files when the site exposes a normal download).
- Uses one browser session at a time to avoid conflicting actions.

## Run

Requires Docker with the Playwright image, or Node.js 20+ with the matching Playwright Chromium browser installed.

```sh
cd browser-agent
cp .env.example .env
# Set BROWSER_AGENT_TOKEN to a long random secret.
npm install
npx playwright install chromium
npm start
```

For the most reproducible setup:

```sh
docker build -t joyverse-browser-agent .
docker run --rm -p 8080:8080 -e BROWSER_AGENT_TOKEN="$BROWSER_AGENT_TOKEN" joyverse-browser-agent
```

## API

All `/api/*` routes require `Authorization: Bearer <BROWSER_AGENT_TOKEN>`.

- `POST /api/navigate` — `{"url":"https://example.com"}`
- `GET /api/snapshot` — page text and visible controls
- `POST /api/fill` — `{"selector":"textarea","value":"..."}`
- `POST /api/click` — `{"selector":"button[type=submit]"}` or `{"text":"Generate"}`
- `POST /api/upload` — `{"selector":"input[type=file]","filename":"ref.png","contentBase64":"..."}`
- `POST /api/screenshot` — returns a base64 JPEG
- `POST /api/click-download` — `{\"selector\":\"button.download\"}` clicks a site download button and saves its browser download\n- `POST /api/download` — saves the next normal browser download
- `POST /api/close` — closes the browser session
- `GET /health` — liveness check (no secret)

## Important constraints

This is a browser-control engine, not a source of free GPU compute. A target website must itself offer a free generation path. Provider quotas, queues, sign-in requirements, watermarks, ads, and availability remain controlled by that website. The agent must not bypass CAPTCHAs, paywalls, account checks, ads, or usage limits. If a site requires a human verification step, complete it manually in that site's supported interface.

The service is intended for a private deployment. Do not expose it publicly without HTTPS and a strong secret. Do not send passwords or session cookies to the agent API. Use a dedicated account on target sites where possible.

The API rejects obvious localhost/private-network URL targets as a basic SSRF safeguard. This is not a substitute for network-level egress controls. Downloads and uploads are stored in temporary container storage and may be lost when the host restarts. A free host may sleep, restart, or lack enough RAM for Chromium; reliable always-on operation and unlimited video generation cannot be promised for free.
