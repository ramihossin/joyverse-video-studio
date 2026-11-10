import test from "node:test";
import assert from "node:assert/strict";
import { parseManifest, serializeManifest, MANIFEST_SCHEMA } from "../web/manifest.js";

test("imports a valid agent-generated manifest", () => {
  const scenes = parseManifest({
    schema: MANIFEST_SCHEMA, version: 1,
    scenes: [{ title: "Scene 1", prompt: "A friendly bear waves." }]
  });
  assert.deepEqual(scenes, [{ title: "Scene 1", prompt: "A friendly bear waves." }]);
});

test("rejects unsupported versions and malformed scenes", () => {
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, version: 2, scenes: [] }), /غير مدعومة/);
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, version: 1, scenes: [{ title: "Missing prompt" }] }), /وصف المشهد/);
});

test("rejects more than 100 scenes", () => {
  const scenes = Array.from({ length: 101 }, (_, i) => ({ title: `Scene ${i}`, prompt: "Prompt" }));
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, version: 1, scenes }), /100 مشهد/);
});

test("exports only the reusable scene title and prompt", () => {
  const value = JSON.parse(serializeManifest([
    { title: "Scene 1", prompt: "Prompt", status: "done", videoUrl: "https://example.invalid/video.mp4" }
  ]));
  assert.equal(value.schema, MANIFEST_SCHEMA);
  assert.equal(value.version, 1);
  assert.deepEqual(value.scenes, [{ title: "Scene 1", prompt: "Prompt" }]);
});
