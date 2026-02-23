import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  getDb,
  resetDb,
  readState,
  writeState,
  deleteState,
  listKeys,
  appendLog,
  queryLogs,
  createWorkSession,
  getWorkSession,
  listWorkSessions,
  completeWorkSession,
  createWorkTask,
  getWorkTasks,
  createLearning,
  queryLearnings,
  type WorkSession,
  type WorkTask,
  type Learning,
} from "./storage";

describe("storage", () => {
  beforeEach(() => {
    // Each test gets a fresh in-memory database
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  // ── initDb ──

  describe("initDb", () => {
    test("creates all tables without error", () => {
      // initDb already called in beforeEach — just verify db is usable
      const db = getDb();
      // Query sqlite_master for our tables
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain("state");
      expect(tables).toContain("logs");
      expect(tables).toContain("work_sessions");
      expect(tables).toContain("work_tasks");
      expect(tables).toContain("learnings");
    });

    test("is idempotent — calling twice does not error", () => {
      expect(() => initDb(":memory:")).not.toThrow();
      expect(() => initDb(":memory:")).not.toThrow();
    });
  });

  // ── State operations ──

  describe("state operations", () => {
    test("writeState + readState round-trips JSON correctly", () => {
      const data = { name: "test", nested: { value: 42 }, list: [1, 2, 3] };
      writeState("ns1", "key1", data);
      const result = readState("ns1", "key1");
      expect(result).toEqual(data);
    });

    test("readState returns null for missing keys", () => {
      const result = readState("ns1", "nonexistent");
      expect(result).toBeNull();
    });

    test("writeState overwrites existing values (upsert)", () => {
      writeState("ns1", "key1", { version: 1 });
      writeState("ns1", "key1", { version: 2 });
      const result = readState<{ version: number }>("ns1", "key1");
      expect(result).toEqual({ version: 2 });
    });

    test("deleteState removes entries", () => {
      writeState("ns1", "key1", "value");
      deleteState("ns1", "key1");
      const result = readState("ns1", "key1");
      expect(result).toBeNull();
    });

    test("deleteState on missing key does not error", () => {
      expect(() => deleteState("ns1", "nonexistent")).not.toThrow();
    });

    test("listKeys returns all keys in a namespace", () => {
      writeState("ns1", "alpha", 1);
      writeState("ns1", "beta", 2);
      writeState("ns1", "gamma", 3);
      writeState("ns2", "other", 4);

      const keys = listKeys("ns1");
      expect(keys).toHaveLength(3);
      expect(keys).toContain("alpha");
      expect(keys).toContain("beta");
      expect(keys).toContain("gamma");
    });

    test("listKeys returns empty array for unknown namespace", () => {
      const keys = listKeys("unknown");
      expect(keys).toEqual([]);
    });

    test("state values are isolated by namespace", () => {
      writeState("ns1", "key", "value-a");
      writeState("ns2", "key", "value-b");
      expect(readState("ns1", "key")).toBe("value-a");
      expect(readState("ns2", "key")).toBe("value-b");
    });
  });

  // ── Log operations ──

  describe("log operations", () => {
    test("appendLog inserts and auto-increments", () => {
      appendLog("logs-ns", { msg: "first" });
      appendLog("logs-ns", { msg: "second" });
      appendLog("logs-ns", { msg: "third" });

      const logs = queryLogs("logs-ns");
      expect(logs).toHaveLength(3);
      expect(logs[0].id).toBeLessThan(logs[1].id);
      expect(logs[1].id).toBeLessThan(logs[2].id);
      expect(logs[0].value).toEqual({ msg: "first" });
      expect(logs[2].value).toEqual({ msg: "third" });
    });

    test("queryLogs filters by namespace", () => {
      appendLog("ns-a", { a: true });
      appendLog("ns-b", { b: true });

      const logsA = queryLogs("ns-a");
      expect(logsA).toHaveLength(1);
      expect(logsA[0].value).toEqual({ a: true });

      const logsB = queryLogs("ns-b");
      expect(logsB).toHaveLength(1);
      expect(logsB[0].value).toEqual({ b: true });
    });

    test("queryLogs supports limit", () => {
      appendLog("ns", { i: 1 });
      appendLog("ns", { i: 2 });
      appendLog("ns", { i: 3 });

      const logs = queryLogs("ns", { limit: 2 });
      expect(logs).toHaveLength(2);
    });

    test("queryLogs supports since filter", () => {
      const db = getDb();
      // Insert logs with explicit timestamps for deterministic testing
      db.prepare(
        "INSERT INTO logs (namespace, timestamp, value) VALUES (?, ?, ?)"
      ).run("ns", "2026-01-01 00:00:00", JSON.stringify({ i: 1 }));
      db.prepare(
        "INSERT INTO logs (namespace, timestamp, value) VALUES (?, ?, ?)"
      ).run("ns", "2026-06-01 00:00:00", JSON.stringify({ i: 2 }));
      db.prepare(
        "INSERT INTO logs (namespace, timestamp, value) VALUES (?, ?, ?)"
      ).run("ns", "2026-12-01 00:00:00", JSON.stringify({ i: 3 }));

      const logs = queryLogs("ns", { since: "2026-06-01 00:00:00" });
      expect(logs).toHaveLength(2);
      expect(logs[0].value).toEqual({ i: 2 });
      expect(logs[1].value).toEqual({ i: 3 });
    });

    test("queryLogs returns empty array for unknown namespace", () => {
      const logs = queryLogs("unknown");
      expect(logs).toEqual([]);
    });

    test("log timestamps are populated automatically", () => {
      appendLog("ns", "test");
      const logs = queryLogs("ns");
      expect(logs[0].timestamp).toBeTruthy();
      expect(typeof logs[0].timestamp).toBe("string");
    });
  });

  // ── Work session operations ──

  describe("work session operations", () => {
    test("createWorkSession + getWorkSession round-trips", () => {
      createWorkSession({
        id: "ws-1",
        sessionId: "sess-abc",
        title: "My Session",
        meta: { tags: ["test"] },
      });

      const session = getWorkSession("ws-1");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("ws-1");
      expect(session!.sessionId).toBe("sess-abc");
      expect(session!.title).toBe("My Session");
      expect(session!.status).toBe("ACTIVE");
      expect(session!.meta).toEqual({ tags: ["test"] });
      expect(session!.createdAt).toBeTruthy();
    });

    test("getWorkSession returns null for missing session", () => {
      expect(getWorkSession("nonexistent")).toBeNull();
    });

    test("listWorkSessions returns all sessions", () => {
      createWorkSession({ id: "ws-1", sessionId: "s1", title: "First" });
      createWorkSession({ id: "ws-2", sessionId: "s2", title: "Second" });

      const all = listWorkSessions();
      expect(all).toHaveLength(2);
    });

    test("listWorkSessions filters by status", () => {
      createWorkSession({ id: "ws-1", sessionId: "s1", title: "Active" });
      createWorkSession({ id: "ws-2", sessionId: "s2", title: "Done" });
      completeWorkSession("ws-2");

      const active = listWorkSessions("ACTIVE");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("ws-1");

      const completed = listWorkSessions("COMPLETED");
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe("ws-2");
    });

    test("completeWorkSession sets status and completedAt", () => {
      createWorkSession({ id: "ws-1", sessionId: "s1", title: "Test" });
      completeWorkSession("ws-1", { summary: "done" });

      const session = getWorkSession("ws-1");
      expect(session!.status).toBe("COMPLETED");
      expect(session!.completedAt).toBeTruthy();
      expect(session!.meta).toEqual({ summary: "done" });
    });
  });

  // ── Work task operations ──

  describe("work task operations", () => {
    test("createWorkTask + getWorkTasks round-trips", () => {
      createWorkSession({ id: "ws-1", sessionId: "s1", title: "Session" });
      createWorkTask({
        sessionId: "ws-1",
        taskNumber: 1,
        slug: "implement-feature",
        isc: { criteria: ["test"] },
        thread: "thread-123",
      });
      createWorkTask({
        sessionId: "ws-1",
        taskNumber: 2,
        slug: "write-tests",
      });

      const tasks = getWorkTasks("ws-1");
      expect(tasks).toHaveLength(2);
      expect(tasks[0].taskNumber).toBe(1);
      expect(tasks[0].slug).toBe("implement-feature");
      expect(tasks[0].isc).toEqual({ criteria: ["test"] });
      expect(tasks[0].thread).toBe("thread-123");
      expect(tasks[1].taskNumber).toBe(2);
      expect(tasks[1].slug).toBe("write-tests");
    });

    test("getWorkTasks returns empty array for unknown session", () => {
      expect(getWorkTasks("nonexistent")).toEqual([]);
    });
  });

  // ── Learning operations ──

  describe("learning operations", () => {
    test("createLearning + queryLearnings round-trips", () => {
      createLearning({
        category: "patterns",
        source: "code-review",
        title: "Use TDD",
        content: "Always write tests first",
      });

      const learnings = queryLearnings();
      expect(learnings).toHaveLength(1);
      expect(learnings[0].category).toBe("patterns");
      expect(learnings[0].source).toBe("code-review");
      expect(learnings[0].title).toBe("Use TDD");
      expect(learnings[0].content).toBe("Always write tests first");
      expect(learnings[0].createdAt).toBeTruthy();
    });

    test("queryLearnings filters by category", () => {
      createLearning({
        category: "patterns",
        source: "s1",
        title: "t1",
        content: "c1",
      });
      createLearning({
        category: "bugs",
        source: "s2",
        title: "t2",
        content: "c2",
      });
      createLearning({
        category: "patterns",
        source: "s3",
        title: "t3",
        content: "c3",
      });

      const patterns = queryLearnings({ category: "patterns" });
      expect(patterns).toHaveLength(2);
      expect(patterns.every((l) => l.category === "patterns")).toBe(true);
    });

    test("queryLearnings supports limit", () => {
      createLearning({ category: "a", source: "s", title: "t1", content: "c" });
      createLearning({ category: "a", source: "s", title: "t2", content: "c" });
      createLearning({ category: "a", source: "s", title: "t3", content: "c" });

      const limited = queryLearnings({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    test("queryLearnings returns empty for unknown category", () => {
      expect(queryLearnings({ category: "unknown" })).toEqual([]);
    });
  });

  // ── Prepared statement caching ──

  describe("prepared statement caching", () => {
    test("calling same function twice does not error (statements are cached)", () => {
      // Write twice — prepared statements should be reused
      writeState("ns", "k1", "v1");
      writeState("ns", "k2", "v2");
      readState("ns", "k1");
      readState("ns", "k2");

      // Logs
      appendLog("ns", "a");
      appendLog("ns", "b");
      queryLogs("ns");
      queryLogs("ns");

      // All operations should succeed without "statement already finalized" errors
      expect(true).toBe(true);
    });
  });
});
