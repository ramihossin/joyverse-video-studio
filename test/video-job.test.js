import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVideoOptions, assertVideoOptionsForProvider } from "../bridge/video-job.js";

test("normalizes supported LTX aspect ratios and defaults", () => {
  assert.deepEqual(normalizeVideoOptions(), {
    aspect: "portrait", width: 832, height: 1472, duration: 5, seed: 42,
    randomize_seed: false, enhance_prompt: false, decoder: "conv", auto_len: false
  });
  assert.deepEqual(
    { ...normalizeVideoOptions({ aspect: "landscape", duration: 3, seed: 7, randomize_seed: true }) },
    { aspect: "landscape", width: 1472, height: 832, duration: 3, seed: 7,
      randomize_seed: true, enhance_prompt: false, decoder: "conv", auto_len: false }
  );
  assert.equal(normalizeVideoOptions({ aspect: "square" }).width, 512);
});

test("rejects unsupported dimensions, duration, seed, and option types", () => {
  for (const options of [
    { aspect: "ultrawide" }, { duration: 0 }, { duration: 6 },
    { duration: 1.5 }, { seed: -1 }, { seed: 2147483648 },
    { randomize_seed: "yes" }, { enhance_prompt: 1 }, []
  ]) assert.throws(() => normalizeVideoOptions(options));
});

test("validates provider-specific minimum duration without restricting LTX", () => {
  const threeSeconds = normalizeVideoOptions({ duration: 3 });
  assert.equal(assertVideoOptionsForProvider(threeSeconds, "ltx").duration, 3);
  assert.throws(() => assertVideoOptionsForProvider(threeSeconds, "agnes"), /at least 4 seconds/);
  assert.equal(assertVideoOptionsForProvider(normalizeVideoOptions({ duration: 4 }), "agnes").duration, 4);
});
