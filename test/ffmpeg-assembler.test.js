import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { assembleMp4 } from "../bridge/ffmpeg-assembler.js";

test("FFmpeg assembler validates clip count, type and size before execution", async () => {
  await assert.rejects(assembleMp4([]), /between 1 and 40/);
  await assert.rejects(assembleMp4(["not a buffer"]), /MP4 buffer/);
  await assert.rejects(assembleMp4([Buffer.alloc(0)]), /MP4 buffer/);
});

test("FFmpeg assembler reports a non-zero FFmpeg exit without invoking a shell", async () => {
  let command;
  const spawn = (binary, args, options) => {
    command = { binary, args, options };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("invalid input"));
      child.emit("close", 1);
    });
    return child;
  };
  await assert.rejects(assembleMp4([Buffer.from("clip")], {
    ffmpegPath: "/usr/bin/ffmpeg", spawn, timeoutMs: 1000
  }), /FFmpeg failed with exit code 1: invalid input/);
  assert.equal(command.binary, "/usr/bin/ffmpeg");
  assert.equal(command.options.shell, undefined);
  assert.ok(command.args.includes("-safe"));
  assert.ok(command.args.includes("1"));
});


test("FFmpeg assembler validates optional audio tracks", async () => {
  await assert.rejects(assembleMp4([Buffer.from("clip")], {
    ffmpegPath: "/usr/bin/ffmpeg",
    audioTracks: [{ buffer: "not a buffer", extension: "wav" }]
  }), /audio buffer/);
  await assert.rejects(assembleMp4([Buffer.from("clip")], {
    ffmpegPath: "/usr/bin/ffmpeg",
    audioTracks: [{ buffer: Buffer.from("audio"), extension: "exe" }]
  }), /extension must be wav/);
});

test("FFmpeg assembler mixes multiple audio tracks and pads to the video duration", async () => {
  let command;
  const spawn = (binary, args, options) => {
    command = { binary, args, options };
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      await writeFile(args.at(-1), Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]));
      child.emit("close", 0);
    });
    return child;
  };
  const result = await assembleMp4([Buffer.from("clip")], {
    ffmpegPath: "/usr/bin/ffmpeg",
    spawn,
    timeoutMs: 1000,
    audioTracks: [
      { buffer: Buffer.from("voice"), extension: "wav", volume: 1.0 },
      { buffer: Buffer.from("music"), extension: "mp3", volume: 0.35 }
    ]
  });
  assert.equal(result.subarray(4, 8).toString(), "ftyp");
  assert.ok(command.args.includes("-filter_complex"));
  assert.ok(command.args.some(arg => arg.includes("amix=inputs=2")));
  assert.ok(command.args.some(arg => arg.includes("apad")));
  assert.ok(command.args.includes("[aout]"));
  assert.ok(command.args.includes("-shortest"));
  assert.ok(command.args.includes("audio-000.wav"));
  assert.ok(command.args.includes("audio-001.mp3"));
});
