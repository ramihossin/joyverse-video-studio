import test from "node:test";
import assert from "node:assert/strict";
import { createObjectStorage } from "../bridge/object-storage.js";

class PutObjectCommand { constructor(input) { this.input = input; } }
class GetObjectCommand { constructor(input) { this.input = input; } }

const config = {
  env: { OBJECT_STORAGE_BUCKET: "joyverse-test" },
  commands: { PutObjectCommand, GetObjectCommand }
};

test("S3 adapter uploads and retrieves objects using an injected client", async () => {
  const objects = new Map();
  const client = {
    async send(command) {
      const { Key, Body } = command.input;
      if (command instanceof PutObjectCommand) objects.set(Key, Buffer.from(Body));
      if (command instanceof GetObjectCommand) {
        const body = objects.get(Key);
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      return {};
    }
  };
  const storage = createObjectStorage({ ...config, client });
  const saved = await storage.put("jobs/task-1/scene-1.mp4", Buffer.from("clip"), "video/mp4");
  assert.equal(saved.key, "jobs/task-1/scene-1.mp4");
  assert.equal(saved.size, 4);
  assert.deepEqual(await storage.get(saved.key), Buffer.from("clip"));
});

test("S3 adapter accepts Cloudflare R2 environment variable names", () => {
  const storage = createObjectStorage({
    env: {
      R2_BUCKET: "joyverse-r2",
      R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      R2_ACCESS_KEY_ID: "r2-access-key",
      R2_SECRET_ACCESS_KEY: "r2-secret-key"
    },
    client: { send: async () => ({}) }
  });
  assert.equal(typeof storage.put, "function");
  assert.equal(typeof storage.get, "function");
});

test("S3 adapter creates bounded presigned upload URLs", async () => {
  const client = { send: async () => ({}) };
  const storage = createObjectStorage({
    ...config, client,
    signer: async (_client, command, options) => {
      assert.ok(command instanceof PutObjectCommand);
      assert.equal(command.input.ContentType, "image/png");
      assert.equal(options.expiresIn, 600);
      return "https://storage.example/upload?signature=test";
    }
  });
  const result = await storage.createUploadUrl("refs/task-1/reference.png", "image/png", 600);
  assert.equal(result.url, "https://storage.example/upload?signature=test");
  assert.equal(result.expires_in, 600);
});

test("S3 adapter rejects unsafe keys, invalid bodies, and invalid URL expiry", async () => {
  const storage = createObjectStorage({ ...config, client: { send: async () => ({}) } });
  await assert.rejects(storage.put("../outside.mp4", Buffer.from("x")));
  await assert.rejects(storage.get("jobs//empty.mp4"));
  await assert.rejects(storage.put("jobs/empty.mp4", Buffer.alloc(0)));
  await assert.rejects(storage.createUploadUrl("refs/a.png", "image/png", 30));
});

test("S3 adapter requires bucket and server-side credentials", () => {
  assert.throws(() => createObjectStorage({ env: {} }), /OBJECT_STORAGE_BUCKET/);
  assert.throws(() => createObjectStorage({
    env: { OBJECT_STORAGE_BUCKET: "bucket" }
  }), /credentials/);
});


test("PostgreSQL fallback stores and retrieves small objects without S3 credentials", async () => {
  const records = new Map();
  const database = {
    async query(sql, params) {
      if (sql.includes("INSERT INTO joyverse_objects")) {
        records.set(params[0], { body: Buffer.from(params[1]), content_type: params[2], byte_length: params[3] });
        return { rows: [] };
      }
      if (sql.includes("SELECT body FROM joyverse_objects")) {
        const record = records.get(params[0]);
        return { rows: record ? [{ body: record.body }] : [] };
      }
      throw new Error("Unexpected SQL in storage test.");
    }
  };
  const storage = createObjectStorage({
    env: { DATABASE_URL: "postgres://test.invalid/joyverse" },
    database
  });
  assert.equal(storage.backend, "postgresql");
  const saved = await storage.put("jobs/task-1/scene.mp4", Buffer.from("video"), "video/mp4");
  assert.equal(saved.bucket, "postgresql");
  assert.deepEqual(await storage.get(saved.key), Buffer.from("video"));
  await assert.rejects(storage.get("jobs/missing.mp4"), /not found/);
  await assert.rejects(storage.createUploadUrl("refs/test.png"), /unavailable/);
});

test("PostgreSQL fallback enforces its per-object size limit", async () => {
  const storage = createObjectStorage({
    env: { DATABASE_URL: "postgres://test.invalid/joyverse" },
    database: { query: async () => ({ rows: [] }) }
  });
  await assert.rejects(
    storage.put("jobs/large.mp4", Buffer.alloc(50 * 1024 * 1024 + 1), "video/mp4"),
    /up to/
  );
});
