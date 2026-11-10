import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;
let pool;
const testMemoryEnabled = process.env.NODE_ENV === "test" &&
  process.env.JOYVERSE_TEST_MEMORY_STORE === "1";
const testTasks = new Map();

export function getTaskPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for durable task storage.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

export async function initializeTaskStore() {
  if (testMemoryEnabled) return;
  const db = getTaskPool();
  await db.query(`
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
    CREATE INDEX IF NOT EXISTS joyverse_tasks_queue_idx
      ON joyverse_tasks (created_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS joyverse_tasks_claim_idx
      ON joyverse_tasks (claimed_at) WHERE status = 'claimed';
    CREATE INDEX IF NOT EXISTS joyverse_tasks_provider_job_idx
      ON joyverse_tasks (provider, provider_job_id) WHERE provider_job_id IS NOT NULL;
  `);
}

export async function enqueueTask(task) {
  if (testMemoryEnabled) {
    if (testTasks.has(task.task_id)) throw new Error("Task already exists.");
    testTasks.set(task.task_id, {
      ...task, toolsets: [...task.toolsets], video_options: { ...(task.video_options || {}) }, status: "queued",
      stage: "queued", provider: null, provider_job_id: null,
      output_url: null, storage_key: null, reference_image_key: task.reference_image_key || null, heartbeat_at: null, attempts: 0, claim_token: null,
      created_at: task.created_at || new Date().toISOString()
    });
    return getTask(task.task_id);
  }
  const db = getTaskPool();
  await db.query(
    `INSERT INTO joyverse_tasks
      (task_id, scene_id, prompt, toolsets, confirm_video_generation, video_options, status, created_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'queued',$7)`,
    [task.task_id, task.scene_id, task.prompt, JSON.stringify(task.toolsets),
      task.confirm_video_generation === true, JSON.stringify(task.video_options || {}), task.created_at || new Date().toISOString()]
  );
  return getTask(task.task_id);
}

export async function setTaskReferenceImage(taskId, key) {
  if (typeof taskId !== "string" || !taskId || typeof key !== "string" ||
      !key.startsWith("references/") || key.length > 512) {
    throw new Error("Invalid reference image association.");
  }
  if (testMemoryEnabled) {
    const task = testTasks.get(taskId);
    if (!task || task.status !== "queued" || task.confirm_video_generation !== true ||
        !Array.isArray(task.toolsets) || !task.toolsets.includes("video_gen")) return null;
    task.reference_image_key = key;
    return { task_id: taskId, reference_image_key: key };
  }
  const db = getTaskPool();
  const { rows } = await db.query(
    `UPDATE joyverse_tasks SET reference_image_key=$2
      WHERE task_id=$1 AND status='queued'
        AND confirm_video_generation=TRUE AND toolsets @> '["video_gen"]'::jsonb
      RETURNING task_id, reference_image_key`, [taskId, key]
  );
  return rows[0] || null;
}

export async function getTask(taskId) {
  if (testMemoryEnabled) return testTasks.get(taskId) || null;
  const db = getTaskPool();
  const { rows } = await db.query(
    `SELECT task_id, scene_id, prompt, toolsets, confirm_video_generation, video_options,
            status, created_at, claimed_at, finished_at, result, error,
            stage, provider, provider_job_id, output_url, storage_key, reference_image_key,
            heartbeat_at, attempts
       FROM joyverse_tasks WHERE task_id = $1`, [taskId]
  );
  return rows[0] || null;
}

// Persist provider progress before long-running work so a restarted worker can
// resume polling an existing provider job instead of submitting a duplicate.
export async function updateTaskCheckpoint(taskId, claimToken, checkpoint = {}) {
  if (typeof claimToken !== "string" || claimToken.length < 32) return null;
  const allowedStages = new Set([
    "queued", "preparing", "submitting", "provider_queued",
    "generating", "downloading", "assembling", "uploading", "completed"
  ]);
  const stage = checkpoint.stage;
  if (stage !== undefined && !allowedStages.has(stage)) {
    throw new Error("Invalid task checkpoint stage.");
  }
  const fields = {
    provider: checkpoint.provider,
    provider_job_id: checkpoint.provider_job_id,
    output_url: checkpoint.output_url,
    storage_key: checkpoint.storage_key
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null &&
        (typeof value !== "string" || value.length > 2048)) {
      throw new Error("Invalid task checkpoint field: " + key);
    }
  }

  if (testMemoryEnabled) {
    const task = testTasks.get(taskId);
    if (!task || task.status !== "claimed" || task.claim_token !== claimToken) return null;
    if (stage !== undefined) task.stage = stage;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) task[key] = value;
    }
    task.heartbeat_at = new Date().toISOString();
    return {
      task_id: taskId, stage: task.stage, provider: task.provider,
      provider_job_id: task.provider_job_id, output_url: task.output_url,
      storage_key: task.storage_key
    };
  }

  const db = getTaskPool();
  const { rows } = await db.query(`
    UPDATE joyverse_tasks
       SET stage = COALESCE($2, stage),
           provider = COALESCE($3, provider),
           provider_job_id = COALESCE($4, provider_job_id),
           output_url = COALESCE($5, output_url),
           storage_key = COALESCE($6, storage_key),
           heartbeat_at = NOW()
     WHERE task_id = $1 AND status = 'claimed' AND claim_token = $7
     RETURNING task_id, stage, provider, provider_job_id, output_url, storage_key
  `, [taskId, stage ?? null, fields.provider ?? null,
    fields.provider_job_id ?? null, fields.output_url ?? null,
    fields.storage_key ?? null, claimToken]);
  return rows[0] || null;
}

export async function claimNextTask() {
  if (testMemoryEnabled) {
    const now = Date.now();
    const task = [...testTasks.values()].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ).find(item => item.status === "queued" ||
      (item.status === "claimed" && item.claimed_at &&
       now - new Date(item.claimed_at).getTime() > 5 * 60 * 1000));
    if (!task) return null;
    task.status = "claimed";
    task.claim_token = randomUUID();
    task.claimed_at = new Date().toISOString();
    task.attempts = (task.attempts || 0) + 1;
    return {
      task_id: task.task_id, scene_id: task.scene_id, prompt: task.prompt,
      toolsets: task.toolsets, confirm_video_generation: task.confirm_video_generation,
      video_options: task.video_options || {}, stage: task.stage, provider: task.provider, provider_job_id: task.provider_job_id,
      output_url: task.output_url, storage_key: task.storage_key, reference_image_key: task.reference_image_key || null, attempts: task.attempts,
      claim_token: task.claim_token
    };
  }
  const db = getTaskPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT task_id FROM joyverse_tasks
       WHERE status = 'queued'
          OR (status = 'claimed' AND COALESCE(heartbeat_at, claimed_at) < NOW() - INTERVAL '5 minutes')
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    `);
    if (!rows.length) {
      await client.query("COMMIT");
      return null;
    }
    const { rows: claimed } = await client.query(`
      UPDATE joyverse_tasks
         SET status='claimed', claimed_at=NOW(), heartbeat_at=NOW(),
             attempts=attempts+1, claim_token=$2
       WHERE task_id=$1
       RETURNING task_id, scene_id, prompt, toolsets, confirm_video_generation,
                 video_options, stage, provider, provider_job_id, output_url, storage_key, reference_image_key, attempts, claim_token
    `, [rows[0].task_id, randomUUID()]);
    await client.query("COMMIT");
    return claimed[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNextVideoTask() {
  if (testMemoryEnabled) {
    const now = Date.now();
    const task = [...testTasks.values()].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ).find(item => item.confirm_video_generation === true &&
      Array.isArray(item.toolsets) && item.toolsets.includes("video_gen") &&
      (item.status === "queued" ||
       (item.status === "claimed" && item.claimed_at &&
        now - new Date(item.claimed_at).getTime() > 5 * 60 * 1000)));
    if (!task) return null;
    task.status = "claimed";
    task.claim_token = randomUUID();
    task.claimed_at = new Date().toISOString();
    task.heartbeat_at = task.claimed_at;
    task.attempts = (task.attempts || 0) + 1;
    return {
      task_id: task.task_id, scene_id: task.scene_id, prompt: task.prompt,
      toolsets: task.toolsets, confirm_video_generation: task.confirm_video_generation,
      video_options: task.video_options || {}, stage: task.stage,
      provider: task.provider, provider_job_id: task.provider_job_id,
      output_url: task.output_url, storage_key: task.storage_key,
      attempts: task.attempts, claim_token: task.claim_token
    };
  }

  const db = getTaskPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT task_id FROM joyverse_tasks
       WHERE confirm_video_generation = TRUE
         AND toolsets @> '["video_gen"]'::jsonb
         AND (
           status = 'queued'
           OR (status = 'claimed' AND COALESCE(heartbeat_at, claimed_at) < NOW() - INTERVAL '5 minutes')
         )
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    `);
    if (!rows.length) {
      await client.query("COMMIT");
      return null;
    }
    const { rows: claimed } = await client.query(`
      UPDATE joyverse_tasks
         SET status='claimed', claimed_at=NOW(), heartbeat_at=NOW(),
             attempts=attempts+1, claim_token=$2
       WHERE task_id=$1
       RETURNING task_id, scene_id, prompt, toolsets, confirm_video_generation,
                 video_options, stage, provider, provider_job_id, output_url, storage_key, attempts, claim_token
    `, [rows[0].task_id, randomUUID()]);
    await client.query("COMMIT");
    return claimed[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finishTask(taskId, claimToken, status, result, error) {
  if (typeof claimToken !== "string" || claimToken.length < 32) return null;
  if (testMemoryEnabled) {
    const task = testTasks.get(taskId);
    if (!task || task.status !== "claimed" || task.claim_token !== claimToken) return null;
    task.status = status;
    task.stage = status;
    task.result = result ?? null;
    task.error = status === "failed" ? String(error || "Task failed").slice(0, 1000) : null;
    task.finished_at = new Date().toISOString();
    task.heartbeat_at = task.finished_at;
    return { task_id: taskId, status };
  }
  const db = getTaskPool();
  const { rows } = await db.query(`
    UPDATE joyverse_tasks
       SET status=$2, stage=$2, result=$3::jsonb, error=$4,
           finished_at=NOW(), heartbeat_at=NOW()
     WHERE task_id=$1 AND status='claimed' AND claim_token=$5
     RETURNING task_id, status
  `, [taskId, status, result == null ? null : JSON.stringify(result),
    status === "failed" ? String(error || "Task failed").slice(0, 1000) : null, claimToken]);
  return rows[0] || null;
}

export async function getQueueCounts() {
  if (testMemoryEnabled) {
    const values = [...testTasks.values()];
    return {
      queued: values.filter(task => task.status === "queued").length,
      active: values.filter(task => task.status === "claimed").length
    };
  }
  const db = getTaskPool();
  const { rows } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE status='claimed')::int AS active
    FROM joyverse_tasks
  `);
  return rows[0] || { queued: 0, active: 0 };
}
