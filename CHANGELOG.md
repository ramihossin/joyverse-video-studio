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
