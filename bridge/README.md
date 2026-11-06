# JoyVerse MacroDroid Bridge

This service exposes two MCP tools to ChatGPT:

- `send_macro_command`: calls the user's MacroDroid Cloud Webhook.
- `get_device_result`: reads the latest callback sent by the phone.

## Important limitations

A successful webhook HTTP response confirms only delivery to MacroDroid's cloud endpoint. It does **not** prove that the phone received the push, that the macro ran, that the correct browser tab was active, or that Loremotion generated a video.

The callback cache is in memory and is cleared on service restart. The Render free instance may sleep, so it is suitable for an initial proof-of-concept, not guaranteed always-on production use.

## Render configuration

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Environment variable: `MCP_ACCESS_TOKEN` (random secret, at least 32 characters)
- Environment variable: `MACRODROID_WEBHOOK_URL` (the private HTTPS Webhook URL copied from the phone's MacroDroid Webhook trigger; configure it in Render, never commit it to GitHub or send it in chat)

The MCP endpoint is `https://<service-host>/mcp/<MCP_ACCESS_TOKEN>`.
The device callback endpoint is `https://<service-host>/device-result/<MCP_ACCESS_TOKEN>`.

The server reads the MacroDroid webhook only from `MACRODROID_WEBHOOK_URL`. The REST `/api/command` request and MCP `send_macro_command` tool therefore need only the command and optional prompt/scene ID; they do not accept or expose the private webhook URL. `/health` and authenticated `/api/status` report only whether the webhook is configured, never its value.

## Device setup still required

On the Android device, create a MacroDroid macro with:

1. Trigger: Webhook (URL), with a private identifier.
2. Actions: inspect the `command` variable and branch on `open_loremotion`, `submit_scene`, `check_page`, or `stop`.
3. For browser control, use Launch Website / Launch Application and UI Interaction with Accessibility enabled. Keep the display on; UI Interaction cannot operate while the screen is off.
4. After each branch, add an HTTP Request (POST) to the device callback endpoint, sending JSON with `command_id`, `status`, `page`, and `message`.

The webhook URL is a bearer capability. Do not publish it or put it in public source files. The ChatGPT MCP tool requires the user's own webhook URL as an argument for each command; it is not stored by this server.
