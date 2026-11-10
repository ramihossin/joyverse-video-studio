import test from "node:test";
import assert from "node:assert/strict";
import { createObjectStorage, OBJECT_STORAGE_LIMITS } from "../bridge/object-storage.js";

function fakeClient(responses = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
          ContentType: "video/mp4",
          ContentLength: 3,
          ETag: '"get-etag"'
        };
      }
      return responses[command.constructor.name] || { ETag: '"put-etag"' };
    }
  };
}

test("object storage requires a bucket and credentials when creating its own client", () => {
  assert.throws(() => createObjectStorage({ bucket: "" }), /R2_BUCKET/);
  assert.throws(() => createObjectStorage({
    bucket: "joyverse", endpoint: "https://storage.example"
  }), /R2_ACCESS_KEY_ID/);
});

test("put validates key, media type, body size and metadata before upload", async () => {
  const client = fakeClient();
  const store = createObjectStorage({ client, bucket: "joyverse" });
  await assert.rejects(store.put({
    key: "../escape.mp4", body: Buffer.from("x"), contentType: "video/mp4"
  }), /Invalid object storage key/);
  await assert.rejects(store.put({
    key: "clips/one.exe", body: Buffer.from("x"), contentType: "application/octet-stream"
  }), /Unsupported object content type/);
  await assert.rejects(store.put({
    key: "clips/one.mp4", body: "not bytes", contentType: "video/mp4"
  }), /Buffer or Uint8Array/);
  await assert.rejects(store.put({
    key: "clips/one.mp4", body: Buffer.from("x"), contentType: "video/mp4",
    metadata: { "bad name": "no" }
  }), /Invalid object metadata/);
  assert.equal(client.calls.length, 0);
});

test("put sends a bounded MP4 object and returns its durable key and metadata", async () => {
  const client = fakeClient();
  const store = createObjectStorage({ client, bucket: "joyverse" });
  const result = await store.put({
    key: "joyverse/scenes/scene-01.mp4",
    body: Buffer.from([1, 2, 3, 4]),
    contentType: "video/mp4",
    metadata: { "scene-id": "scene-01" }
  });
  assert.deepEqual(result, {
    key: "joyverse/scenes/scene-01.mp4",
    etag: '"put-etag"',
    bytes: 4,
    content_type: "video/mp4"
  });
  assert.equal(client.calls[0].name, "PutObjectCommand");
  assert.equal(client.calls[0].input.Bucket, "joyverse");
  assert.equal(client.calls[0].input.ContentLength, 4);
  assert.equal(client.calls[0].input.Metadata["scene-id"], "scene-01");
});

test("get, head and delete operate only on validated keys", async () => {
  const client = fakeClient();
  const store = createObjectStorage({ client, bucket: "joyverse" });
  const key = "joyverse/scenes/scene-01.mp4";
  const downloaded = await store.get({ key });
  assert.deepEqual([...downloaded.body], [1, 2, 3]);
  assert.equal(downloaded.contentType, "video/mp4");
  await store.head({ key });
  await store.delete({ key });
  assert.deepEqual(client.calls.map(call => call.name), [
    "GetObjectCommand", "HeadObjectCommand", "DeleteObjectCommand"
  ]);
  await assert.rejects(store.get({ key: "a//b" }), /Invalid object storage key/);
});

test("storage limits explicitly cap objects at 350 MiB and allow only expected media types", () => {
  assert.equal(OBJECT_STORAGE_LIMITS.maxObjectBytes, 350 * 1024 * 1024);
  assert.deepEqual(OBJECT_STORAGE_LIMITS.allowedContentTypes.sort(), [
    "image/jpeg", "image/png", "image/webp", "video/mp4"
  ]);
});
