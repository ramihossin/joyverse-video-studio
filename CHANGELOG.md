# CHANGELOG

## 2026-11-25
- Added `PROJECT_STATE.md` on isolated branch `ops/project-state-baseline-2026-11-25` as the authoritative operational record.
- Recovered the actual production architecture from `main`: mobile-first Studio, authenticated bridge, PostgreSQL task queue, LTX Gradio provider, object storage, and FFmpeg MP4 assembly.
- Verified the public Studio page loads and the bridge health endpoint returns HTTP 200 after cold start.
- Verified the official public LTX-2.5 Space was running, then performed one controlled 1-second generation smoke test. The provider rejected it with `You have exceeded your ZeroGPU runs limit`; no video output was produced.
- Opened draft PR #53 containing documentation-only state and changelog files. Production branch and service configuration remain unchanged.
- No paid generation request, secret change, or production deployment was initiated.
- Checked Flyne's public free text-to-video workflow (5 seconds, 480p, no signup claim); the generation action triggered Cloudflare Turnstile, so automation stopped without bypassing verification. No clip was produced.
- Inspected AIFree's free Wan 2.2 visitor mode and submitted one 16:9 text-only smoke test; Cloudflare human verification blocked generation. No video was produced and no verification was bypassed.

- Inspected the existing Agnes provider against the current 2.5-series API schema and found its image mode used obsolete request fields. The adapter now rejects that unsupported path rather than submitting a malformed request.
- Added provider job ID persistence and resume support for asynchronous providers. After a worker restart, Agnes can poll the existing video ID instead of submitting a duplicate job.
- Locked the Agnes adapter to `agnes-video-2.5-flash`; paid model IDs are rejected. Added mocked tests for text-to-video submission, MP4 validation, job resumption, and unsupported reference-image input.
- No production deployment, environment-variable change, paid API request, or live video-generation request was made. GitHub Actions test execution is pending the implementation PR.

- Local validation of the implementation branch: 8 isolated Node.js mocked tests passed (4 Agnes adapter tests, 4 worker persistence/recovery tests); `node --check` passed for both modules and both test modules. This is not a full repository test-suite run.
- GitHub Actions workflow-run and combined commit-status queries returned no runs/statuses for PR #54; full repository CI remains unverified.

- GitHub Actions re-validation after correcting the outdated reference-image test passed: Node.js tests 66/66, Bridge tests 66/66, and web browser smoke tests 9/9. JavaScript and Android worker syntax checks passed.
- Confirmed the Agnes API endpoint rejects unauthenticated model-list access with HTTP 401. The public free Flash offer requires an account/API key, is a limited-time promotion, and is rate-limited; no credential was available to this execution context, so no live generation was submitted.

- Additional provider research: NiftyVid uses a public Wan 2.2 image-to-video Space without an API key, but caps clips at 4.5 seconds and relies on shared ZeroGPU capacity. A smoke workflow was staged on an isolated experiment branch; its push-triggered run could not be retrieved through the available GitHub connector, so no output is claimed.
- The official Pika H3 Flex Hugging Face Space is currently listed as Running on Zero. A third-party November 2026 test reports anonymous text-to-video with audio but did not byte-verify the downloaded MP4. The connected Pika API quote is 5 credits; no generation was run and no credits were spent.
- Prior Render inspection found no Agnes API key or Agnes provider selection in the inspected JoyVerse bridge environment; no GitHub Actions secret was reported.

- Executed a real no-key Wan 2.2 image-to-video smoke test through the public Hugging Face ZeroGPU Space. The workflow uploaded a synthetic reference image, submitted the Gradio job, streamed the completion event, downloaded the MP4, and validated its container header.
- Retrieved the GitHub Actions artifact through the GitHub connector and independently checked it with `ffprobe`: H.264, 640x640, 16 fps, 3.5625 seconds, 526,822 bytes. This is a technical smoke clip, not a finished JoyVerse scene.
- Added the Wan 2.2 provider adapter with image upload, Gradio SSE handling, safe output-host validation, MP4 validation, resumable event-ID checkpointing, and explicit opt-in via `VIDEO_PROVIDER=niftyvid-wan`.
- Latest GitHub Actions checks on the implementation head passed: Node.js tests 72/72, Bridge tests 72/72, and web validation passed. No production deployment or environment change was made.


- Added a reusable audio-format detector and tests for supported WAV/MP3/M4A/AAC/OGG/FLAC signatures.
- Added optional upload of up to four audio tracks in the Studio UI and integrated uploaded tracks into server-side FFmpeg assembly.
- Added original procedural WAV background music in three styles, with deterministic output and validation tests; no external music API or credit is used.
- Added a Kokoro TTS provider adapter, authenticated voiceover endpoint, and Studio controls for short English narration generation. Voiceover output is staged in object storage for final mixing.
- Diagnosed the first Kokoro HTTP smoke failure: the assumed Gradio REST route returned HTTP 404. The smoke workflow now uses the official Gradio Python client to discover the live API and invoke the named endpoint. The updated workflow run could not be confirmed with the available GitHub Actions query, so no live voiceover is claimed.
- Latest audio/TTS implementation has not yet passed the full CI suite or live end-to-end verification. No production deployment, secret changes, or paid generation requests were made.


- Latest implementation PR #54 CI completed successfully: Node.js 81/81, Bridge 81/81, and web browser smoke tests 9/9. Server/provider syntax checks also passed.
- Confirmed Kokoro provider unit tests, audio-format tests, and procedural music tests were included in the passing Node/Bridge suites.
- PR #54 is open and GitHub reports it mergeable; no merge or production deployment was performed.
- Live Kokoro TTS remains unverified: the first assumed REST route returned HTTP 404; the follow-up Gradio-client discovery workflow has not produced a retrievable run result. Mocked provider tests are not presented as proof of live synthesis.


- Added a real FFmpeg media integration test: creates an H.264 test clip, mixes generated WAV music using the production assembler, and decodes the final MP4's video and audio streams.
- Latest GitHub Actions run passed: Node.js 82/82, Bridge 82/82, and web browser smoke tests 9/9. The real FFmpeg audio/video integration test passed in both Node and Bridge suites.
- Added a live, no-key Kokoro TTS acceptance workflow using the official Gradio Python client. Its execution is pending; it was not merged into main just to force a run. The initial raw REST attempt returned 404, while the provider's mocked tests pass.
- PR #54 remains open; branch comparison reports 63 commits ahead and 0 behind. No production merge or deployment was performed.


## 2026-11-25 — Wan, Kokoro, and audio pipeline acceptance

- Added the direct-REST Kokoro CPU TTS provider and an authenticated voiceover endpoint. The live acceptance workflow generated a valid 4.2-second, 24 kHz mono PCM WAV without an API key or paid credits.
- Added audio upload and signature validation for WAV, MP3, M4A, AAC, OGG, and FLAC, plus browser controls for uploading audio and generating voiceover.
- Added an original procedural music generator (cheerful, adventure, gentle) supporting up to 600 seconds at 16 kHz stereo.
- Extended the production FFmpeg assembler to mix and pad up to four audio tracks. Added a real FFmpeg integration test that creates two clips, adds generated music, and decodes both output streams.
- Created a local verified technical sample using the Wan smoke clip, live Kokoro voiceover, and original music: H.264 + AAC MP4, 7.125 seconds, 766,269 bytes. It is a pipeline test, not a finished JoyVerse episode.
- Latest observed Node and Bridge test suites passed; live Kokoro acceptance passed. The newest web validation run is still being checked.
- PR #54 remains unmerged and production main/Render configuration remain unchanged. No paid API, credit spend, secret change, or production deployment occurred.


## 2026-11-25 — Final CI confirmation

- Confirmed all four required GitHub Actions workflows passed on implementation head `460223dd3e295bb56b95e08dc6f8f1a85355410c`: Node.js tests, Bridge tests, web validation, and live Kokoro TTS acceptance.
- Independently decoded the saved MP4 sample's H.264 video and AAC audio streams with FFmpeg; both passed (`DECODE_OK`).
- Updated PROJECT_STATE to record the exact verification and keep the remaining character-reference and Android end-to-end acceptance tasks explicit.
