import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  readState,
  writeState,
  deleteState,
  createWorkSession,
  getWorkSession,
  completeWorkSession,
} from "./lib/storage";

/**
 * Tests for SessionSummary.hook.ts MEMORY operations.
 *
 * The hook reads current-work state, completes the work session,
 * and deletes the state entry. We test these operations directly
 * against the storage layer since the hook's main() reads from stdin.
 */
describe("SessionSummary storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  test("reads session-scoped current-work state", () => {
    const work = {
      session_id: "sess-abc",
      session_dir: "ws-1",
      current_task: "task-1",
      task_title: "Build feature",
      task_count: 3,
      created_at: "2026-01-01T00:00:00",
    };
    writeState("current-work", "sess-abc", work);

    const result = readState<typeof work>("current-work", "sess-abc");
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe("sess-abc");
    expect(result!.session_dir).toBe("ws-1");
  });

  test("falls back to legacy current-work state", () => {
    const work = {
      session_id: "sess-legacy",
      session_dir: "ws-legacy",
      current_task: "task-1",
      task_title: "Legacy task",
      task_count: 1,
      created_at: "2026-01-01T00:00:00",
    };
    writeState("current-work", "legacy", work);

    // Session-scoped lookup returns null
    expect(readState("current-work", "sess-other")).toBeNull();

    // Legacy fallback works
    const result = readState<typeof work>("current-work", "legacy");
    expect(result).not.toBeNull();
    expect(result!.session_dir).toBe("ws-legacy");
  });

  test("completeWorkSession marks session as COMPLETED", () => {
    createWorkSession({
      id: "ws-1",
      sessionId: "sess-abc",
      title: "Build feature",
    });

    completeWorkSession("ws-1", { status: "COMPLETED", completed_at: "2026-01-01T01:00:00" });

    const session = getWorkSession("ws-1");
    expect(session!.status).toBe("COMPLETED");
    expect(session!.completedAt).toBeTruthy();
  });

  test("deleteState removes current-work entries", () => {
    writeState("current-work", "sess-abc", { session_id: "sess-abc" });
    writeState("current-work", "legacy", { session_id: "legacy" });

    deleteState("current-work", "sess-abc");
    deleteState("current-work", "legacy");

    expect(readState("current-work", "sess-abc")).toBeNull();
    expect(readState("current-work", "legacy")).toBeNull();
  });

  test("does not affect other sessions when deleting", () => {
    writeState("current-work", "sess-1", { session_id: "sess-1" });
    writeState("current-work", "sess-2", { session_id: "sess-2" });

    deleteState("current-work", "sess-1");

    expect(readState("current-work", "sess-1")).toBeNull();
    expect(readState("current-work", "sess-2")).not.toBeNull();
  });
});
