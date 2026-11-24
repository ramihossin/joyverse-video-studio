import test from "node:test";
import assert from "node:assert/strict";
import { createProceduralMusicWav } from "../bridge/procedural-music.js";

test("creates deterministic original stereo PCM music in a valid WAV container", () => {
  const first = createProceduralMusicWav({ durationSeconds: 2.5, style: "cheerful" });
  const second = createProceduralMusicWav({ durationSeconds: 2.5, style: "cheerful" });
  assert.deepEqual(first, second);
  assert.equal(first.toString("ascii", 0, 4), "RIFF");
  assert.equal(first.toString("ascii", 8, 12), "WAVE");
  assert.equal(first.toString("ascii", 12, 16), "fmt ");
  assert.equal(first.readUInt16LE(22), 2);
  assert.equal(first.readUInt32LE(24), 16000);
  assert.equal(first.toString("ascii", 36, 40), "data");
  assert.equal(first.readUInt32LE(40), first.length - 44);
});

test("supports the three original music styles", () => {
  const cheerful = createProceduralMusicWav({ durationSeconds: 1, style: "cheerful" });
  const adventure = createProceduralMusicWav({ durationSeconds: 1, style: "adventure" });
  const gentle = createProceduralMusicWav({ durationSeconds: 1, style: "gentle" });
  assert.notDeepEqual(cheerful, adventure);
  assert.notDeepEqual(adventure, gentle);
});

test("rejects unsupported music duration, style, and sample rate", () => {
  assert.throws(() => createProceduralMusicWav({ durationSeconds: 0.5 }), /1 to 180/);
  assert.throws(() => createProceduralMusicWav({ durationSeconds: 5, style: "unknown" }), /style must be/);
  assert.throws(() => createProceduralMusicWav({ durationSeconds: 5, sampleRate: 48000 }), /sample rate must be/);
});
