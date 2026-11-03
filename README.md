# JoyVerse AI Video Studio

Mobile-first Arabic AI video generator. The first integrated engine is the public LTX-2.5 Gradio Space, supporting text-to-video and image-to-video with synchronized audio.

## Cost policy

- This version uses the public shared ZeroGPU queue without a provider API key.
- No paid provider API, prepaid balance, or billing key is configured.
- Free queue access is quota-limited and availability is not guaranteed. A request may wait or fail when shared GPU capacity is busy.
- The app does not silently switch to a paid provider.
- Never add API tokens to browser JavaScript or commit secrets.

## Current capabilities

- Text-to-video and optional image-to-video.
- Portrait, landscape, and square aspect presets.
- Short clips from 1 to 5 seconds.
- Generated audio returned with the video by the LTX-2.5 Space.
- Queue/status feedback, preview, and download link.
- Explicit consent before sending prompt/image to the external model provider.

## Architecture

The browser calls the public Gradio Space directly through the official @gradio/client library. This avoids a server-side proxy, avoids storing user images on our server, and avoids needing a paid hosting service for inference.

Provider configuration is isolated in web/app.js so future free or renewable-credit providers can be added without redesigning the UI. Do not enable a provider until its public API, cost model, and quota behavior are verified.

## Deployment

The existing GitHub Pages workflow deploys the web/ directory. Enable GitHub Pages with GitHub Actions as the source in repository Settings → Pages if it is not already enabled.

## Important limitations

- LTX-2.5 is a large model served by a shared public GPU Space. Queue time, quota, and uptime are controlled by the upstream service.
- The current UI requests short 1–5 second clips. Longer videos require a later editing/assembly workflow.
- A successful web deployment does not prove that upstream generation works. End-to-end generation must be tested separately when the model service is available.
- Prompts and optional images are transmitted directly to the model provider. Do not upload private or sensitive images.

## Development

The site is static HTML/CSS/JavaScript. No build step is required. web/app.js imports @gradio/client from a version-pinned CDN.
