import test from "node:test";
import assert from "node:assert/strict";
import { createLtxProvider } from "../bridge/ltx-provider.js";

function asyncEvents(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    }
  };
}

test("LTX provider submits normalized options and downloads the returned video", async () => {
  let submitted;
  const provider = createLtxProvider({
    space: "test/space",
    fileHandler: buffer => ({ testFile: buffer.toString() }),
    clientConnect: async (space, options) => {
      assert.equal(space, "test/space");
      assert.deepEqual(options.events, ["data", "status"]);
      return {
        submit: (endpoint, args) => {
          submitted = { endpoint, args };
          return asyncEvents([
            { type: "status", status: "generating", position: 0 },
            { type: "data", data: [{ url: "https://test-space.hf.space/file=output.mp4" }] }
          ]);
        }
      };
    },
    fetchImpl: async url => {
      assert.equal(url, "https://test-space.hf.space/file=output.mp4");
      return new Response(Buffer.from("fake-mp4"), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "8" }
      });
    }
  });
  const progress = [];
  const result = await provider.generate({
    prompt: "A colorful train moves through a garden.",
    videoOptions: { aspect: "landscape", duration: 4 },
    referenceImage: Buffer.from("image"),
    onProgress: value => progress.push(value)
  });
  assert.equal(submitted.endpoint, "/run");
  assert.equal(submitted.args[0], "A colorful train moves through a garden.");
  assert.deepEqual(submitted.args[1], { testFile: "image" });
  assert.equal(submitted.args[2], 832);
  assert.equal(submitted.args[3], 1472);
  assert.equal(submitted.args[4], 4);
  assert.equal(result.contentType, "video/mp4");
  assert.deepEqual(result.buffer, Buffer.from("fake-mp4"));
  assert.equal(progress.length, 1);
});

test("LTX provider rejects unsafe output hosts and malformed output", async () => {
  const makeProvider = url => createLtxProvider({
    clientConnect: async () => ({
      submit: () => asyncEvents([{ type: "data", data: [{ url }] }])
    }),
    fetchImpl: async () => new Response(Buffer.from("x"), {
      headers: { "content-type": "video/mp4" }
    })
  });
  await assert.rejects(
    makeProvider("https://127.0.0.1/private").generate({ prompt: "test" }),
    /outside the approved/
  );
  await assert.rejects(
    createLtxProvider({
      clientConnect: async () => ({ submit: () => asyncEvents([{ type: "data", data: [] }]) })
    }).generate({ prompt: "test" }),
    /without a downloadable/
  );
});

test("LTX provider enforces prompt and reference-image input validation", async () => {
  const provider = createLtxProvider({
    clientConnect: async () => ({ submit: () => asyncEvents([]) })
  });
  await assert.rejects(provider.generate({ prompt: " " }), /prompt/);
  await assert.rejects(provider.generate({ prompt: "valid", referenceImage: "not a buffer" }), /Buffer/);
});
