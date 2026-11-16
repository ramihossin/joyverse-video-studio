# JoyVerse Scene Studio

Mobile-first scene queue for the JoyVerse Kids workflow. The Studio UI dispatches generation tasks to a server-side queue; a separate worker generates clips, persists them to S3-compatible storage, and assembles the final MP4 on the server.

## Server-backed workflow

1. Add scenes in the browser. Optional reference images are saved in IndexedDB on the phone until dispatch.
2. When the user starts the queue, the browser uploads each reference image to the authenticated bridge, then dispatches the scene and its validated LTX options.
3. PostgreSQL stores each task and its reference-image storage key.
4. The current Render bridge starts its background video worker inside the API service. It claims confirmed video tasks, uploads any reference image to the LTX-2.5 Gradio Space, calls the real `/run` generation endpoint, downloads the MP4, and stores it in S3-compatible storage. The standalone `npm run worker` command is available when deliberately hosting a separate worker.
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

- In the current Render deployment, the API and one scene worker share the same Free web service. A scene dispatch starts one task immediately; the scheduled GitHub Actions tick starts at most one additional task. The API does not run a permanent database-polling loop while idle.
- GitHub Actions checks the queue every ten minutes. This is inside Render Free's 15-minute idle window, so the bridge normally remains awake; scheduled workflows are best-effort and may be delayed. A long delay can suspend the service during generation, in which case the task is failed safely rather than silently submitted twice.
- The ten-minute idle interval also leaves more than five minutes without database queries between empty-queue checks, allowing Neon Free Postgres to scale its compute to zero while idle. During an active generation, task heartbeats keep the database available.
- Render grants 750 Free instance hours per workspace each month. Keeping this bridge awake continuously uses about 720 hours in a 30-day month, leaving little room for other active Free web services. Monitor workspace usage in Render.
- The Render Free Postgres database is temporary and expires 30 days after creation. Migrate task records and stored objects to a durable free database/object store before the current database expires.
- PostgreSQL is required for durable tasks. Without S3/R2 settings, reference images, clips, and final MP4s use a PostgreSQL BYTEA table with a 50 MiB per-object limit. This fallback is only for small tests; a 1-minute episode or multiple scenes may exceed it.
- A practical $0 migration target is Neon Free Postgres for task metadata and Cloudflare R2 Standard for media. Neon Free currently provides 1 GB per project and 100 compute-hours per month; its compute scales to zero after five minutes idle. R2 includes 10 GB-month storage, 1 million Class A operations, 10 million Class B operations, and free egress. Keep usage within those quotas; usage above free allowances can be billable.
- The LTX Gradio request does not expose a durable provider job ID to this worker. If the worker restarts after submitting a request, the task is failed safely instead of submitting again and potentially consuming a second free GPU quota. Check the Space before manually retrying such a task.
- A successful dispatch response means the task was accepted by the queue, not that a video has completed. The Studio only marks a scene complete after reading the persisted task result.
- LTX-2.5 accepts 1–5 second clips. The Studio therefore limits LTX scene durations to that range and defaults to 16:9 for standard YouTube videos.
- Browser-side scene metadata is kept in local storage and reference blobs in IndexedDB until uploaded. After dispatch, the server-side task and object storage are the durable source of truth. The browser token is session-only and must be re-entered in a new browser session.

## Provider and cost policy

- The server worker calls the public `Lightricks/LTX-2.5` Gradio Space through `@gradio/client` and downloads the MP4 returned by its `/run` endpoint. It does not generate placeholder videos with FFmpeg.
- It does not use LoreMotion, TinyFish, or a paid provider API.
- Public Space capacity, queue time, uptime, and free access are controlled by the provider and are not guaranteed.
- LTX is the default provider even when an Agnes API key happens to exist in the environment. Agnes is used only when `VIDEO_PROVIDER=agnes` is explicitly configured. The app does not bypass provider queues, account checks, ads, or limits.
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


## One-time Render to Neon + R2 migration

The current Render Free Postgres database is temporary. Use this controlled migration before its expiry. The migration copies task rows and device-command rows to Neon, copies every object referenced by tasks/commands (and all rows in `joyverse_objects`) to a new R2 bucket, and verifies every copied object's SHA-256 hash. The source database and source objects are never deleted.

### Required private Render environment variables

Create a new Neon project and a new, empty Cloudflare R2 Standard bucket. Add these variables to the existing `joyverse-mcp-bridge` service. Do not place credentials in GitHub, this repository, prompts, or browser JavaScript.

- `MIGRATION_TARGET_DATABASE_URL`: Neon pooled PostgreSQL connection string (SSL enabled).
- `MIGRATION_R2_ACCOUNT_ID`: Cloudflare account ID.
- `MIGRATION_R2_BUCKET`: the new, empty R2 bucket name.
- `MIGRATION_R2_ACCESS_KEY_ID`: R2 S3 access key ID.
- `MIGRATION_R2_SECRET_ACCESS_KEY`: R2 S3 secret access key.
- Optional `MIGRATION_R2_ENDPOINT`: full HTTPS R2 S3 endpoint; otherwise it is built from the account ID.

The migration endpoint keeps using the existing `DATABASE_URL` as the source. It does not switch the live service automatically.

### Run and verify the migration

1. Wait until the bridge has deployed the migration code from the main branch.
2. In GitHub, open **Actions → JoyVerse storage migration → Run workflow** on the `main` branch.
3. Run the `plan` action first. It tests target connectivity and reports task, command, and object counts and estimated sizes. It does not copy or modify data.
4. Run the `migrate` action only when the video queue is empty. It freezes API writes during the snapshot, refuses a non-empty destination database on the first run, copies all task and command records, moves referenced media to R2, verifies each object byte-for-byte, and writes a migration marker.
5. Confirm the workflow reports `migrated: true`, source preservation, and the expected counts. Any failure leaves the old database active; object uploads that completed before a failure can safely be overwritten on a retry.

The migration has conservative free-tier safety ceilings of 750 MiB for task/command metadata and 9.5 GB for media. These are guardrails, not a promise that an account has that much quota remaining; existing Neon/R2 usage also matters.

### Manual cutover (after a successful migration only)

On the existing bridge service, change the active variables to the destination values:

- Set `DATABASE_URL` to the Neon connection string.
- Set `OBJECT_STORAGE_BUCKET` to the new R2 bucket.
- Set `OBJECT_STORAGE_ENDPOINT` to `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
- Set `OBJECT_STORAGE_ACCESS_KEY_ID` and `OBJECT_STORAGE_SECRET_ACCESS_KEY` to the R2 keys.
- Set `OBJECT_STORAGE_REGION=auto`.

Keep the old Render Postgres database and its original credentials available until the new deployment passes a real task-status lookup, reference-image retrieval, generated-MP4 download, and final-video assembly test. The migration endpoint deliberately does not change Render environment variables or delete the source database.
