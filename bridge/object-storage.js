import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";

const MAX_OBJECT_BYTES = 350 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "video/mp4",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function validateKey(key) {
  if (typeof key !== "string" || !key || key.length > 512 ||
      key.startsWith("/") || key.includes("\\") ||
      key.split("/").some(part => !part || part === "." || part === "..") ||
      !/^[A-Za-z0-9!_.*'()/-]+$/.test(key)) {
    throw new TypeError("Invalid object storage key.");
  }
  return key;
}

function validateBody(body, contentType) {
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new TypeError("Object body must be a Buffer or Uint8Array.");
  }
  if (body.byteLength < 1 || body.byteLength > MAX_OBJECT_BYTES) {
    throw new RangeError("Object size must be between 1 byte and 350 MiB.");
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new TypeError("Unsupported object content type.");
  }
}

export function createObjectStorage({
  client,
  bucket = process.env.R2_BUCKET,
  endpoint = process.env.R2_ENDPOINT,
  accountId = process.env.R2_ACCOUNT_ID,
  accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
} = {}) {
  if (!bucket) throw new Error("R2_BUCKET is required.");
  const s3 = client || (() => {
    if (!endpoint && !accountId) throw new Error("R2_ENDPOINT or R2_ACCOUNT_ID is required.");
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required.");
    }
    return new S3Client({
      region: "auto",
      endpoint: endpoint || `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }
    });
  })();

  return Object.freeze({
    async put({ key, body, contentType, metadata = {} }) {
      validateKey(key);
      validateBody(body, contentType);
      const safeMetadata = {};
      for (const [name, value] of Object.entries(metadata)) {
        if (!/^[a-z0-9-]{1,64}$/i.test(name) ||
            typeof value !== "string" || value.length > 256) {
          throw new TypeError("Invalid object metadata.");
        }
        safeMetadata[name.toLowerCase()] = value;
      }
      const response = await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: contentType,
        ContentLength: body.byteLength, Metadata: safeMetadata
      }));
      return {
        key,
        etag: response.ETag || null,
        bytes: body.byteLength,
        content_type: contentType
      };
    },

    async get({ key }) {
      validateKey(key);
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new Error("Stored object has no response body.");
      const bytes = await response.Body.transformToByteArray();
      if (!bytes.byteLength || bytes.byteLength > MAX_OBJECT_BYTES) {
        throw new RangeError("Stored object size is outside the supported limit.");
      }
      return {
        body: Buffer.from(bytes),
        contentType: response.ContentType || "application/octet-stream",
        bytes: bytes.byteLength,
        etag: response.ETag || null
      };
    },

    async head({ key }) {
      validateKey(key);
      const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        key, bytes: response.ContentLength ?? null,
        content_type: response.ContentType || null,
        etag: response.ETag || null
      };
    },

    async delete({ key }) {
      validateKey(key);
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { key, deleted: true };
    }
  });
}

export const OBJECT_STORAGE_LIMITS = Object.freeze({
  maxObjectBytes: MAX_OBJECT_BYTES,
  allowedContentTypes: [...ALLOWED_CONTENT_TYPES]
});
