# JoyVerse Scene Studio

Mobile-first scene queue for the JoyVerse Kids workflow. The Studio UI dispatches generation tasks to a server-side queue; a separate worker generates clips, persists them to S3-compatible storage, and assembles the final MP4 on the server.

## Server-backed workflow

1. Add scenes in the browser. Optional reference images are saved in IndexedDB on the phone until dispatch.
2. When the user starts the queue, the browser uploads each reference image to the authenticated bridge, then dispatches the scene and its validated LTX options.
3. PostgreSQL stores each task and its reference-image storage key.
4. The standalone `npm run worker` process claims confirmed video tasks, uploads any reference image to the LTX-2.5 Gradio Space, calls its real `/run` generation endpoint, downloads the returned MP4, and stores it in S3-compatible storage.
5. The Studio polls task status while open. Closing the browser does not cancel tasks already dispatched to the server.
6. On return, the Studio restores task IDs from browser storage, queries their server status, retrieves stored clips, and can request server-side FFmpeg assembly. The final ID is saved locally and the final MP4 can be fetched again.

The browser does not contain the worker credential. It uses a separate `JOYVERSE_STUDIO_TOKEN` configured privately on the bridge and entered by the user in the Studio connection panel. That token is held in session storage only.

## Required server configuration

Configure these values as private environment variables on the bridge host:

- `MCP_ACCESS_TOKEN`: existing MCP/API secret (at least 32 characters).
- `HERMES_WORKER_TOKEN`: separate secret used only by the background worker and internal worker endpoints.
- `JOYVERSE_STUDIO_TOKEN`: separate strong secret entered into the Studio UI; do not commit it.
- `DATABASE_URL`: PostgreSQL connection string for durable tasks.
- Optional S3-compatible storage: `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY`; Cloudflare R2 aliases are accepted. If no S3/R2 settings are supplied, objects are stored in PostgreSQL automatically (50 MiB maximum per object). This is a temporary fallback for small tests, not a long-term video archive.
- `HF_TOKEN` (optional): Hugging Face token for the server-side LTX provider.
- `STUDIO_ALLOWED_ORIGINS` (optional): comma-separated exact HTTPS origins. Defaults include the project GitHub Pages and Render static-site origins.

The Studio's default bridge URL is `https://joyverse-mcp-bridge.onrender.com`. Enter the same `JOYVERSE_STUDIO_TOKEN` value in the Studio's connection panel. Never put `HERMES_WORKER_TOKEN`, AWS credentials, or `HF_TOKEN` in browser JavaScript or GitHub Pages.

## Worker process and persistence caveats

- The API process and `npm run worker` are separate processes. The worker must be deployed and running continuously on a host that supports a persistent background process.
- A sleeping/free web service does not guarantee background execution. A separate persistent worker host may be required; no keep-alive workaround is assumed.
- PostgreSQL is required for durable tasks. Without S3/R2 settings, reference images, clips, and final MP4s use a PostgreSQL BYTEA table with a 50 MiB per-object limit. Use private object storage for production and larger videos.
- The LTX Gradio request does not expose a durable provider job ID to this worker. If the worker restarts after submitting a request, the task is failed safely instead of submitting again and potentially consuming a second free GPU quota. Check the Space before manually retrying such a task.
- A successful dispatch response means the task was accepted by the queue, not that a video has completed. The Studio only marks a scene complete after reading the persisted task result.
- Browser-side scene metadata is kept in local storage and reference blobs in IndexedDB until uploaded. After dispatch, the server-side task and object storage are the durable source of truth. The browser token is session-only and must be re-entered in a new browser session.

## Provider and cost policy

- The server worker calls the public `Lightricks/LTX-2.5` Gradio Space through `@gradio/client` and downloads the MP4 returned by its `/run` endpoint. It does not generate placeholder videos with FFmpeg.
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

A scheduled one-task worker can run without keeping the Android browser open. Configure the repository Actions secret `DATABASE_URL`. S3/R2 secrets are optional for testing: without them the worker uses PostgreSQL object storage (50 MiB maximum per object). For production, configure the S3/R2 bucket, endpoint, access key, and secret key; optionally add `OBJECT_STORAGE_REGION` and `HF_TOKEN`. The scheduled workflow uses the free GitHub-hosted runner allowance and processes one queued scene per run. It is not a permanent always-on server: GitHub scheduling is best-effort, jobs have a maximum runtime, and provider outages or a job timeout can leave a task failed rather than safely resumable. It does not bypass LTX provider limits or guarantee free GPU capacity.
