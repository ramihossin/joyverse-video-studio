# JVB Browser Agent — free hosted runner

This branch provides a browser-control path that does not run Chromium inside the small Render instance.

## How the assistant operates it

1. The assistant writes one JSON task into `jvb-agent/inbox/` on this branch using the connected GitHub app.
2. The push starts `.github/workflows/jvb-free-browser.yml`.
3. GitHub Actions launches a fresh Playwright/Chromium browser, executes the task, writes its JSON result under `jvb-agent/results/`, and uploads screenshots/downloaded files as a short-lived workflow artifact.
4. The assistant reads the result and returns the outcome in the chat.

The standard GitHub-hosted runner used here is free for public repositories. This workflow uses `ubuntu-latest`, not a paid larger runner. GitHub's terms, usage policies, availability limits, and artifact/storage limits still apply; free runner time does not make third-party video generation free.

## Approved websites

The browser is deliberately restricted to:

- `https://loremotion.com/`
- `https://pavoai.app/`
- `https://theresanaiforthat.com/` (public discovery and search only)

The workflow blocks top-level navigation outside those hosts. Add another site only after reviewing its purpose and safety.

## Official account and verification handling

- LoreMotion states that its free LTX/H3 models can be used anonymously; an account is for history/library and additional account features. The runner should try the anonymous free path first.
- TAAFT public search and browsing do not require an account; login is only needed for saved or account-specific features.
- Pavo account requirements depend on the selected workflow and model. Use the page's explicit zero-cost quote; never infer zero cost from the account having zero credits.
- The runner never bypasses CAPTCHA, Turnstile, anti-bot checks, or identity verification. When one appears it records `humanVerificationRequired` and stops. A person must complete the provider's official challenge; credentials or one-time codes must not be placed in this public repository.

## Operations

A task has a unique `taskId`, `operation`, and initial `url`.

- `inspect`: read the page title, visible form controls, buttons, videos, download links, and challenge state.
- `sequence`: run up to 16 steps in one browser context.

Supported sequence step types:

- `navigate`: navigate to another HTTPS page on an approved host.
- `wait`: wait for a CSS selector, visible text, or a short delay.
- `fill`: fill an ordinary text field or prompt textarea. Password, email, phone, payment, secret, and token fields are blocked.
- `select`: choose an option from a select control.
- `click`: click an element. Login, purchase, payment, subscription, account deletion and logout controls are blocked.
- `upload`: attach a file to an `input[type=file]`. Supported: PNG, JPG, WEBP, MP4, WEBM, MP3 and WAV; 10 MB maximum.
- `download`: click an element and save the browser download; 80 MB maximum.
- `saveVideo`: save a video element's current source; 80 MB maximum.
- `screenshot`: capture the current page.

Video generation is disabled by default. A task must explicitly set `allowFreeGeneration: true`; the page must explicitly show a zero-cost/free state, and visible credit, sign-in-for-free-credits, payment, subscription, upgrade, or limit blockers stop submission. For LoreMotion, generation additionally requires explicit confirmation that the operator is at least 16 years old when in the EU/UK, as required by LoreMotion's Terms. Premium models and paid features are not used. The runner never solves or bypasses CAPTCHA, Turnstile, login, or other site verification.

## Example task

```json
{
  "taskId": "jvb-check-001",
  "operation": "sequence",
  "url": "https://loremotion.com/generate/",
  "steps": [
    { "type": "wait", "selector": "#generate-prompt-dock" },
    { "type": "fill", "selector": "#generate-prompt-dock", "value": "Describe a short scene." },
    { "type": "inspect" },
    { "type": "screenshot", "fileName": "jvb-check.png", "fullPage": true }
  ]
}
```

## Privacy and session boundaries

This repository is public. Task JSON, result JSON and committed prompts are visible in the repository history. Do not put passwords, private account data, private photos, personal identifiers, or secrets in tasks. Uploaded file data is also visible in the task commit; only use assets that are suitable for a public repository.

Each task starts a fresh browser session. Steps within one sequence share the same page, but browser login cookies are not persisted between runs. This avoids placing reusable login cookies in a public repository. Anonymous/free site modes can be used where the site itself permits them.

Screenshots and downloaded files are attached to the workflow run as artifacts with one-day retention. The workflow does not purchase credits, submit payment, or change account settings.
