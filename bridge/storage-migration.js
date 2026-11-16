import { createHash } from "node:crypto";
import pg from "pg";
import { createObjectStorage } from "./object-storage.js";

const { Pool } = pg;
const MIGRATION_ID = "render-postgres-to-neon-r2-v1";
const MAX_NEON_METADATA_BYTES = 750 * 1024 * 1024;
const MAX_R2_MIGRATION_BYTES = 9_500_000_000;

const TASK_COLUMNS = [
  "task_id", "scene_id", "prompt", "toolsets", "confirm_video_generation",
  "video_options", "status", "created_at", "claimed_at", "finished_at",
  "result", "error", "stage", "provider", "provider_job_id", "output_url",
  "storage_key", "reference_image_key", "heartbeat_at", "attempts", "claim_token"
];

function jsonValue(value, fallback = null) {
  return value == null ? fallback : JSON.stringify(value);
}

function contentTypeForKey(key, fallback = "application/octet-stream") {
  const extension = String(key).toLowerCase().split(".").pop();
  return ({
    mp4: "video/mp4", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", webp: "image/webp"
  })[extension] || fallback;
}

function makeTargetStorageEnv(env) {
  const accountId = env.MIGRATION_R2_ACCOUNT_ID || "";
  const endpoint = env.MIGRATION_R2_ENDPOINT ||
    (accountId ? "https://" + accountId + ".r2.cloudflarestorage.com" : "");
  return {
    OBJECT_STORAGE_BUCKET: env.MIGRATION_R2_BUCKET,
    OBJECT_STORAGE_ENDPOINT: endpoint,
    OBJECT_STORAGE_ACCESS_KEY_ID: env.MIGRATION_R2_ACCESS_KEY_ID,
    OBJECT_STORAGE_SECRET_ACCESS_KEY: env.MIGRATION_R2_SECRET_ACCESS_KEY,
    OBJECT_STORAGE_REGION: "auto"
  };
}

async function installTargetSchema(db) {
  await db.query(\`
    CREATE TABLE IF NOT EXISTS joyverse_tasks (
      task_id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      toolsets JSONB NOT NULL DEFAULT '[]'::jsonb,
      confirm_video_generation BOOLEAN NOT NULL DEFAULT FALSE,
      video_options JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL CHECK (status IN ('queued','claimed','completed','failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      result JSONB,
      error TEXT,
      stage TEXT NOT NULL DEFAULT 'queued',
      provider TEXT,
      provider_job_id TEXT,
      output_url TEXT,
      storage_key TEXT,
      reference_image_key TEXT,
      heartbeat_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT
    );
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS video_options JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued';
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS provider TEXT;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS provider_job_id TEXT;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS output_url TEXT;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS storage_key TEXT;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS reference_image_key TEXT;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE joyverse_tasks ADD COLUMN IF NOT EXISTS claim_token TEXT;

    CREATE TABLE IF NOT EXISTS joyverse_objects (
      object_key TEXT PRIMARY KEY,
      body BYTEA NOT NULL,
      content_type TEXT NOT NULL,
      byte_length BIGINT NOT NULL CHECK (byte_length > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS joyverse_bing_commands (
      command_id UUID PRIMARY KEY,
      command TEXT NOT NULL CHECK (command IN ('check_page','submit_scene')),
      scene_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      device_status TEXT,
      page TEXT,
      message TEXT,
      storage_key TEXT,
      byte_length BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS joyverse_storage_migrations (
      migration_id TEXT PRIMARY KEY,
      tasks_copied BIGINT NOT NULL,
      commands_copied BIGINT NOT NULL,
      objects_copied BIGINT NOT NULL,
      object_bytes BIGINT NOT NULL,
      metadata_bytes BIGINT NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS joyverse_objects_updated_idx ON joyverse_objects (updated_at);
    CREATE INDEX IF NOT EXISTS joyverse_tasks_queue_idx
      ON joyverse_tasks (created_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS joyverse_tasks_claim_idx
      ON joyverse_tasks (claimed_at) WHERE status = 'claimed';
    CREATE INDEX IF NOT EXISTS joyverse_tasks_provider_job_idx
      ON joyverse_tasks (provider, provider_job_id) WHERE provider_job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS joyverse_bing_commands_updated_idx
      ON joyverse_bing_commands (updated_at);
  \`);
}

async function sourceSnapshot(sourceDb) {
  const [taskCounts, commandCounts, objectRows, referenceRows, sizeRows] = await Promise.all([
    sourceDb.query("SELECT COUNT(*)::bigint AS count FROM joyverse_tasks"),
    sourceDb.query("SELECT COUNT(*)::bigint AS count FROM joyverse_bing_commands"),
    sourceDb.query("SELECT object_key, content_type, byte_length FROM joyverse_objects ORDER BY object_key"),
    sourceDb.query(\`
      SELECT storage_key AS object_key FROM joyverse_tasks WHERE storage_key IS NOT NULL
      UNION
      SELECT reference_image_key AS object_key FROM joyverse_tasks WHERE reference_image_key IS NOT NULL
      UNION
      SELECT storage_key AS object_key FROM joyverse_bing_commands WHERE storage_key IS NOT NULL
      ORDER BY object_key
    \`),
    sourceDb.query(\`
      SELECT (
        COALESCE(pg_total_relation_size(to_regclass('joyverse_tasks')),0) +
        COALESCE(pg_total_relation_size(to_regclass('joyverse_bing_commands')),0)
      )::bigint AS metadata_bytes
    \`)
  ]);
  const objectMetadata = new Map(objectRows.rows.map(row => [
    row.object_key, { contentType: row.content_type, byteLength: Number(row.byte_length || 0) }
  ]));
  const keys = new Set([
    ...objectMetadata.keys(),
    ...referenceRows.rows.map(row => row.object_key).filter(Boolean)
  ]);
  return {
    taskCount: Number(taskCounts.rows[0]?.count || 0),
    commandCount: Number(commandCounts.rows[0]?.count || 0),
    objectMetadata,
    objectKeys: [...keys].sort(),
    metadataBytes: Number(sizeRows.rows[0]?.metadata_bytes || 0)
  };
}

async function countTarget(db) {
  const [tasks, commands] = await Promise.all([
    db.query("SELECT COUNT(*)::bigint AS count FROM joyverse_tasks"),
    db.query("SELECT COUNT(*)::bigint AS count FROM joyverse_bing_commands")
  ]);
  return {
    tasks: Number(tasks.rows[0]?.count || 0),
    commands: Number(commands.rows[0]?.count || 0)
  };
}

async function copyTaskRows(sourceDb, targetDb) {
  const { rows } = await sourceDb.query(
    "SELECT " + TASK_COLUMNS.join(", ") + " FROM joyverse_tasks ORDER BY task_id"
  );
  const placeholders = TASK_COLUMNS.map((_, index) => "$" + (index + 1)).join(",");
  const updates = TASK_COLUMNS.slice(1).map(column =>
    column + " = EXCLUDED." + column
  ).join(", ");
  const sql = \`INSERT INTO joyverse_tasks (\${TASK_COLUMNS.join(", ")})
    VALUES (\${placeholders})
    ON CONFLICT (task_id) DO UPDATE SET \${updates}\`;
  for (const row of rows) {
    const values = TASK_COLUMNS.map(column => {
      if (column === "toolsets") return jsonValue(row[column], "[]");
      if (column === "video_options") return jsonValue(row[column], "{}");
      if (column === "result") return jsonValue(row[column]);
      return row[column] ?? null;
    });
    await targetDb.query(sql, values);
  }
  return rows.length;
}

async function copyCommandRows(sourceDb, targetDb) {
  const { rows } = await sourceDb.query(\`
    SELECT command_id, command, scene_id, status, device_status, page, message,
           storage_key, byte_length, created_at, updated_at
      FROM joyverse_bing_commands ORDER BY command_id
  \`);
  const sql = \`
    INSERT INTO joyverse_bing_commands
      (command_id, command, scene_id, status, device_status, page, message,
       storage_key, byte_length, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (command_id) DO UPDATE SET
      command=EXCLUDED.command, scene_id=EXCLUDED.scene_id, status=EXCLUDED.status,
      device_status=EXCLUDED.device_status, page=EXCLUDED.page, message=EXCLUDED.message,
      storage_key=EXCLUDED.storage_key, byte_length=EXCLUDED.byte_length,
      created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at
  \`;
  for (const row of rows) {
    await targetDb.query(sql, [
      row.command_id, row.command, row.scene_id, row.status, row.device_status,
      row.page, row.message, row.storage_key, row.byte_length,
      row.created_at, row.updated_at
    ]);
  }
  return rows.length;
}

async function copyObjects(snapshot, sourceStorage, targetStorage) {
  let totalBytes = 0;
  let copied = 0;
  for (const key of snapshot.objectKeys) {
    const sourceBody = await sourceStorage.get(key);
    if (!Buffer.isBuffer(sourceBody) || sourceBody.length === 0) {
      throw new Error("Source object is empty or invalid: " + key);
    }
    totalBytes += sourceBody.length;
    if (totalBytes > MAX_R2_MIGRATION_BYTES) {
      throw new Error("Object data exceeds the safe 9.5 GB R2 migration ceiling. Do not switch storage.");
    }
    const metadata = snapshot.objectMetadata.get(key);
    const contentType = metadata?.contentType || contentTypeForKey(key);
    await targetStorage.put(key, sourceBody, contentType);
    const copiedBody = await targetStorage.get(key);
    const sourceHash = createHash("sha256").update(sourceBody).digest("hex");
    const copiedHash = createHash("sha256").update(copiedBody).digest("hex");
    if (sourceHash !== copiedHash || copiedBody.length !== sourceBody.length) {
      throw new Error("Object verification failed after copy: " + key);
    }
    copied += 1;
  }
  return { copied, bytes: totalBytes };
}

export async function runStorageMigration({
  sourceDb,
  targetDb: suppliedTargetDb,
  sourceStorage,
  targetStorage,
  env = process.env,
  action = "plan"
} = {}) {
  if (!sourceDb) throw new Error("The existing DATABASE_URL connection is required.");
  if (!["plan", "migrate"].includes(action)) throw new Error("Migration action must be plan or migrate.");

  const targetUrl = env.MIGRATION_TARGET_DATABASE_URL;
  if (!suppliedTargetDb && !targetUrl) throw new Error("MIGRATION_TARGET_DATABASE_URL is not configured.");
  const targetEnv = makeTargetStorageEnv(env);
  const ownTargetDb = !suppliedTargetDb;
  const targetDb = suppliedTargetDb || new Pool({
    connectionString: targetUrl,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000
  });

  try {
    const oldStorage = sourceStorage || createObjectStorage({ env });
    const newStorage = targetStorage || createObjectStorage({ env: targetEnv });
    if (newStorage.backend !== "s3") {
      throw new Error("The migration destination must be an S3-compatible R2 bucket.");
    }
    await targetDb.query("SELECT 1 AS connected");
    const snapshot = await sourceSnapshot(sourceDb);
    const objectMetadataBytes = [...snapshot.objectMetadata.values()]
      .reduce((sum, row) => sum + row.byteLength, 0);

    if (snapshot.metadataBytes > MAX_NEON_METADATA_BYTES) {
      throw new Error("Task and command metadata exceed the safe 750 MiB Neon migration ceiling.");
    }
    if (objectMetadataBytes > MAX_R2_MIGRATION_BYTES) {
      throw new Error("PostgreSQL object metadata exceeds the safe R2 migration ceiling.");
    }

    const plan = {
      action,
      source: "Render PostgreSQL",
      destination: "Neon PostgreSQL + Cloudflare R2",
      tasks: snapshot.taskCount,
      deviceCommands: snapshot.commandCount,
      uniqueObjects: snapshot.objectKeys.length,
      knownObjectBytes: objectMetadataBytes,
      metadataBytes: snapshot.metadataBytes,
      neonMetadataLimitBytes: MAX_NEON_METADATA_BYTES,
      r2MigrationLimitBytes: MAX_R2_MIGRATION_BYTES,
      destinationDatabaseConnected: true,
      destinationObjectStorageConfigured: true
    };
    if (action === "plan") return { ...plan, migrated: false };

    await installTargetSchema(targetDb);
    const existingMarker = await targetDb.query(
      "SELECT migration_id FROM joyverse_storage_migrations WHERE migration_id=$1",
      [MIGRATION_ID]
    );
    const initialTargetCounts = await countTarget(targetDb);
    if (!existingMarker.rows.length && (initialTargetCounts.tasks || initialTargetCounts.commands)) {
      throw new Error("The destination database is not empty. No data was overwritten; use a fresh Neon project for this migration.");
    }

    const objectResult = await copyObjects(snapshot, oldStorage, newStorage);
    await targetDb.query("BEGIN");
    try {
      const tasksCopied = await copyTaskRows(sourceDb, targetDb);
      const commandsCopied = await copyCommandRows(sourceDb, targetDb);
      await targetDb.query(\`
        INSERT INTO joyverse_storage_migrations
          (migration_id, tasks_copied, commands_copied, objects_copied, object_bytes, metadata_bytes, completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (migration_id) DO UPDATE SET
          tasks_copied=EXCLUDED.tasks_copied,
          commands_copied=EXCLUDED.commands_copied,
          objects_copied=EXCLUDED.objects_copied,
          object_bytes=EXCLUDED.object_bytes,
          metadata_bytes=EXCLUDED.metadata_bytes,
          completed_at=NOW()
      \`, [MIGRATION_ID, tasksCopied, commandsCopied, objectResult.copied,
        objectResult.bytes, snapshot.metadataBytes]);
      await targetDb.query("COMMIT");
      const verifiedCounts = await countTarget(targetDb);
      if (verifiedCounts.tasks < snapshot.taskCount ||
          verifiedCounts.commands < snapshot.commandCount) {
        throw new Error("Destination row-count verification failed. Keep the old database active.");
      }
      return {
        ...plan,
        migrated: true,
        tasksCopied,
        deviceCommandsCopied: commandsCopied,
        objectsCopied: objectResult.copied,
        objectBytesVerified: objectResult.bytes,
        destinationCounts: verifiedCounts,
        sourcePreserved: true,
        cutoverPerformed: false
      };
    } catch (error) {
      await targetDb.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    if (ownTargetDb) await targetDb.end().catch(() => {});
  }
}
