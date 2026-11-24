# JoyVerse Scene Studio

Mobile-first Arabic studio for building JoyVerse video scenes, generating clips, tracking durable jobs, and assembling a final MP4 with narration and music.

## Server-backed workflow

1. Add scenes in the browser. Optional reference images are held in IndexedDB until dispatch.
2. The browser uploads reference images to the authenticated bridge and dispatches validated scene tasks.
3. PostgreSQL stores task state and provider checkpoints. S3-compatible storage stores reference images, generated clips, staged audio, and final MP4 files.
4. The worker selects a video provider through `VIDEO_PROVIDER`, generates a real clip, validates the returned MP4, and persists it. A task is not complete until its output is stored.
5. The Studio polls server-side task status. Closing the browser does not cancel dispatched tasks.
6. The Studio can restore task IDs, retrieve stored clips, and request server-side FFmpeg assembly.
7. Final assembly can mix up to four uploaded/generated audio tracks and optionally add an original procedural music bed.

The browser does not contain the worker credential. It uses a separate `JOYVERSE_STUDIO_TOKEN` configured privately on the bridge and entered in the Studio connection panel. The token is held in session storage only.

## Video providers

Choose a provider on the server; never put provider credentials in browser code.

- `VIDEO_PROVIDER=ltx` (default): public LTX-2.5 Gradio Space. The public ZeroGPU quota can be exhausted and is shared; availability and queue time are not guaranteed.
- `VIDEO_PROVIDER=niftyvid-wan`: public Wan 2.2 image-to-video Space. It requires a reference image, is limited to short clips (up to 4.5 seconds in the tested client path), and uses shared ZeroGPU capacity. It is not an unlimited text-to-video service.
- `VIDEO_PROVIDER=agnes`: Agnes Flash provider. It requires a valid account API key and is not enabled by default. Do not assume a free offer is permanent.

The Wan 2.2 provider has completed one real anonymous smoke test using a synthetic reference frame. That test proves the public route can return an MP4; it does not prove JoyVerse character continuity or guaranteed future availability.

## Audio pipeline

### Voiceover

The Studio can generate a short English voiceover through the public Kokoro CPU Space:

- API route: `POST /api/hermes/voiceover`
- JSON fields: `text` (1–500 characters), `voice`, and `speed` (0.5–2.0).
- Default voice: `af_heart`; other supported voices are exposed in the UI.
- The bridge downloads and validates a WAV file, then stages it in object storage as an audio asset.
- The default Space is `https://robinsaiworld-kokoro-tts-cpu.hf.space`. Override with the private environment variable `KOKORO_TTS_SPACE_URL` if needed.

A live GitHub Actions acceptance test has generated and downloaded a real WAV through the same provider adapter used by the bridge. The Space is public and keyless, but CPU queue availability and uptime are provider-controlled; do not describe it as unlimited or guaranteed.

### Uploaded audio

- API route: `POST /api/hermes/audio-upload`
- Send raw audio bytes with an audio Content-Type.
- Maximum file size: 25 MiB.
- Supported formats: WAV, MP3, M4A, AAC, OGG, and FLAC.
- The bridge validates file signatures before storing the audio asset.

### Original background music

The Studio can generate a simple original procedural music bed without an external music API or credits:

- Styles: `cheerful`, `adventure`, and `gentle`.
- Duration: 1–600 seconds.
- Stereo PCM WAV at 16 kHz.
- This is algorithmically synthesized music, not a neural music-generation model.

### Final assembly

The authenticated assembly route accepts:

- `task_ids`: completed scene task IDs.
- `audio_keys`: up to four staged audio assets.
- `background_music`: optional boolean.
- `music_style`: `cheerful`, `adventure`, or `gentle`.

FFmpeg concatenates the scene MP4s, mixes supplied audio tracks, pads the audio to the video duration, and validates the final MP4 container. The Studio can then retrieve the final file.

## Required server configuration

Configure these values as private environment variables on the bridge host:

- `MCP_ACCESS_TOKEN`: existing MCP/API secret (at least 32 characters).
- `HERMES_WORKER_TOKEN`: separate secret used only by the background worker and internal worker endpoints.
- `JOYVERSE_STUDIO_TOKEN`: separate strong secret entered into the Studio UI; do not commit it.
- `DATABASE_URL`: PostgreSQL connection string for durable tasks.
- Optional S3-compatible storage: `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY`; Cloudflare R2 aliases are accepted. Without S3/R2 settings, objects are stored in PostgreSQL (50 MiB maximum per object), which is only a small-test fallback.
- `HF_TOKEN` (optional): Hugging Face token for providers that require it.
- `KOKORO_TTS_SPACE_URL` (optional): public Kokoro Space URL; the tested CPU Space is the default.
- `STUDIO_ALLOWED_ORIGINS` (optional): comma-separated exact HTTPS origins. Defaults include the project GitHub Pages and Render static-site origins.
- `VIDEO_PROVIDER` (optional): `ltx`, `niftyvid-wan`, or `agnes`.

The Studio's default bridge URL is `https://joyverse-mcp-bridge.onrender.com`. Enter the same `JOYVERSE_STUDIO_TOKEN` value in the Studio connection panel. Never put `HERMES_WORKER_TOKEN`, object-storage credentials, or provider secrets in browser JavaScript or GitHub Pages.

## Worker process and persistence caveats

- In the current Render deployment, the API and one scene worker share the same Free web service. A scene dispatch starts one task immediately; the scheduled GitHub Actions tick starts at most one additional task.
- GitHub Actions scheduling is best-effort and may be delayed. A long delay can suspend a Render Free service during generation; the worker must fail safely rather than silently submit a duplicate provider job.
- The Render Free Postgres database is temporary and expires 30 days after creation. Migrate task records and stored objects to a durable free database/object store before expiry.
- PostgreSQL BYTEA fallback is limited to 50 MiB per object; use S3/R2 for actual episodes.
- LTX public requests may not expose a durable provider job ID. If a worker restarts after submission, the task is failed safely rather than resubmitted and potentially consuming another free GPU run.
- Wan 2.2 uses a public shared GPU queue. The provider adapter persists its event ID so a worker can resume polling instead of submitting a duplicate job.
- A successful dispatch response means the task was accepted by the queue, not that a video has completed. The Studio only marks a scene complete after the stored task result is available.
- Prompts, reference images, and narration text are sent to external generation providers. Do not upload private or sensitive material.

## Development

- Static frontend: `web/`; no build step is required.
- Bridge API: `bridge/server.js`.
- Worker command: `npm run worker`.
- Tests: `npm test`.
- Browser acceptance tests: `npx playwright test`.
- GitHub Pages deployment is configured in `.github/workflows/pages.yml`.

## Implementation status

The new Wan/Kokoro/audio integration is being developed in PR #54 on branch `fix/agnes-resumable-video-jobs`. It has not been merged into `main` or deployed to the live bridge. The production branch and live service configuration remain unchanged until the implementation is accepted and deployed.
