# JoyVerse Browser Agent

A private, mobile-friendly Playwright browser agent for operating selected video-generation websites. It supports user-controlled login, encrypted per-site session persistence, configurable generation selectors, reference-image upload, screenshots, and one-click generation/download workflows.

## User workflow

1. Deploy the service privately and open its dashboard at `/` on your Android phone.
2. Enter the private `BROWSER_AGENT_TOKEN` in the dashboard.
3. Add a site profile with its base URL and, when needed, the sign-in URL and additional identity-provider hostnames.
4. Open that site's remote browser. Complete sign-in yourself, including any email code, authenticator code, or CAPTCHA presented by the provider.
5. Press **Save encrypted login session**. The agent stores an encrypted Playwright storage snapshot, including cookies, local storage, IndexedDB and OPFS where supported, plus per-origin sessionStorage across open tabs.
6. Inspect the page and set the CSS selectors for the prompt field, optional image upload, Generate button, ready/result element, and Download button. Save the profile.
7. For later runs, select the site, enter a prompt, optionally upload a reference image, and press **Generate video and download**.

Each site has its own profile and encrypted browser session. The dashboard does not ask you to paste your website password into a separate form; you operate the remote browser directly. The agent does not log typed values or expose session tokens through its API responses.

## Persistence and encryption

- Saved browser sessions are encrypted with AES-256-GCM before storage. The encryption key is never written to the repository.
- **Recommended for hosted deployments:** configure `DATABASE_URL` to a durable PostgreSQL database and set `SESSION_ENCRYPTION_KEY` to a random 32-byte key (base64 or 64-character hex). The app creates its own `joyverse_browser_sites` and `joyverse_browser_sessions` tables.
- Generate a key with `openssl rand -base64 32`. Store it only as a private host secret. Losing or changing this key makes previously saved sessions unreadable.
- Without PostgreSQL, the app saves profiles, encrypted sessions, and the local master key in `DATA_DIR`. This directory must be on a persistent disk or all saved sessions will be lost when the host replaces its container.
- Downloaded videos are saved below `DOWNLOAD_DIR`. For long-term retention, download each result to your phone or configure a persistent directory.

## Run locally or in a private Docker host

Requires Docker, or Node.js 20+ and the matching Playwright Chromium browser.

```sh
cd browser-agent
cp .env.example .env
# Set BROWSER_AGENT_TOKEN to a secret with at least 32 characters.
# Set DATABASE_URL and SESSION_ENCRYPTION_KEY for durable hosted sessions.
npm install
npx playwright install chromium
npm start
```

Docker:

```sh
docker build -t joyverse-browser-agent .
docker run --rm --init --ipc=host --user pwuser \
  --security-opt seccomp=./seccomp_profile.json \
  -p 8080:8080 \
  -e BROWSER_AGENT_TOKEN="$BROWSER_AGENT_TOKEN" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e SESSION_ENCRYPTION_KEY="$SESSION_ENCRYPTION_KEY" \
  -e DATA_DIR=/data \
  -v joyverse-agent-data:/data \
  joyverse-browser-agent
```

Open `http://localhost:8080` and use the dashboard.

## Authenticated API

Every `/api/*` route requires `Authorization: Bearer <BROWSER_AGENT_TOKEN>`.

- `GET /api/sites` — list configured sites and whether a saved session exists.
- `POST /api/sites`, `PUT /api/sites/:id`, `DELETE /api/sites/:id` — manage site profiles.
- `POST /api/sites/:id/open` — open a site and restore its saved session.
- `GET /api/browser/screenshot`, `GET /api/browser/snapshot` — inspect the remote browser.
- `POST /api/browser/click`, `POST /api/browser/type`, `POST /api/browser/key`, `POST /api/browser/scroll` — remote user interaction.
- `POST /api/browser/save-session` — encrypt and persist the current site's login session.
- `POST /api/generate` — start a one-click generation job.
- `GET /api/jobs/:id` — poll job state.
- `GET /api/downloads/:id` — fetch the generated file.
- `DELETE /api/sites/:id/session` — remove the saved login session for one site.
- `GET /health` — liveness and persistence mode.

A generation profile must specify selectors for the prompt field, Generate button, a result-ready element, and Download button. An optional file input selector enables reference-image upload. Selectors are CSS selectors interpreted by Playwright; the dashboard can inspect a page and suggest selectors.

## Security boundaries

- Use HTTPS and keep the service private. Use a unique high-entropy `BROWSER_AGENT_TOKEN`.
- Never commit secrets, cookies, exported storage state, passwords, or encryption keys to GitHub.
- Session snapshots contain authentication cookies and tokens; treat them as sensitive credentials. They are encrypted at rest, but users with access to both the database and encryption key can decrypt them.
- The remote browser is controlled only through the authenticated dashboard/API. Use a dedicated account on generation sites where possible.
- The browser rejects obvious private-network destinations for direct navigation and blocks requests to private/local address ranges. This is a safeguard, not a substitute for network-level egress controls or DNS-rebinding protection.
- CAPTCHA, MFA, email verification, age requirements, account checks, ads, queues, paywalls, and provider quotas remain under the site's control. The user completes human verification in the visible remote-browser preview; the agent does not bypass those controls.
- Sites may expire or revoke sessions, change their UI, prohibit automation, or require a fresh login. A saved session is best-effort and does not guarantee permanent access.
- Site selectors must be configured for the actual UI. If a provider changes its website, update the selectors before using one-click generation.
- Generation is free only when the selected provider itself offers a free path. This project does not supply GPU compute or bypass limits.
- A free hosting plan may sleep, restart, or have ephemeral storage. For saved sessions, a durable PostgreSQL database plus a separately stored encryption key is recommended; a durable volume is required for local-file mode.

## Development

```sh
npm install
npm test
node --check server.js
node --check store.js
```
