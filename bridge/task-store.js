import pg from "pg";

const { Pool } = pg;
let pool;

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
  const db = getTaskPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS joyverse_tasks (
      task_id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      toolsets JSONB NOT NULL DEFAULT '[]'::jsonb,
      confirm_video_generation BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL CHECK (status IN ('queued','claimed','completed','failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      result JSONB,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS joyverse_tasks_queue_idx
      ON joyverse_tasks (created_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS joyverse_tasks_claim_idx
      ON joyverse_tasks (claimed_at) WHERE status = 'claimed';
  `);
}

export async function enqueueTask(task) {
  const db = getTaskPool();
  await db.query(
    `INSERT INTO joyverse_tasks
      (task_id, scene_id, prompt, toolsets, confirm_video_generation, status, created_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,'queued',$6)`,
    [task.task_id, task.scene_id, task.prompt, JSON.stringify(task.toolsets),
      task.confirm_video_generation === true, task.created_at || new Date().toISOString()]
  );
  return getTask(task.task_id);
}

export async function getTask(taskId) {
  const db = getTaskPool();
  const { rows } = await db.query(
    `SELECT task_id, scene_id, prompt, toolsets, confirm_video_generation,
            status, created_at, claimed_at, finished_at, result, error
       FROM joyverse_tasks WHERE task_id = $1`, [taskId]
  );
  return rows[0] || null;
}

export async function claimNextTask() {
  const db = getTaskPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT task_id FROM joyverse_tasks
       WHERE status = 'queued'
          OR (status = 'claimed' AND claimed_at < NOW() - INTERVAL '5 minutes')
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1
    `);
    if (!rows.length) {
      await client.query("COMMIT");
      return null;
    }
    const { rows: claimed } = await client.query(`
      UPDATE joyverse_tasks SET status='claimed', claimed_at=NOW()
       WHERE task_id=$1
       RETURNING task_id, scene_id, prompt, toolsets, confirm_video_generation
    `, [rows[0].task_id]);
    await client.query("COMMIT");
    return claimed[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finishTask(taskId, status, result, error) {
  const db = getTaskPool();
  const { rows } = await db.query(`
    UPDATE joyverse_tasks
       SET status=$2, result=$3::jsonb, error=$4, finished_at=NOW()
     WHERE task_id=$1 AND status='claimed'
     RETURNING task_id, status
  `, [taskId, status, result == null ? null : JSON.stringify(result),
    status === "failed" ? String(error || "Task failed").slice(0, 1000) : null]);
  return rows[0] || null;
}

export async function getQueueCounts() {
  const db = getTaskPool();
  const { rows } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='queued')::int AS queued,
      COUNT(*) FILTER (WHERE status='claimed')::int AS active
    FROM joyverse_tasks
  `);
  return rows[0] || { queued: 0, active: 0 };
}
