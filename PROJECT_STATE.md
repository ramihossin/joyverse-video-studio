# PROJECT_STATE — JoyVerse Video Studio

Last updated: 2026-11-25
Authoritative branch: `ops/project-state-baseline-2026-11-25`
Baseline branch: `main`
Repository: `ramihossin/joyverse-video-studio`

## Project Goal
Deliver a reliable, Android-accessible AI video-production workflow that takes a project from story and scene planning through real AI clip generation, durable task tracking, clip retrieval, MP4 assembly, quality checks, and final downloadable video. ChatGPT is intended to direct the workflow where supported. A submitted task is not a completed video.

## Scope
- Mobile-first Arabic JoyVerse Scene Studio.
- Scene queue with prompt, duration, aspect ratio, and optional reference images.
- Server-side authenticated task dispatch.
- Durable PostgreSQL task queue and object storage.
- Free-provider-first video generation adapter (currently LTX Gradio Space).
- Worker checkpoints, heartbeats, safe failure handling, and result persistence.
- Server-side FFmpeg MP4 assembly and retrieval.
- Project-state, changelog, operational diagnostics, and end-to-end acceptance tests.
- Future: automated story/shot planning, character/reference continuity checks, audio pipeline, full episode assembly, and ChatGPT orchestration.

## Constraints
- Android-first operation; user should not perform technical setup that can be automated.
- Prefer genuinely free options. Never submit paid generation jobs or enable paid infrastructure without explicit user approval.
- Public free model capacity, availability, queue time, and quotas are not guaranteed.
- Keep credentials server-side; browser may only hold the dedicated studio token in session storage.
- Never expose worker/API secrets or commit credentials.
- Distinguish accepted, queued, generating, persisted, assembled, and verified states.
- Avoid duplicate provider submissions when provider job resumption is unavailable.
- Do not change production services, secrets, databases, or deployment configuration without explicit authorization where required.

## Architecture
- Frontend: static mobile-first app in `web/`, deployed through GitHub Pages.
- API/MCP bridge: Node.js + Express + MCP in `bridge/server.js`.
- Task state: PostgreSQL via `bridge/task-store.js`.
- Media storage: S3-compatible object storage; PostgreSQL BYTEA fallback is documented as limited.
- Generation: `bridge/video-worker.js` selects LTX Gradio by default; Agnes is opt-in only when configured.
- LTX adapter: `bridge/ltx-gradio-video-provider.js`, using the public Lightricks/LTX-2.5 Gradio Space.
- Assembly: `bridge/ffmpeg-assembler.js` produces MP4.
- Deployment: GitHub Pages workflow plus Render bridge and GitHub Actions worker workflow.
- Main production branch remains `main`; this state baseline is isolated in the operations branch.

## Completed
- Repository and default branch inspected through the connected GitHub integration.
- README and implementation inspected for frontend, bridge, worker, provider, task store, and MP4 assembler.
- Isolated branch `ops/project-state-baseline-2026-11-25` created from `main`.
- Authoritative project state and changelog created on that branch.
- Existing application includes scene dispatch, task polling/recovery, result retrieval, and assembly UI (source inspection).
- A draft documentation PR was opened: #53.

## Verified
- Live public Studio page loaded in browser automation; visible title: `JoyVerse Scene Studio`; no visible page error.
- Live bridge health endpoint returned HTTP 200 and JSON `ok: true`; service identified as `joyverse-macrodroid-bridge`.
- Public Lightricks/LTX-2.5 Space loaded and displayed Running status.
- One controlled, 1-second public LTX smoke test was submitted with a harmless test prompt. The UI returned `You have exceeded your ZeroGPU runs limit`; no video file was produced. This confirms the provider UI is reachable but the free generation quota available to this browser/session is exhausted.
- GitHub integration can list repositories and read source files from `ramihossin/joyverse-video-studio`.
- The public bridge required a cold start before health returned 200.

## Failed
- Previous prototype-only approach did not meet the actual project goal; it was not a real AI video-generation system.
- Ordinary web-open checks of the public health endpoint returned an internal access error; browser automation succeeded instead.
- The LTX-2.5 public Space generation smoke test failed because the free ZeroGPU run quota was exhausted. No output video was created.
- Flyne's no-signup form could be filled, but generation was blocked by Cloudflare Turnstile verification. No attempt was made to bypass it and no output video was created.
- AIFree's free Wan visitor workflow also reached Cloudflare human verification before generation. No attempt was made to bypass it and no output video was created.
- fal catalog selection found no text-to-video candidate that met a strict $0 budget. No paid API request was submitted.
- Earlier Library persistence upload for the project archive/state was blocked by the account Library storage limit. Existing Library files were not deleted.
- Chromium headless smoke test on the separate local prototype timed out; that prototype is not the authoritative project.

## Current State
- The authoritative project is `ramihossin/joyverse-video-studio`.
- The public frontend and bridge health endpoint are reachable.
- The LTX public demo is currently up, but its free ZeroGPU run quota was exhausted during the single smoke test.
- Advertised-free providers Flyne and AIFree both required Cloudflare human verification at generation time in the tested browser; neither is currently suitable for unattended automation.
- Flyne's public free form was reachable and advertised 5-second 480p outputs with no signup; the single smoke attempt stopped at a Cloudflare Turnstile human-verification prompt. No challenge was bypassed and no clip was generated.
- AIFree's public Wan 2.2 form loaded without login and advertised approximately 5-second 480p silent outputs subject to a daily pool; one generation attempt stopped at a Cloudflare human-verification gate. No challenge was bypassed and no clip was generated.
- Generation, durable clip retrieval, multi-clip MP4 assembly, final MP4 playback, and Android-device behavior have not yet passed an end-to-end acceptance test.
- Production branch `main` and live service configuration have not been modified in this operation.
- Documentation changes are in draft PR #53; they are not merged into `main`.

## Next Action
1. Inspect the full source and deployment history for the current task queue, provider selection, and any already-supported alternate free route.
2. Determine whether the LTX ZeroGPU limit is anonymous-session, account, or shared-space quota without repeatedly submitting jobs.
3. Evaluate alternate public free providers against actual quota, terms, API accessibility, and integration cost; do not claim unlimited access or bypass verification.
4. Reproduce unit tests for provider validation, queue transitions, lease recovery, and MP4 assembly using mocks/synthetic clips without production secrets.
5. Verify authenticated Studio-to-bridge connection only if a safe token is already available through an authorized connector; never expose or request secrets in chat.
6. Update this file and CHANGELOG after each material result.
