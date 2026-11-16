import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("API starts only one worker run per dispatch or scheduled tick", async () => {
  const source = await readFile(new URL("../bridge/server.js", import.meta.url), "utf8");
  assert.match(source, /worker\.runOnce\(\)/);
  assert.doesNotMatch(source, /void worker\.run\(\)/);
  assert.match(source, /event-driven: scene dispatch or scheduled queue tick/);
});

test("scheduled queue checks leave an idle window for free Postgres scale-to-zero", async () => {
  const workflow = await readFile(new URL("../.github/workflows/video-worker.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "ळ\/10 \* \* \* \*"/.replace("ळ", "*"));
});
