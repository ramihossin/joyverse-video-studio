import test from "node:test";
import assert from "node:assert/strict";
import { runStorageMigration } from "../bridge/storage-migration.js";

const task = {
  task_id: "hermes_test-1", scene_id: "scene-1", prompt: "A bright test scene.",
  toolsets: ["video_gen"], confirm_video_generation: true, video_options: { aspect: "16:9", duration: 3 },
  status: "completed", created_at: new Date("2026-01-01T00:00:00Z"),
  claimed_at: null, finished_at: new Date("2026-01-01T00:00:10Z"),
  result: { storage_key: "jobs/hermes_test-1/scene-1.mp4", bytes: 5 },
  error: null, stage: "completed", provider: "ltx-gradio", provider_job_id: null,
  output_url: null, storage_key: "jobs/hermes_test-1/scene-1.mp4",
  reference_image_key: null, heartbeat_at: new Date("2026-01-01T00:00:10Z"),
  attempts: 1, claim_token: "test-claim-token"
};
const command = {
  command_id: "123e4567-e89b-42d3-a456-426614174000", command: "submit_scene",
  scene_id: "scene-1", status: "completed", device_status: "success",
  page: "https://example.test", message: "done",
  storage_key: null, byte_length: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:10Z")
};
const clip = Buffer.from("test-video");

function createSourceDb() {
  return {
    async query(sql) {
      if (sql.includes("COUNT(*)") && sql.includes("joyverse_tasks")) return { rows: [{ count: "1" }] };
      if (sql.includes("COUNT(*)") && sql.includes("joyverse_bing_commands")) return { rows: [{ count: "1" }] };
      if (sql.includes("SELECT object_key, content_type, byte_length")) {
        return { rows: [{ object_key: task.storage_key, content_type: "video/mp4", byte_length: String(clip.length) }] };
      }
      if (sql.includes("SELECT storage_key AS object_key")) return { rows: [{ object_key: task.storage_key }] };
      if (sql.includes("pg_total_relation_size")) return { rows: [{ metadata_bytes: "1024" }] };
      if (sql.includes("FROM joyverse_tasks ORDER BY task_id")) return { rows: [task] };
      if (sql.includes("FROM joyverse_bing_commands ORDER BY command_id")) return { rows: [command] };
      throw new Error("Unexpected source SQL: " + sql);
    }
  };
}

function createTargetDb(initialCounts = { tasks: 0, commands: 0 }) {
  const state = { tasks: [], commands: [], marker: false, writes: 0 };
  return {
    state,
    async query(sql, values = []) {
      if (sql === "SELECT 1 AS connected") return { rows: [{ connected: 1 }] };
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("BEGIN") ||
          sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK") ||
          sql.startsWith("CREATE INDEX") || sql.startsWith("ALTER TABLE")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT migration_id FROM joyverse_storage_migrations")) {
        return { rows: state.marker ? [{ migration_id: "render-postgres-to-neon-r2-v1" }] : [] };
      }
      if (sql.includes("SELECT COUNT(*)") && sql.includes("joyverse_tasks")) {
        return { rows: [{ count: String(state.tasks.length || initialCounts.tasks) }] };
      }
      if (sql.includes("SELECT COUNT(*)") && sql.includes("joyverse_bing_commands")) {
        return { rows: [{ count: String(state.commands.length || initialCounts.commands) }] };
      }
      if (sql.includes("INSERT INTO joyverse_tasks")) {
        state.tasks.push(values);
        state.writes += 1;
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO joyverse_bing_commands")) {
        state.commands.push(values);
        state.writes += 1;
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO joyverse_storage_migrations")) {
        state.marker = true;
        state.writes += 1;
        return { rows: [] };
      }
      throw new Error("Unexpected target SQL: " + sql);
    }
  };
}

function createStoragePair() {
  const values = new Map([[task.storage_key, clip]]);
  return {
    source: { get: async key => Buffer.from(values.get(key)) },
    target: {
      backend: "s3",
      put: async (key, body, contentType) => {
        values.set(key, Buffer.from(body));
        assert.equal(contentType, "video/mp4");
        return { key, size: body.length, content_type: contentType };
      },
      get: async key => Buffer.from(values.get(key))
    }
  };
}

test("migration plan reports source counts without writing data", async () => {
  const targetDb = createTargetDb();
  const storage = createStoragePair();
  const result = await runStorageMigration({
    sourceDb: createSourceDb(), targetDb, sourceStorage: storage.source,
    targetStorage: storage.target, action: "plan", env: {}
  });
  assert.equal(result.tasks, 1);
  assert.equal(result.deviceCommands, 1);
  assert.equal(result.uniqueObjects, 1);
  assert.equal(result.migrated, false);
  assert.equal(targetDb.state.writes, 0);
});

test("migration copies task rows, device commands, and verifies object bytes", async () => {
  const targetDb = createTargetDb();
  const storage = createStoragePair();
  const result = await runStorageMigration({
    sourceDb: createSourceDb(), targetDb, sourceStorage: storage.source,
    targetStorage: storage.target, action: "migrate", env: {}
  });
  assert.equal(result.migrated, true);
  assert.equal(result.tasksCopied, 1);
  assert.equal(result.deviceCommandsCopied, 1);
  assert.equal(result.objectsCopied, 1);
  assert.equal(result.objectBytesVerified, clip.length);
  assert.equal(result.sourcePreserved, true);
  assert.equal(result.cutoverPerformed, false);
  assert.equal(targetDb.state.tasks.length, 1);
  assert.equal(targetDb.state.commands.length, 1);
  assert.equal(targetDb.state.marker, true);
});

test("migration refuses a populated destination without a JoyVerse migration marker", async () => {
  const targetDb = createTargetDb({ tasks: 2, commands: 0 });
  const storage = createStoragePair();
  await assert.rejects(runStorageMigration({
    sourceDb: createSourceDb(), targetDb, sourceStorage: storage.source,
    targetStorage: storage.target, action: "migrate", env: {}
  }), /destination database is not empty/i);
  assert.equal(targetDb.state.writes, 0);
});
