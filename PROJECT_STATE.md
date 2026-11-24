# PROJECT_STATE — JoyVerse Video Studio

Last updated: 2026-11-25
Implementation branch: `fix/agnes-resumable-video-jobs`
Implementation PR: #54
Repository: `ramihossin/joyverse-video-studio`
Production branch: `main` (unchanged)

## Project Goal

Deliver an Android-accessible video-production system that moves from a scene plan to real generated video clips, durable task tracking, voiceover/music, final MP4 assembly, quality checks, and a downloadable result. A queued task or partial clip is not a completed episode.

## Scope

- Arabic, mobile-first JoyVerse Studio.
- Scene prompts, durations, aspect ratios, and optional character/reference images.
- Authenticated API/MCP bridge and durable PostgreSQL task queue.
- Video generation through explicitly selected providers.
- Resumable provider job IDs and durable media storage.
- Text-to-speech voiceover, uploaded audio tracks, original procedural music, and FFmpeg mixing.
- Multi-scene MP4 assembly, retrieval, and final-file validation.
- Story/shot planning automation, character-continuity QA, and full Android acceptance remain to be completed.

## Constraints

- Android-first; avoid assigning technical setup to the user when it can be automated.
- Prefer $0 providers and workflows. Do not submit paid generation jobs, spend credits, or enable paid infrastructure.
- Public free Spaces have shared capacity, queues, changing terms, and no unlimited-availability guarantee.
- Keep all service credentials server-side. Never expose worker, database, storage, or provider secrets in the browser.
- Do not bypass CAPTCHAs, account checks, quotas, or provider access controls.
- Distinguish accepted, queued, generated, stored, assembled, and verified states.
- Do not deploy to production or change production secrets/database configuration as part of this implementation branch.

## Architecture

- Frontend: static mobile-first Arabic application in `web/`, published through GitHub Pages.
- API/MCP bridge: Node.js + Express in `bridge/server.js`.
- Durable tasks: PostgreSQL via `bridge/task-store.js`.
- Media storage: S3-compatible storage; PostgreSQL BYTEA fallback is limited and intended only for small tests.
- Video providers:
  - `ltx` is the default public LTX-2.5 provider.
  - `niftyvid-wan` is an opt-in Wan 2.2 image-to-video provider using a public Gradio Space.
  - `agnes` is opt-in and requires an account API key.
- Voiceover: `bridge/kokoro-tts-provider.js` calls the public Kokoro CPU Space over direct Gradio REST.
- Audio: `bridge/audio-format.js` validates uploaded audio; `bridge/procedural-music.js` creates original WAV music.
- Assembly: `bridge/ffmpeg-assembler.js` concatenates video clips and mixes/pads up to four audio tracks.
- UI exposes scene dispatch, audio upload, Kokoro narration, optional procedural music, and final assembly.

## Completed

- Restored and inspected the existing JoyVerse repository and its real frontend/bridge/worker/storage architecture.
- Added provider job-ID checkpointing and resumable polling to avoid duplicate submissions after worker restarts.
- Added the Wan 2.2 image-to-video adapter with reference-image upload, Gradio SSE handling, output-host validation, MP4 validation, and opt-in provider selection.
- Added the Kokoro CPU TTS adapter using direct REST; the adapter persists the event ID callback, parses the completion event, validates WAV output, and supports resuming an existing event.
- Added authenticated `POST /api/hermes/voiceover` to generate and stage WAV voiceover.
- Added authenticated `POST /api/hermes/audio-upload` for raw WAV/MP3/M4A/AAC/OGG/FLAC uploads (maximum 25 MiB).
- Added file-signature validation for supported audio formats.
- Added original procedural background music in cheerful, adventure, and gentle styles, supporting 1–600 seconds at 16 kHz stereo PCM.
- Extended FFmpeg assembly to mix up to four audio tracks, pad the audio to the video duration, and validate the final MP4.
- Added Studio controls for voiceover text/voice/speed, audio uploads, and optional procedural music.
- Added real FFmpeg integration coverage that creates two synthetic clips, adds generated music through the production assembler, and decodes the final video/audio streams.
- Updated README, changelog, and this project-state record.

## Verified

- Public Studio page loaded in browser automation; visible title was `JoyVerse Scene Studio`.
- Public bridge health endpoint returned HTTP 200 and JSON `ok: true` after cold start.
- One real anonymous Wan 2.2 I2V smoke test produced an MP4. Independent ffprobe inspection: H.264, 640×640, 16 fps, 3.5625 seconds, 526,822 bytes. The input was a synthetic golden-star frame, not a JoyVerse character reference.
- Live Kokoro TTS acceptance workflow passed using the same direct-REST provider adapter as the bridge. Retrieved WAV: PCM 16-bit mono, 24 kHz, 4.2 seconds, 201,644 bytes.
- Local final-media sample was assembled from the Wan smoke clip, a live Kokoro voiceover, and an original procedural music bed. ffprobe verified H.264 video plus AAC audio, 640×640, 7.125 seconds, 766,269 bytes. Local file: `/mnt/data/joyverse-kokoro-voiceover-music-sample.mp4`. This is a technical sample, not a finished JoyVerse episode.
- Latest observed Node.js tests passed, including the real FFmpeg video/audio integration test.
- Latest observed Bridge tests passed.
- Latest live Kokoro acceptance test passed.
- Web browser validation passed on the preceding implementation head; the latest run after the most recent server/music changes is still being checked.

## Failed / Limitations

- The public LTX-2.5 Space rejected one controlled smoke test with `You have exceeded your ZeroGPU runs limit`; no LTX clip was produced in that attempt.
- Flyne and AIFree generation attempts stopped at Cloudflare human-verification gates. No CAPTCHA was bypassed.
- A high-resolution synthetic dragon reference attempt on the Wan Space returned an upstream SSE error with null data. A subsequent runner attempt failed before generation because `ffmpeg` was unavailable; the workflow was changed to use Pillow, but a successful character-reference clip has not been verified.
- Kokoro's public Space has a Gradio API-schema issue for the Python client. The production adapter now uses direct REST, and the live acceptance test passed.
- The current sample uses a synthetic golden-star scene. Character identity consistency for Adam, Lina, and Zeno has not yet been verified.
- Android device behavior, durable storage retrieval through the live bridge, and the complete Studio-to-final-download path have not yet been accepted end to end.
- No provider is claimed to be unlimited or guaranteed free.

## Current State

- PR #54 is open on `fix/agnes-resumable-video-jobs`; the latest branch is mergeable when CI is green.
- New video/audio features are in the implementation branch only. They have not been merged into `main` or deployed to the live bridge.
- The public Wan provider is opt-in; LTX remains the default.
- Kokoro voiceover, uploaded audio, procedural music, and audio-aware assembly are implemented and have passed live/unit/integration checks as described above.
- No paid generation request, credit spend, production secret change, database migration, or production deployment was performed.

## Next Actions

1. Confirm all CI workflows are green on the latest PR head, including web validation, Node tests, Bridge tests, and live Kokoro acceptance.
2. Complete a Wan image-to-video test using a real JoyVerse character reference and verify visual consistency; do not substitute the synthetic smoke frame for that acceptance.
3. Exercise the authenticated Studio flow end to end: dispatch scene → generate → persist → retrieve → generate voiceover → add music → assemble → download.
4. Verify the final video and audio on an Android browser.
5. Keep PR #54 separate from production until the full acceptance checks are complete; do not claim the project is finished before those checks pass.
