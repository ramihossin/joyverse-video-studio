# CHANGELOG

## 2026-11-25
- Added `PROJECT_STATE.md` on isolated branch `ops/project-state-baseline-2026-11-25` as the authoritative operational record.
- Recovered the actual production architecture from `main`: mobile-first Studio, authenticated bridge, PostgreSQL task queue, LTX Gradio provider, object storage, and FFmpeg MP4 assembly.
- Verified the public Studio page loads and the bridge health endpoint returns HTTP 200 after cold start.
- Verified the official public LTX-2.5 Space was running, then performed one controlled 1-second generation smoke test. The provider rejected it with `You have exceeded your ZeroGPU runs limit`; no video output was produced.
- Opened draft PR #53 containing documentation-only state and changelog files. Production branch and service configuration remain unchanged.
- No paid generation request, secret change, or production deployment was initiated.
- Checked Flyne's public free text-to-video workflow (5 seconds, 480p, no signup claim); the generation action triggered Cloudflare Turnstile, so automation stopped without bypassing verification. No clip was produced.
