# JoyVerse Scene Studio

Mobile-first scene queue for the JoyVerse Kids video workflow.

## What it does

- Adds individual scenes to a persistent browser-side queue.
- Sends scenes to the public LTX-2.5 Gradio Space one at a time.
- Waits for the current scene's streamed job result before starting the next.
- Tracks waiting, running, completed, and failed states.
- Stores scene prompts and result URLs in browser local storage.
- Provides a preview and MP4 link for each completed scene.
- Can merge 2–8 completed clips into one silent MP4 locally in the browser using FFmpeg WebAssembly. The merge is experimental on mobile and has a 350 MB total input limit.
- When the Studio is opened over HTTPS, a service worker downloads and caches the FFmpeg runtime in the background. The browser may pause background work, and cached data can be evicted by the browser; the first download requires the page to remain open and online.
- Supports optional reference image, 1–5 second clips, and 9:16 / 16:9 / 1:1 aspect ratios.

## Cost and provider policy

- The app connects directly to the public Lightricks/LTX-2.5 Gradio Space using `@gradio/client`.
- It does not use LoreMotion, TinyFish, or a paid provider API.
- The public Space uses shared GPU capacity. Queue time, uptime, and free access are controlled by the provider and are not guaranteed.
- The app does not bypass ads, queues, account checks, or provider limits, and does not silently switch to a paid model.
- A successful queue submission is not the same as a completed render. A scene is marked complete only after a video URL is returned.

## Important operating notes

- Keep the browser tab open while the queue is running. Browser-side execution cannot be guaranteed to continue after the tab is closed.
- Scene prompts and statuses are stored in local browser storage. Reference images are not persisted; choose the image again after reloading if needed.
- Video URLs are controlled by the upstream provider and may expire. Download completed clips promptly.
- Prompts and optional reference images are sent to the external model provider. Do not upload private or sensitive images.
- This is an independent community workflow and is not affiliated with LoreMotion or Lightricks.

## Deployment

The GitHub Actions workflow in `.github/workflows/pages.yml` deploys the `web/` directory to GitHub Pages when files in `web/**` change on `main`. Enable GitHub Pages with GitHub Actions as the source in repository Settings → Pages if it is not already enabled.

## Development

The app is static HTML/CSS/JavaScript. No build step is required. `web/app.js` imports the version-pinned `@gradio/client` package from esm.sh.

## Private object storage bridge (foundation)

The bridge includes an authenticated private object-storage adapter and worker endpoints:

- `PUT /api/storage/joyverse/...` uploads an MP4 or JPEG/PNG/WebP object.
- `GET /api/storage/joyverse/...` retrieves an object.
- Both endpoints require `Authorization: Bearer <HERMES_WORKER_TOKEN>`.
- The bucket is private; the bridge does not generate public object URLs.
- Individual objects are limited to 350 MiB. Only MP4 and the listed image types are accepted.

Configure these environment variables on the bridge service (never commit their values):

- `R2_BUCKET`: private bucket name.
- `R2_ENDPOINT`: S3-compatible endpoint URL, or use `R2_ACCOUNT_ID` to derive the Cloudflare R2 endpoint.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: scoped bucket credentials.
- `HERMES_WORKER_TOKEN`: a separate random bearer token for worker endpoints.

Without all required R2 settings, storage endpoints return `503 object_storage_not_configured`. Unit tests use a fake S3 client and do not contact a real bucket. This storage foundation is not yet wired into the browser scene generator, LTX job execution, or final-video assembly. The live browser workflow above remains the current production behavior until those integrations are implemented and tested.
