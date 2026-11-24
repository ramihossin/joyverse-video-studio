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
- Main production branch remains `main`; this state baseline is being added on an isolated operations branch.

## Completed
- Repository and default branch inspected through the connected GitHub integration.
- README and implementation inspected for frontend, bridge, worker, provider, task store, and MP4 assembler.
- Isolated branch `ops/project-state-baseline-2026-11-25` created from `main`.
- This authoritative state file is being added to that branch.
- Existing application already includes scene dispatch, task polling/recovery, result retrieval, and assembly UI (per source inspection).

## Verified
- Live public Studio page loaded in a browser automation run; visible title: `JoyVerse Scene Studio`; no visible page error.
- Live bridge health endpoint returned HTTP 200 and JSON `ok: true`; service identified as `joyverse-macrodroid-bridge`.
- GitHub integration can list the user's repositories and read source files from `ramihossin/joyverse-video-studio`.
- The public bridge required a cold start before health returned 200.
- Not yet verified in this run: authenticated Studio-to-bridge connection, actual LTX generation, persisted clip retrieval, multi-clip MP4 assembly, final MP4 playback, or Android-device behavior.

## Failed
- Previous prototype-only approach did not meet the actual project goal; it was not a real AI video-generation system.
- Browser health checks through the ordinary web-open route returned an internal access error; a live browser automation check succeeded instead.
- No live generation was attempted because the connected fal catalog did not identify a model satisfying a strict $0 budget, and the public LTX route's free capacity is not guaranteed. No paid job was submitted.
- Earlier Library persistence upload for the project archive/state was blocked by the account Library storage limit. Existing Library files were not deleted.

## Current State
- The real project is the GitHub repository `ramihossin/joyverse-video-studio`, not the standalone local planner prototype.
- The public frontend and bridge health endpoint are reachable.
- The generation/assembly architecture exists in source, but an end-to-end real-video run has not been proven in this execution.
- Production branch `main` and live service configuration have not been modified in this operation.
- This branch contains the project-state baseline; it is not yet merged into production.

## Next Action
1. Inspect the complete GitHub Actions workflows and automated test inventory.
2. Run or reproduce the project's unit/integration checks without touching production secrets.
3. Validate bridge authentication and queue APIs without submitting a generation task.
4. Verify storage and assembly behavior using synthetic test media in a non-production test path.
5. Only then attempt a single free-provider video smoke test if the endpoint is demonstrably free and the required authorization is already available; otherwise document the exact blocker.
6. Update this file and CHANGELOG with each verified result.
