/**
 * storage.ts — SQLite-backed storage layer for PAI MEMORY.
 *
 * Replaces filesystem-based MEMORY I/O with a single bun:sqlite database.
 * WAL mode enabled for Litestream replication compatibility and concurrent reads.
 *
 * Usage:
 *   import { getDb, readState, writeState } from './lib/storage';
 *   writeState('STATE', 'identity', { name: 'PAI' });
 *   const identity = readState('STATE', 'identity');
 */

import { Database } from "bun:sqlite";
import { getMemoryDir } from "./paths";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// ── Types ──

export interface WorkSession {
  id: string;
  sessionId: string | null;
  title: string | null;
  status: string;
  meta: unknown;
  createdAt: string;
  completedAt: string | null;
}

export interface WorkTask {
  id: number;
  sessionId: string;
  taskNumber: number;
  slug: string;
  isc: unknown;
  thread: string | null;
  createdAt: string;
}

export interface Learning {
  id: number;
  category: string;
  source: string;
  title: string;
  content: string;
  createdAt: string;
}

// ── Schema ──

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (namespace, key)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  timestamp TEXT DEFAULT (datetime('now')),
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ns_ts ON logs(namespace, timestamp);

CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  title TEXT,
  status TEXT DEFAULT 'ACTIVE',
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS work_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES work_sessions(id),
  task_number INTEGER,
  slug TEXT,
  isc TEXT,
  thread TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  source TEXT,
  title TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

// ── Singleton ──

let _db: Database | null = null;

/**
 * Initialize the database. Call once; idempotent.
 * Enables WAL mode for Litestream compatibility and concurrent reads.
 */
export function initDb(dbPath?: string): Database {
  if (_db) {
    _db.close();
    _db = null;
  }

  const resolvedPath = dbPath ?? join(getMemoryDir(), "pai.db");

  // Ensure parent directory exists for file-backed databases
  if (resolvedPath !== ":memory:") {
    const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  _db = new Database(resolvedPath);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(SCHEMA);

  return _db;
}

/**
 * Get the singleton database instance. Lazily initializes if needed.
 */
export function getDb(): Database {
  if (!_db) {
    initDb();
  }
  return _db!;
}

/**
 * Close and reset the singleton. Used by tests for cleanup.
 */
export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── State operations (key-value store) ──

export function readState<T = unknown>(
  namespace: string,
  key: string
): T | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM state WHERE namespace = ? AND key = ?")
    .get(namespace, key) as { value: string } | null;

  if (!row) return null;
  return JSON.parse(row.value) as T;
}

export function writeState(
  namespace: string,
  key: string,
  value: unknown
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO state (namespace, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(namespace, key, JSON.stringify(value));
}

export function readStateWithMeta<T = unknown>(
  namespace: string,
  key: string
): { value: T; updatedAt: string } | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value, updated_at FROM state WHERE namespace = ? AND key = ?")
    .get(namespace, key) as { value: string; updated_at: string } | null;

  if (!row) return null;
  return { value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
}

export function deleteState(namespace: string, key: string): void {
  const db = getDb();
  db.prepare("DELETE FROM state WHERE namespace = ? AND key = ?").run(
    namespace,
    key
  );
}

export function listKeys(namespace: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT key FROM state WHERE namespace = ?")
    .all(namespace) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

// ── Log operations (append-only) ──

export function appendLog(namespace: string, value: unknown): void {
  const db = getDb();
  db.prepare("INSERT INTO logs (namespace, value) VALUES (?, ?)").run(
    namespace,
    JSON.stringify(value)
  );
}

export function queryLogs<T = unknown>(
  namespace: string,
  opts?: { since?: string; limit?: number }
): Array<{ id: number; timestamp: string; value: T }> {
  const db = getDb();
  let sql = "SELECT id, timestamp, value FROM logs WHERE namespace = ?";
  const params: Array<string | number> = [namespace];

  if (opts?.since) {
    sql += " AND timestamp >= ?";
    params.push(opts.since);
  }

  sql += " ORDER BY id ASC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    timestamp: string;
    value: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    value: JSON.parse(r.value) as T,
  }));
}

// ── Work session operations ──

export function createWorkSession(session: {
  id: string;
  sessionId: string;
  title: string;
  meta?: unknown;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO work_sessions (id, session_id, title, meta)
     VALUES (?, ?, ?, ?)`
  ).run(
    session.id,
    session.sessionId,
    session.title,
    session.meta ? JSON.stringify(session.meta) : null
  );
}

export function getWorkSession(id: string): WorkSession | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM work_sessions WHERE id = ?").get(id) as
    | {
        id: string;
        session_id: string | null;
        title: string | null;
        status: string;
        meta: string | null;
        created_at: string;
        completed_at: string | null;
      }
    | null;

  if (!row) return null;

  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    meta: row.meta ? JSON.parse(row.meta) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function listWorkSessions(status?: string): WorkSession[] {
  const db = getDb();
  let sql = "SELECT * FROM work_sessions";
  const params: string[] = [];

  if (status) {
    sql += " WHERE status = ?";
    params.push(status);
  }

  sql += " ORDER BY created_at DESC";

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    session_id: string | null;
    title: string | null;
    status: string;
    meta: string | null;
    created_at: string;
    completed_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    meta: row.meta ? JSON.parse(row.meta) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }));
}

export function completeWorkSession(id: string, meta?: unknown): void {
  const db = getDb();
  db.prepare(
    `UPDATE work_sessions
     SET status = 'COMPLETED', completed_at = datetime('now'), meta = COALESCE(?, meta)
     WHERE id = ?`
  ).run(meta ? JSON.stringify(meta) : null, id);
}

// ── Work task operations ──

export function createWorkTask(task: {
  sessionId: string;
  taskNumber: number;
  slug: string;
  isc?: unknown;
  thread?: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO work_tasks (session_id, task_number, slug, isc, thread)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    task.sessionId,
    task.taskNumber,
    task.slug,
    task.isc ? JSON.stringify(task.isc) : null,
    task.thread ?? null
  );
}

export function getWorkTasks(sessionId: string): WorkTask[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM work_tasks WHERE session_id = ? ORDER BY task_number ASC"
    )
    .all(sessionId) as Array<{
    id: number;
    session_id: string;
    task_number: number;
    slug: string;
    isc: string | null;
    thread: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    taskNumber: row.task_number,
    slug: row.slug,
    isc: row.isc ? JSON.parse(row.isc) : null,
    thread: row.thread,
    createdAt: row.created_at,
  }));
}

// ── Learning operations ──

export function createLearning(learning: {
  category: string;
  source: string;
  title: string;
  content: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO learnings (category, source, title, content)
     VALUES (?, ?, ?, ?)`
  ).run(learning.category, learning.source, learning.title, learning.content);
}

export function queryLearnings(opts?: {
  category?: string;
  limit?: number;
}): Learning[] {
  const db = getDb();
  let sql = "SELECT * FROM learnings";
  const params: Array<string | number> = [];

  if (opts?.category) {
    sql += " WHERE category = ?";
    params.push(opts.category);
  }

  sql += " ORDER BY created_at DESC";

  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    category: string;
    source: string;
    title: string;
    content: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    source: row.source,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  }));
}
