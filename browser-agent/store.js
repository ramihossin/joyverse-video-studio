import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const SITES_FILE = path.join(DATA_DIR, "sites.json");
const KEY_FILE = path.join(DATA_DIR, "session-master.key");
let pool;
let key;
let localSites = {};
let localSessions = {};

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}
async function writeJsonAtomic(file, value) {
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}
function parseEncryptionKey(value) {
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 32) return decoded;
  throw new Error("SESSION_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters or base64.");
}
const DEFAULT_SITES = [
  {
    id: "loremotion-free-video",
    name: "LoreMotion — توليد الفيديو",
    baseUrl: "https://loremotion.com/generate/",
    loginUrl: "",
    allowedHosts: ["loremotion.com", "www.loremotion.com"],
    purpose: "video",
    selectors: { promptSelector: "", uploadSelector: "", generateSelector: "", readySelector: "", downloadSelector: "" },
    waitSeconds: 300,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z"
  },
  {
    id: "taaft-discovery",
    name: "There's An AI For That — دليل اكتشاف الأدوات",
    baseUrl: "https://theresanaiforthat.com/",
    loginUrl: "",
    allowedHosts: ["theresanaiforthat.com", "www.theresanaiforthat.com"],
    purpose: "directory",
    selectors: { promptSelector: "", uploadSelector: "", generateSelector: "", readySelector: "", downloadSelector: "" },
    waitSeconds: 300,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z"
  },
  {
    id: "pavo-ai-video",
    name: "Pavo AI — توليد الفيديو",
    baseUrl: "https://app.pavo-ai.work/",
    loginUrl: "",
    allowedHosts: ["app.pavo-ai.work"],
    purpose: "video",
    selectors: { promptSelector: "", uploadSelector: "", generateSelector: "", readySelector: "", downloadSelector: "" },
    waitSeconds: 360,
    createdAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z"
  }
];

function migrateLegacySite(site) {
  if (!site) return null;
  const next = { ...site };
  let changed = false;
  if (next.id === "loremotion-free-video" && next.loginUrl === "https://loremotion.com/auth") {
    next.loginUrl = "";
    changed = true;
  }
  if (next.id === "pavo-ai-video") {
    const canonicalBase = "https://app.pavo-ai.work/";
    const canonicalHosts = ["app.pavo-ai.work"];
    if (next.baseUrl !== canonicalBase || next.loginUrl !== "" ||
        JSON.stringify(next.allowedHosts || []) !== JSON.stringify(canonicalHosts)) {
      next.baseUrl = canonicalBase;
      next.loginUrl = "";
      next.allowedHosts = canonicalHosts;
      changed = true;
    }
  }
  if (!changed) return null;
  next.updatedAt = new Date().toISOString();
  return next;
}

export async function initStore() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  if (process.env.SESSION_ENCRYPTION_KEY) key = parseEncryptionKey(process.env.SESSION_ENCRYPTION_KEY);
  else {
    if (process.env.DATABASE_URL) throw new Error("Set SESSION_ENCRYPTION_KEY when DATABASE_URL is configured; never store session data with an ephemeral encryption key.");
    try { key = await fs.readFile(KEY_FILE); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      key = randomBytes(32);
      await fs.writeFile(KEY_FILE, key, { mode: 0o600, flag: "wx" });
    }
    if (key.length !== 32) throw new Error("Invalid local session master key.");
  }
  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS joyverse_browser_sites (
        site_id TEXT PRIMARY KEY,
        config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS joyverse_browser_sessions (
        site_id TEXT PRIMARY KEY,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    for (const site of DEFAULT_SITES) {
      await pool.query(
        "INSERT INTO joyverse_browser_sites(site_id,config,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(site_id) DO NOTHING",
        [site.id, site]
      );
      const existing = await pool.query("SELECT config FROM joyverse_browser_sites WHERE site_id=$1", [site.id]);
      const migrated = migrateLegacySite(existing.rows[0]?.config);
      if (migrated) {
        await pool.query(
          "UPDATE joyverse_browser_sites SET config=$2,updated_at=NOW() WHERE site_id=$1",
          [site.id, migrated]
        );
      }
    }
  } else {
    localSites = await readJson(SITES_FILE, {});
    localSessions = await readJson(path.join(DATA_DIR, "sessions.json"), {});
    let seeded = false;
    for (const site of DEFAULT_SITES) {
      if (!localSites[site.id]) { localSites[site.id] = site; seeded = true; }
      else {
        const migrated = migrateLegacySite(localSites[site.id]);
        if (migrated) { localSites[site.id] = migrated; seeded = true; }
      }
    }
    if (seeded) await writeJsonAtomic(SITES_FILE, localSites);
  }
}
function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
function decrypt(record) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  const clear = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(clear.toString("utf8"));
}
export async function listSites() {
  if (pool) {
    const result = await pool.query("SELECT config FROM joyverse_browser_sites ORDER BY updated_at DESC");
    return result.rows.map(row => row.config);
  }
  return Object.values(localSites);
}
export async function getSite(siteId) {
  if (pool) {
    const result = await pool.query("SELECT config FROM joyverse_browser_sites WHERE site_id=$1", [siteId]);
    return result.rows[0]?.config || null;
  }
  return localSites[siteId] || null;
}
export async function saveSite(config) {
  if (pool) await pool.query(
    "INSERT INTO joyverse_browser_sites(site_id,config,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(site_id) DO UPDATE SET config=EXCLUDED.config,updated_at=NOW()",
    [config.id, config]
  );
  else {
    localSites[config.id] = config;
    await writeJsonAtomic(SITES_FILE, localSites);
  }
  return config;
}
export async function deleteSite(siteId) {
  if (pool) {
    await pool.query("DELETE FROM joyverse_browser_sites WHERE site_id=$1", [siteId]);
    await pool.query("DELETE FROM joyverse_browser_sessions WHERE site_id=$1", [siteId]);
  } else {
    delete localSites[siteId];
    delete localSessions[siteId];
    await writeJsonAtomic(SITES_FILE, localSites);
    await writeJsonAtomic(path.join(DATA_DIR, "sessions.json"), localSessions);
  }
}
export async function getSession(siteId) {
  let record;
  if (pool) {
    const result = await pool.query("SELECT iv,auth_tag,ciphertext FROM joyverse_browser_sessions WHERE site_id=$1", [siteId]);
    const row = result.rows[0];
    if (!row) return null;
    record = { iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext };
  } else record = localSessions[siteId];
  return record ? decrypt(record) : null;
}
export async function deleteSession(siteId) {
  if (pool) await pool.query("DELETE FROM joyverse_browser_sessions WHERE site_id=$1", [siteId]);
  else {
    delete localSessions[siteId];
    await writeJsonAtomic(path.join(DATA_DIR, "sessions.json"), localSessions);
  }
}
export async function saveSession(siteId, session) {
  const record = encrypt(session);
  if (pool) await pool.query(
    "INSERT INTO joyverse_browser_sessions(site_id,iv,auth_tag,ciphertext,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(site_id) DO UPDATE SET iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,ciphertext=EXCLUDED.ciphertext,updated_at=NOW()",
    [siteId, record.iv, record.authTag, record.ciphertext]
  );
  else {
    localSessions[siteId] = record;
    await writeJsonAtomic(path.join(DATA_DIR, "sessions.json"), localSessions);
  }
  return true;
}
export async function getDataDir() { return DATA_DIR; }
