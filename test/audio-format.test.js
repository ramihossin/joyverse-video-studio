import test from "node:test";
import assert from "node:assert/strict";
import { detectAudioFormat } from "../bridge/audio-format.js";

test("detects supported audio containers by file signature", () => {
  const cases = [
    ["wav", "RIFFxxxxWAVE"],
    ["flac", "fLaCxxxxxxxx"],
    ["ogg", "OggSxxxxxxxx"],
    ["mp3", "ID3xxxxxxx"],
    ["m4a", "xxxxftypM4A "]
  ];
  for (const [extension, header] of cases) {
    assert.equal(detectAudioFormat(Buffer.from(header)).extension, extension);
  }
  assert.equal(detectAudioFormat(Buffer.from([0xff,0xf1,0x50,0x80,0,0x1f,0xfc,0,0,0,0,0])).extension, "aac");
});

test("rejects short and unrecognized audio data", () => {
  assert.equal(detectAudioFormat(Buffer.alloc(8)), null);
  assert.equal(detectAudioFormat(Buffer.from("not audio data")), null);
  assert.equal(detectAudioFormat("RIFFxxxxWAVE"), null);
});
