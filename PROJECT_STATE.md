# PROJECT_STATE — JoyVerse Video Studio

Last updated: 2026-11-25 (provider recovery implementation)
Authoritative branch: `fix/agnes-resumable-video-jobs`
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
- Added durable provider-job-ID checkpointing to the worker contract so asynchronous providers can resume polling after a worker restart.
- Updated the Agnes Flash adapter to persist and reuse its asynchronous `video_id`, and to avoid duplicate submission when a prior job ID exists.
- Restricted the Agnes adapter to the known free Flash model identifier; paid model identifiers are rejected.
- Added deterministic mocked tests for Agnes text-to-video request schema, MP4 response validation, persisted-job resumption, and safe rejection of unsupported image input.
- Repository and default branch inspected through the connected GitHub integration.
- README and implementation inspected for frontend, bridge, worker, provider, task store, and MP4 assembler.
- Isolated branch `ops/project-state-baseline-2026-11-25` created from `main`.
- Authoritative project state and changelog created on that branch.
- Existing application includes scene dispatch, task polling/recovery, result retrieval, and assembly UI (source inspection).
- A draft documentation PR was opened: #53.

## Verified
- Source-level review confirms the Agnes 2.5 Flash adapter is already present and can be selected explicitly with `VIDEO_PROVIDER=agnes`; LTX remains the default unless configured otherwise.
- Current public API documentation describes the Flash video model as a limited-time free promotion, 720P only, with queue congestion possible; this is not a permanent free-service guarantee.
- Live public Studio page loaded in browser automation; visible title: `JoyVerse Scene Studio`; no visible page error.
- Live bridge health endpoint returned HTTP 200 and JSON `ok: true`; service identified as `joyverse-macrodroid-bridge`.
- Public Lightricks/LTX-2.5 Space loaded and displayed Running status.
- One controlled, 1-second public LTX smoke test was submitted with a harmless test prompt. The UI returned `You have exceeded your ZeroGPU runs limit`; no video file was produced. This confirms the provider UI is reachable but the free generation quota available to this browser/session is exhausted.
- GitHub integration can list repositories and read source files from `ramihossin/joyverse-video-studio`.
- The public bridge required a cold start before health returned 200.

## Failed
- Agnes image-to-video was using the obsolete `img2video` mode and a base64 `first_frame` payload inconsistent with the current documented 2.5-series schema. The adapter now fails clearly before sending that unsupported request; reference-image support still needs a hosted-image URL flow.
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
- The LTX public demo is currently up, but its free ZeroGPU run quota was exhausted during the single smoke test. (Retained historical result.)
- Advertised-free providers Flyne and AIFree both required Cloudflare human verification at generation time in the tested browser; neither is currently suitable for unattended automation.
- Flyne's public free form was reachable and advertised 5-second 480p outputs with no signup; the single smoke attempt stopped at a Cloudflare Turnstile human-verification prompt. No challenge was bypassed and no clip was generated.
- AIFree's public Wan 2.2 form loaded without login and advertised approximately 5-second 480p silent outputs subject to a daily pool; one generation attempt stopped at a Cloudflare human-verification gate. No challenge was bypassed and no clip was generated.
- A real anonymous Wan 2.2 I2V smoke test succeeded through the public ZeroGPU Space. The downloaded artifact was independently inspected with ffprobe: H.264 MP4, 640x640, 16 fps, 3.5625 seconds, 526,822 bytes. The sample is a synthetic golden-star test frame, not a JoyVerse character scene. Durable clip retrieval, multi-clip MP4 assembly, final MP4 playback, and Android-device behavior still need end-to-end acceptance. The Agnes API requires an authenticated API key; no key was exposed to or available in this execution context, and no production secrets were read.
- Production branch `main` and live service configuration have not been modified in this operation.
- Documentation changes are in draft PR #53; they are not merged into `main`.

## Additional Free-Provider Research
- NiftyVid is an open-source no-signup image-to-video client for a public Wan 2.2 ZeroGPU Space. Its documented public path is capped at 4.5 seconds and uses a shared queue; it is image-to-video, not text-to-video. A one-shot GitHub Actions smoke workflow was added on an isolated experiment branch, but the available GitHub connector only exposes pull-request-triggered workflow runs; the push-triggered result/artifact could not be verified through the available query. Do not claim a generated clip.
- The official Pika H3 Flex Hugging Face Space is listed as Running on Zero. An independent November 2026 test reports anonymous text-to-video with sound, but the downloaded file was not byte-verified. The connected Pika API quote for the same model is 5 credits; it was not run, and no credits were spent.

## Next Action
1. Run the full CI suite on the latest PR head and fix any failures.
2. Complete the provider integration acceptance test using a real JoyVerse reference image and verify the resulting clip preserves the reference subject.
3. Test durable storage retrieval and FFmpeg assembly of at least two generated clips into a final MP4; verify playback and audio track handling.
4. Verify the Android web interface can submit a task, track progress, retrieve the final artifact, and download it.
5. Keep the provider opt-in until its public shared-GPU availability and quality are measured across several runs; do not claim unlimited or guaranteed availability.
1. Test the public Pika H3 Flex Space through a no-credit, no-signup route, if a supported direct API path can be verified; do not use the connected Pika API because it quotes 5 credits.
2. Verify whether the isolated NiftyVid push smoke workflow produced an artifact using an API/tool that can list push-triggered runs; if not, use a read-only workflow query before deciding whether to retry generation.
3. If no anonymous provider can be called and downloaded through the available tools, the remaining viable API path is Agnes Flash, which requires an account API key that is not currently configured.
4. Implement a secure hosted-image URL path for Agnes reference mode, then restore image-to-video continuity tests.
5. Continue end-to-end MP4 assembly and Android acceptance tests.

## Previous Next Action
1. Run the repository Node.js test workflow on the implementation PR and repair any failures.
2. Check whether the existing deployment has an authorized Agnes free Flash key configured without reading or exposing secret values; do not change production environment settings or submit a live generation until the selected model and zero-cost route are confirmed.
3. If Agnes is available, run one 4-second text-to-video smoke test, persist the provider job ID, retrieve and validate the MP4, then test assembly.
4. Implement a secure hosted-image URL path for Agnes reference mode, then restore image-to-video continuity tests.
5. Continue the end-to-end and Android acceptance tests.

## Previous Next Action
1. Inspect the full source and deployment history for the current task queue, provider selection, and any already-supported alternate free route.
2. Determine whether the LTX ZeroGPU limit is anonymous-session, account, or shared-space quota without repeatedly submitting jobs.
3. Evaluate alternate public free providers against actual quota, terms, API accessibility, and integration cost; do not claim unlimited access or bypass verification.
4. Reproduce unit tests for provider validation, queue transitions, lease recovery, and MP4 assembly using mocks/synthetic clips without production secrets.
5. Verify authenticated Studio-to-bridge connection only if a safe token is already available through an authorized connector; never expose or request secrets in chat.
6. Update this file and CHANGELOG after each material result.


## Audio pipeline implementation update — 2026-11-25
- Added signature-based validation for uploaded WAV, MP3, M4A, AAC, OGG, and FLAC audio tracks.
- Added optional audio upload controls in the Studio UI, capped at four files and 25 MiB per file.
- Added original procedural background music generation (cheerful, adventure, gentle) in WAV format, with bounded duration and no external API.
- Extended final FFmpeg assembly to mix uploaded audio and optional procedural music.
- Added a Kokoro Gradio TTS provider adapter, authenticated `POST /api/hermes/voiceover` endpoint, and Studio controls for English narration text, voice, and speed. Generated narration is stored as a staged audio asset and included in the final audio mix.
- The Kokoro adapter uses the public CPU Space and the official `@gradio/client` dependency already present in the repository. The endpoint name and output parsing are implemented but have not yet passed a live request.
- A first direct HTTP smoke attempt against the assumed `/gradio_api/call/generate_first` route returned HTTP 404. The failure is an endpoint/protocol mismatch, not a generated-audio validation failure. A second smoke workflow was changed to use Gradio Client API discovery and `predict`, but the available GitHub workflow-run query returned no run for that branch update; execution remains unverified.
- Mocked tests were added for WAV signature detection and Kokoro response validation. They have not yet been executed on the latest implementation head.
- No production deployment, production secret change, paid API call, or paid media generation was performed.

## Current State
- The scene/video generation pipeline and durable assembly architecture remain in place.
- Audio upload, procedural background music, and Kokoro text-to-speech are implemented on the isolated feature branch but not yet end-to-end verified.
- The project is not complete: no full JoyVerse episode has yet been generated, assembled, playback-checked, and downloaded on Android.

## Next Action
1. Obtain a successful, no-cost Kokoro TTS smoke result through the official Gradio Client API; inspect discovered endpoint names instead of assuming REST paths.
2. Run the full Node.js test suite and syntax checks on the latest implementation head; fix all failures.
3. Test a real generated narration WAV through object storage and final FFmpeg mix, including a generated video clip.
4. Re-run a real video generation smoke test only when a no-cost provider route and quota are verified; do not spend credits or bypass human verification.
5. Verify final MP4 playback, audio synchronization, download, and the complete Android Studio workflow.
6. Update this file and CHANGELOG with each verified result.


## Latest automated validation — 2026-11-25
- GitHub Actions on the latest implementation head completed successfully:
  - Node.js tests: 81 passed, 0 failed.
  - Bridge tests: 81 passed, 0 failed.
  - Web browser smoke tests: 9 passed.
  - Worker/server/provider JavaScript syntax checks passed.
- The CI log explicitly confirms both Kokoro provider tests passed, including WAV result validation, trusted-host enforcement, and input validation; procedural music and audio-format tests are included in the passing suite.
- Pull request #54 is open and GitHub reports it mergeable. The branch is 59 commits ahead of `main` and 0 commits behind at the latest comparison.
- The passing tests use mocked Gradio responses. They do not establish that the public Kokoro Space currently accepts a real request.
- The first real Kokoro REST probe returned HTTP 404 because the manually assumed endpoint path was not valid for that Space. The follow-up smoke workflow uses the official Gradio client for endpoint discovery, but no run/result was returned for its latest isolated branch update. Live TTS remains unverified.

## Updated Current State
- Automated repository validation is green for the current implementation branch (81 Node tests, 81 Bridge tests, 9 web browser tests).
- Audio upload, original procedural background music, and Kokoro voiceover generation are implemented and unit-tested.
- A real voiceover file has not yet been generated by the public TTS provider, and no final episode has yet been assembled and verified on Android.


## Media integration verification — 2026-11-25
- Added a real FFmpeg integration test that creates a synthetic H.264 MP4, generates original WAV music, assembles them through the production `assembleMp4` function, then decodes both video and audio streams from the resulting MP4.
- GitHub Actions latest implementation validation passed:
  - Node.js tests: 82 passed, 0 failed.
  - Bridge tests: 82 passed, 0 failed.
  - Real FFmpeg video+audio integration test: passed in both suites.
  - Web browser smoke tests: 9 passed.
- Added a live Kokoro TTS acceptance workflow that uses the official Gradio Python client to discover the endpoint and produce one short WAV without API keys or paid credits. It is on the feature branch; the run has not been triggered or verified because this new workflow is not yet present in the base branch and no workflow-dispatch action is exposed through the connected GitHub tools. It has not been merged into production just to force a test.
- The feature branch is 63 commits ahead of `main`, 0 behind, and PR #54 remains open. No production deployment or merge was performed.

## Current State
- Core video-provider, durable queue, audio staging, procedural music, and server-side FFmpeg assembly code is implemented on the feature branch.
- Automated tests and a real local FFmpeg assembly integration test pass.
- Live Kokoro TTS against the external public Space remains unverified. The provider tests are mocked; the first raw REST attempt returned 404.
- The complete project goal is not yet met: there is no verified final JoyVerse episode generated from real scenes, assembled, playback-checked, and downloaded through Android.

## Next Action
1. Run the live Kokoro acceptance workflow through a supported trigger or test it after a separately authorized deployment; do not merge solely to force the test.
2. Verify a real video provider job on the public free route, then retrieve the MP4 and validate it.
3. Verify the deployed bridge's authenticated object-storage path and final download without exposing secrets or changing production configuration.
4. Perform an end-to-end Android acceptance test for reference upload, scene generation, audio narration/music, final MP4 assembly, playback, and download.
5. Continue recording verified results; do not label the project complete until a real final episode passes the above checks.
