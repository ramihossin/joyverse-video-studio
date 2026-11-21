import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

test("AES-256-GCM session envelope round-trips and detects tampering", () => {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const clear = Buffer.from(JSON.stringify({ cookies: [{ name: "sid", value: "private" }] }));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tag = cipher.getAuthTag();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), clear);
  const bad = createDecipheriv("aes-256-gcm", key, iv);
  bad.setAuthTag(Buffer.alloc(16));
  assert.throws(() => Buffer.concat([bad.update(encrypted), bad.final()]));
});
