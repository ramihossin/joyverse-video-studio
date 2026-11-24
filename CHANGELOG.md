# CHANGELOG

## 2026-11-25
- Added `PROJECT_STATE.md` on isolated branch `ops/project-state-baseline-2026-11-25` as the authoritative operational record.
- Recovered the actual production architecture from `main`: mobile-first Studio, authenticated bridge, PostgreSQL task queue, LTX Gradio provider, object storage, and FFmpeg MP4 assembly.
- Verified the public Studio page loads and the bridge health endpoint returns HTTP 200 after cold start.
- Recorded the remaining end-to-end acceptance gaps; no generation task, paid API request, secret change, or production deployment was initiated.
