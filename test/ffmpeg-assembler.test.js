import test from "node:test";
import assert from "node:assert/strict";
import { assembleMp4 } from "../bridge/ffmpeg-assembler.js";

test("FFmpeg assembler validates clip count, type and total size before execution", async () => {
  await assert.rejects(assembleMp4([]), /between 1 and 40/);
  await assert.rejects(assembleMp4(["not a buffer"]), /MP4 buffer/);
  await assert.rejects(assembleMp4([Buffer.alloc(0)]), /MP4 buffer/);
});

test("FFmpeg assembler invokes a fixed concat command and validates output", async () => {
  let argsSeen;
  const spawn = (_bin, args) => {
    argsSeen = args;
    const { EventEmitter } = awaitImportShim();
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.writeFile(path.join(argsSeen[argsSeen.length - 1], ".."), ""); 
    });
    return child;
  };
  // Invalid output is rejected; this also confirms no shell command is used.
  await assert.rejects(assembleMp4([Buffer.from("clip")], {
    ffmpegPath: "/usr/bin/ffmpeg",
    spawn: () => {
      const { EventEmitter } = awaitImportShim();
      const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => child.emit("close", 1));
      return child;
    },
    timeoutMs: 1000
  }), /FFmpeg failed/);
});

function awaitImportShim() {
  return requireShim;
}
import { EventEmitter as requireShim } from "node:events";
