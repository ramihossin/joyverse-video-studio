# JoyVerse Scene Studio

Mobile-first scene queue for the JoyVerse Kids workflow. The Studio UI dispatches generation tasks to a server-side queue; a separate worker generates clips, persists them to S3-compatible storage, and assembles the final MP4 on the server.

## Server-backed workflow

1. Add scenes in the browser. Optional reference images are saved in IndexedDB on the phone until dispatch.
2. When the user starts the queue, the browser uploads each reference image to the authenticated bridge, then dispatches the scene and its validated LTX options.
3. PostgreSQL stores each task and its reference-image storage key.
4. The standalone `npm run worker` process claims confirmed video tasks, loads the reference image, calls the LTX-2.5 Gradio Space, and stores the resulting MP4 in S3-compatible storage.
5. The Studio polls task status while open. Closing the browser does not cancel tasks already dispatched to the server.
6. On return, the Studio restores task IDs from browser storage, queries their server status, retrieves stored clips, and can request server-side FFmpeg assembly. The final ID is saved locally and the final MP4 can be fetched again.

The browser does not contain the worker credential. It uses a separate `JOYVERSE_STUDIO_TOKEN` configured privately on the bridge and entered by the user in the Studio connection panel. That token is held in session storage only.

## Required server configuration

Configure these values as private environment variables on the bridge host:

- `MCP_ACCESS_TOKEN`: existing MCP/API secret (at least 32 characters).
- `HERMES_WORKER_TOKEN`: separate secret used only by the background worker and internal worker endpoints.
- `JOYVERSE_STUDIO_TOKEN`: separate strong secret entered into the Studio UI; do not commit it.
- `DATABASE_URL`: PostgreSQL connection string for durable tasks.
- `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION` (optional), `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY`; `OBJECT_STORAGE_FORCE_PATH_STYLE` is optional. Cloudflare R2 aliases are also accepted: `R2_BUCKET`, `R2_ENDPOINT` or `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and optional `R2_REGION`.
- `HF_TOKEN` (optional): Hugging Face token for the server-side LTX provider.
- `STUDIO_ALLOWED_ORIGINS` (optional): comma-separated exact HTTPS origins. Defaults include the project GitHub Pages and Render static-site origins.

The Studio's default bridge URL is `https://joyverse-mcp-bridge.onrender.com`. Enter the same `JOYVERSE_STUDIO_TOKEN` value in the Studio's connection panel. Never put `HERMES_WORKER_TOKEN`, AWS credentials, or `HF_TOKEN` in browser JavaScript or GitHub Pages.

## Worker process and persistence caveats

- The API process and `npm run worker` are separate processes. The worker must be deployed and running continuously on a host that supports a persistent background process.
- A sleeping/free web service does not guarantee background execution. A separate persistent worker host may be required; no keep-alive workaround is assumed.
- PostgreSQL and S3-compatible storage must be configured before tasks can survive service restarts and before reference images, clips, or final MP4s can be stored durably.
- The current Gradio submission iterator is process-local. If the worker dies after submitting to Gradio but before persisting a resumable provider job ID, automatic resubmission is blocked to avoid duplicate generation/quota use.
- A successful dispatch response means the task was accepted by the queue, not that a video has completed. The Studio only marks a scene complete after reading the persisted task result.
- Browser-side scene metadata is kept in local storage and reference blobs in IndexedDB until uploaded. After dispatch, the server-side task and object storage are the durable source of truth. The browser token is session-only and must be re-entered in a new browser session.

## Provider and cost policy

- The server worker calls the public `Lightricks/LTX-2.5` Gradio Space through `@gradio/client`.
- It does not use LoreMotion, TinyFish, or a paid provider API.
- Public Space capacity, queue time, uptime, and free access are controlled by the provider and are not guaranteed.
- The app does not bypass provider queues, account checks, ads, or limits and does not silently switch to a paid model.
- Prompts and reference images are sent to the external model provider. Do not upload private or sensitive images.

## Development

- Static frontend: `web/`; no build step is required.
- Bridge API: `bridge/server.js`.
- Worker command: `npm run worker`.
- Tests: `npm test`.
- Browser acceptance tests: `npx playwright test`.
- GitHub Pages deployment is configured in `.github/workflows/pages.yml`.


## GitHub Actions worker option

A scheduled one-task worker can run without keeping the Android browser open. Configure repository Actions secrets named `DATABASE_URL`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY`; optionally add `OBJECT_STORAGE_REGION` and `HF_TOKEN`. The scheduled workflow uses the free GitHub-hosted runner allowance and processes one queued scene per run. It is not a permanent always-on server: GitHub scheduling is best-effort, jobs have a maximum runtime, and provider outages or a job timeout can leave a task failed rather than safely resumable. It does not bypass LTX provider limits or guarantee free GPU capacity.
