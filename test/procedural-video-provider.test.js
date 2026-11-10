import test from "node:test";
import assert from "node:assert/strict";
import { createProceduralVideoProvider } from "../bridge/procedural-video-provider.js";

test("procedural provider produces a playable MP4 without an external video API", { timeout: 180000 }, async () => {
  const provider = createProceduralVideoProvider({ timeoutMs: 150000 });
  const output = await provider.generate({
    prompt: "A bright colorful bouncing ball for a children's scene",
    videoOptions: { duration: 1 }
  });
  assert.equal(output.contentType, "video/mp4");
  assert.ok(Buffer.isBuffer(output.buffer));
  assert.ok(output.buffer.length > 1024);
  assert.equal(output.buffer.subarray(4, 8).toString(), "ftyp");
});
