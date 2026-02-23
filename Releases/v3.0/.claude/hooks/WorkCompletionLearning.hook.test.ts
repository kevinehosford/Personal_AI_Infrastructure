import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  readState,
  writeState,
  createWorkSession,
  getWorkSession,
  createWorkTask,
  getWorkTasks,
  createLearning,
  queryLearnings,
} from "./lib/storage";

/**
 * Tests for WorkCompletionLearning.hook.ts MEMORY operations.
 *
 * The hook reads current-work state, fetches work session metadata
 * and tasks from SQLite, then creates a learning entry.
 */
describe("WorkCompletionLearning storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  test("reads work session and creates learning from it", () => {
    // Setup: create work session with metadata
    createWorkSession({
      id: "ws-1",
      sessionId: "sess-abc",
      title: "Fix auth bug",
      meta: {
        source: "AUTO",
        lineage: {
          tools_used: ["Bash", "Edit"],
          files_changed: ["src/auth.ts", "src/auth.test.ts"],
          agents_spawned: [],
        },
      },
    });

    // Setup: create a task with ISC
    createWorkTask({
      sessionId: "ws-1",
      taskNumber: 1,
      slug: "fix-auth",
      isc: {
        criteria: ["Auth flow handles expired tokens", "Tests pass"],
        antiCriteria: ["No hardcoded secrets"],
      },
    });

    // Verify work session is readable
    const session = getWorkSession("ws-1");
    expect(session).not.toBeNull();
    expect(session!.title).toBe("Fix auth bug");
    expect((session!.meta as any).source).toBe("AUTO");

    // Verify tasks are readable
    const tasks = getWorkTasks("ws-1");
    expect(tasks).toHaveLength(1);
    expect((tasks[0].isc as any).criteria).toHaveLength(2);

    // Create learning (simulates what the hook does)
    createLearning({
      category: "ALGORITHM",
      source: "work-completion",
      title: "Work: Fix auth bug",
      content: "# Work Completion Learning\n\nAuth bug fixed.",
    });

    const learnings = queryLearnings();
    expect(learnings).toHaveLength(1);
    expect(learnings[0].category).toBe("ALGORITHM");
    expect(learnings[0].title).toBe("Work: Fix auth bug");
  });

  test("handles missing work session gracefully", () => {
    const session = getWorkSession("nonexistent");
    expect(session).toBeNull();
  });

  test("handles work session with no tasks", () => {
    createWorkSession({
      id: "ws-empty",
      sessionId: "sess-empty",
      title: "Empty session",
    });

    const tasks = getWorkTasks("ws-empty");
    expect(tasks).toEqual([]);
  });

  test("reads current-work state for session lookup", () => {
    writeState("current-work", "sess-abc", {
      session_id: "sess-abc",
      session_dir: "ws-1",
      current_task: "task-1",
      task_title: "Do stuff",
      task_count: 2,
      created_at: "2026-01-01T00:00:00",
    });

    const work = readState<{ session_dir: string; task_count: number }>(
      "current-work",
      "sess-abc"
    );
    expect(work).not.toBeNull();
    expect(work!.session_dir).toBe("ws-1");
    expect(work!.task_count).toBe(2);
  });
});
