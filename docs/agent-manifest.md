# JoyVerse Scene Manifest (v1)

This JSON format is the hand-off contract between an AI planning agent and JoyVerse Scene Studio. An agent can prepare an entire scene list without controlling the browser or calling a video provider.

## Import/export

In Scene Studio, choose **Import agent manifest** to add scenes to the local queue, or **Export scene manifest** to save the current queue as JSON. Importing only stores prompts locally; it does not start generation or send data to Hugging Face. The user must review the queue, enable the existing provider-consent checkbox, and press **Run scene queue**.

## Schema

```json
{
  "schema": "joyverse-scene-manifest",
  "version": 1,
  "scenes": [
    {
      "title": "Scene 01 — The Garden",
      "prompt": "A cheerful, child-safe scene description in English."
    }
  ]
}
```

Limits: 1–100 scenes per file, title up to 100 characters, prompt up to 4,000 characters, and file size up to 1 MiB. The browser queue is limited to 100 total entries. Import preserves the title and prompt only; generation settings and reference images remain selected in the Studio UI.

## Operational boundaries

- This is a local file hand-off, not a remote REST endpoint or background agent.
- Imported scenes are added as waiting; no video generation begins automatically.
- The browser must remain open while the queue runs.
- LTX-2.5 availability and free GPU quota are controlled by Hugging Face and are not guaranteed.
