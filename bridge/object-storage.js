import { getTaskPool } from "./task-store.js";

const MAX_OBJECT_BYTES = 100 * 1024 * 1024;
const MAX_DATABASE_OBJECT_BYTES = 50 * 1024 * 1024;

function normalizeKey(key) {
  if (typeof key !== "string" || !key.trim() || key.length > 512 ||
      key.startsWith("/") || key.includes("\\") ||
      key.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid object storage key.");
  }
  return key;
}

export function createObjectStorage({
  env = process.env, client: suppliedClient, commands: suppliedCommands,
  signer: suppliedSigner, database: suppliedDatabase
} = {}) {
  const bucket = env.OBJECT_STORAGE_BUCKET || env.R2_BUCKET;
  const endpoint = env.OBJECT_STORAGE_ENDPOINT || env.R2_ENDPOINT ||
    (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
  const hasS3Settings = Boolean(bucket || endpoint || accessKeyId || secretAccessKey);
  const useDatabase = !hasS3Settings && Boolean(env.DATABASE_URL) && !suppliedClient;
  if (!useDatabase && !bucket) throw new Error("OBJECT_STORAGE_BUCKET (or R2_BUCKET) is required.");
  if (!useDatabase && !suppliedClient && (!endpoint || !accessKeyId || !secretAccessKey)) {
    throw new Error("S3-compatible object storage credentials are required.");
  }
  if (endpoint) {
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw new Error("Object storage endpoint must be a valid HTTPS URL."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Object storage endpoint must be HTTPS and must not contain credentials.");
    }
  }
  let aws, client = suppliedClient;
  async function getAws() {
    if (!aws) aws = Promise.all([
      import("@aws-sdk/client-s3"), import("@aws-sdk/s3-request-presigner")
    ]).then(([s3, presigner]) => ({ s3, presigner }));
    return aws;
  }
  async function getClient() {
    if (client) return client;
    const { s3 } = await getAws();
    client = new s3.S3Client({
      region: env.OBJECT_STORAGE_REGION || env.R2_REGION || "auto",
      endpoint, forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
      credentials: { accessKeyId, secretAccessKey }
    });
    return client;
  }
  async function getCommands() {
    if (suppliedCommands) return suppliedCommands;
    return (await getAws()).s3;
  }
  async function getDatabase() { return suppliedDatabase || getTaskPool(); }

  return Object.freeze({
    backend: useDatabase ? "postgresql" : "s3",
    async put(key, body, contentType = "application/octet-stream") {
      key = normalizeKey(key);
      const limit = useDatabase ? MAX_DATABASE_OBJECT_BYTES : MAX_OBJECT_BYTES;
      if (!(Buffer.isBuffer(body) || body instanceof Uint8Array) ||
          body.byteLength === 0 || body.byteLength > limit) {
        throw new Error(`Object body must be a non-empty buffer up to ${limit} bytes.`);
      }
      if (typeof contentType !== "string" || contentType.length > 120 || /[\\r\\n]/.test(contentType)) {
        throw new Error("Invalid content type.");
      }
      if (useDatabase) {
        await (await getDatabase()).query(
          `INSERT INTO joyverse_objects (object_key, body, content_type, byte_length, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (object_key) DO UPDATE SET body=EXCLUDED.body,
             content_type=EXCLUDED.content_type, byte_length=EXCLUDED.byte_length, updated_at=NOW()`,
          [key, Buffer.from(body), contentType, body.byteLength]
        );
        return { key, bucket: "postgresql", size: body.byteLength, content_type: contentType };
      }
      const commands = await getCommands();
      await (await getClient()).send(new commands.PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: contentType
      }));
      return { key, bucket, size: body.byteLength, content_type: contentType };
    },
    async get(key) {
      key = normalizeKey(key);
      if (useDatabase) {
        const { rows } = await (await getDatabase()).query(
          "SELECT body FROM joyverse_objects WHERE object_key=$1", [key]
        );
        if (!rows[0]?.body) throw new Error("Stored object was not found.");
        return Buffer.from(rows[0].body);
      }
      const commands = await getCommands();
      const result = await (await getClient()).send(new commands.GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error("Object storage returned an empty body.");
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async createUploadUrl(key, contentType = "application/octet-stream", expiresIn = 900) {
      if (useDatabase) throw new Error("Presigned uploads are unavailable with PostgreSQL-backed object storage.");
      key = normalizeKey(key);
      if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 3600) {
        throw new Error("Upload URL expiry must be from 60 to 3600 seconds.");
      }
      if (typeof contentType !== "string" || contentType.length > 120 || /[\\r\\n]/.test(contentType)) {
        throw new Error("Invalid content type.");
      }
      const commands = await getCommands();
      const command = new commands.PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
      const signer = suppliedSigner || (await getAws()).presigner.getSignedUrl;
      const url = await signer(await getClient(), command, { expiresIn });
      return { key, url, expires_in: expiresIn, content_type: contentType };
    }
  });
}
