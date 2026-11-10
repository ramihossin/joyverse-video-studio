import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
