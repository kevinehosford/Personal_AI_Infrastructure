import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  readState,
  writeState,
  listKeys,
  listWorkSessions,
  createWorkSession,
  appendLog,
  queryLogs,
} from "./lib/storage";

/**
 * Tests for LoadContext.hook.ts MEMORY operations.
 *
 * The hook reads session names, work sessions, progress state,
 * and relationship notes from SQLite.
 */
describe("LoadContext storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  // ── Session names ──

  test("reads session names from state store", () => {
    const names = { "sess-abc": "Fix auth bug", "sess-def": "Add logging" };
    writeState("session-names", "map", names);

    const result = readState<Record<string, string>>("session-names", "map");
    expect(result).not.toBeNull();
    expect(result!["sess-abc"]).toBe("Fix auth bug");
    expect(result!["sess-def"]).toBe("Add logging");
  });

  test("returns null when no session names exist", () => {
    const result = readState("session-names", "map");
    expect(result).toBeNull();
  });

  // ── Active work sessions ──

  test("lists active work sessions", () => {
    createWorkSession({ id: "ws-1", sessionId: "s1", title: "Active work" });
    createWorkSession({ id: "ws-2", sessionId: "s2", title: "Also active" });

    const active = listWorkSessions("ACTIVE");
    expect(active).toHaveLength(2);
    expect(active[0].status).toBe("ACTIVE");
  });

  test("filters out completed work sessions", () => {
    createWorkSession({ id: "ws-1", sessionId: "s1", title: "Active" });
    createWorkSession({ id: "ws-2", sessionId: "s2", title: "Done" });

    // Complete ws-2
    const { completeWorkSession } = require("./lib/storage");
    completeWorkSession("ws-2");

    const active = listWorkSessions("ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("ws-1");
  });

  test("work session metadata includes PRD info", () => {
    createWorkSession({
      id: "ws-prd",
      sessionId: "s1",
      title: "PRD session",
      meta: {
        prd: { id: "PRD-001", status: "IN_PROGRESS", progress: "3/5" },
      },
    });

    const sessions = listWorkSessions("ACTIVE");
    expect(sessions).toHaveLength(1);
    const meta = sessions[0].meta as any;
    expect(meta.prd.id).toBe("PRD-001");
    expect(meta.prd.progress).toBe("3/5");
  });

  // ── Project progress ──

  test("reads project progress from state store", () => {
    writeState("progress", "my-project", {
      project: "my-project",
      status: "active",
      updated: "2026-01-15T00:00:00Z",
      objectives: ["Ship v2", "Fix bugs"],
      next_steps: ["Deploy to staging"],
      handoff_notes: "Staging is ready",
    });

    const progress = readState<{
      project: string;
      status: string;
      objectives: string[];
    }>("progress", "my-project");

    expect(progress).not.toBeNull();
    expect(progress!.project).toBe("my-project");
    expect(progress!.status).toBe("active");
    expect(progress!.objectives).toHaveLength(2);
  });

  test("lists all progress keys", () => {
    writeState("progress", "proj-1", { project: "proj-1", status: "active" });
    writeState("progress", "proj-2", { project: "proj-2", status: "active" });
    writeState("progress", "proj-3", { project: "proj-3", status: "completed" });

    const keys = listKeys("progress");
    expect(keys).toHaveLength(3);
    expect(keys).toContain("proj-1");
    expect(keys).toContain("proj-2");
    expect(keys).toContain("proj-3");
  });

  // ── Relationship context ──

  test("reads recent relationship notes from logs", () => {
    appendLog("relationship", {
      date: "2026-01-15",
      time: "14:30",
      type: "B",
      entities: ["@Sam"],
      content: "Debugged voice system",
      formatted: "B @Sam: Debugged voice system",
    });
    appendLog("relationship", {
      date: "2026-01-14",
      time: "10:00",
      type: "O",
      entities: ["@Kevin"],
      content: "Appreciated direct approach",
      confidence: 0.85,
      formatted: "O(c=0.85) @Kevin: Appreciated direct approach",
    });

    const logs = queryLogs<{
      date: string;
      formatted: string;
    }>("relationship", { limit: 10 });

    expect(logs).toHaveLength(2);
    expect(logs[0].value.date).toBe("2026-01-15");
    expect(logs[1].value.date).toBe("2026-01-14");
  });

  test("handles empty relationship logs", () => {
    const logs = queryLogs("relationship");
    expect(logs).toEqual([]);
  });
});
