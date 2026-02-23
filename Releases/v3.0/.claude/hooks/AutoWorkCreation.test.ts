import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  readState,
  writeState,
  createWorkSession,
  createWorkTask,
  getWorkSession,
  getWorkTasks,
  listWorkSessions,
  type WorkSession,
  type WorkTask,
} from "./lib/storage";

/**
 * Tests for AutoWorkCreation hook's storage migration.
 *
 * Since AutoWorkCreation.hook.ts is an executable hook (reads stdin, creates dirs, exits),
 * we test the storage operations it depends on in isolation:
 * - current-work state: read, write, update via storage.ts state operations
 * - work_sessions: creation and querying via storage.ts
 * - work_tasks: creation and querying via storage.ts
 */

describe("AutoWorkCreation storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  // ── current-work state management ──

  describe("current-work state", () => {
    interface CurrentWork {
      session_id: string;
      session_dir: string;
      current_task: string;
      task_title: string;
      task_count: number;
      created_at: string;
      prd_path?: string;
    }

    test("readState returns null when no current-work exists", () => {
      const result = readState<CurrentWork>("current-work", "sess-123");
      expect(result).toBeNull();
    });

    test("writeState + readState round-trips current-work", () => {
      const work: CurrentWork = {
        session_id: "sess-123",
        session_dir: "20260222-120000_my-task",
        current_task: "001_my-task",
        task_title: "My Task",
        task_count: 1,
        created_at: "2026-02-22T12:00:00-08:00",
        prd_path: "/path/to/prd.md",
      };
      writeState("current-work", "sess-123", work);

      const result = readState<CurrentWork>("current-work", "sess-123");
      expect(result).toEqual(work);
    });

    test("session-scoped keys isolate parallel sessions", () => {
      const work1: CurrentWork = {
        session_id: "sess-1",
        session_dir: "dir-1",
        current_task: "001_task-a",
        task_title: "Task A",
        task_count: 1,
        created_at: "2026-02-22T12:00:00",
      };
      const work2: CurrentWork = {
        session_id: "sess-2",
        session_dir: "dir-2",
        current_task: "001_task-b",
        task_title: "Task B",
        task_count: 1,
        created_at: "2026-02-22T12:01:00",
      };

      writeState("current-work", "sess-1", work1);
      writeState("current-work", "sess-2", work2);

      const r1 = readState<CurrentWork>("current-work", "sess-1");
      const r2 = readState<CurrentWork>("current-work", "sess-2");
      expect(r1!.task_title).toBe("Task A");
      expect(r2!.task_title).toBe("Task B");
    });

    test("updating current-work preserves session_dir", () => {
      const initial: CurrentWork = {
        session_id: "sess-1",
        session_dir: "20260222-120000_my-task",
        current_task: "001_my-task",
        task_title: "My Task",
        task_count: 1,
        created_at: "2026-02-22T12:00:00",
      };
      writeState("current-work", "sess-1", initial);

      // Add a second task
      const updated = { ...initial, current_task: "002_new-feature", task_title: "New Feature", task_count: 2 };
      writeState("current-work", "sess-1", updated);

      const result = readState<CurrentWork>("current-work", "sess-1");
      expect(result!.session_dir).toBe("20260222-120000_my-task");
      expect(result!.current_task).toBe("002_new-feature");
      expect(result!.task_count).toBe(2);
    });

    test("legacy fallback key works", () => {
      const work: CurrentWork = {
        session_id: "legacy-sess",
        session_dir: "dir-legacy",
        current_task: "001_task",
        task_title: "Legacy",
        task_count: 1,
        created_at: "2026-01-01T00:00:00",
      };
      writeState("current-work", "legacy", work);

      const result = readState<CurrentWork>("current-work", "legacy");
      expect(result).toEqual(work);
    });
  });

  // ── Work session creation ──

  describe("work session creation", () => {
    test("createWorkSession stores session with metadata", () => {
      createWorkSession({
        id: "20260222-120000_dashboard-redesign",
        sessionId: "sess-abc",
        title: "Dashboard Redesign",
        meta: { created_at: "2026-02-22T12:00:00-08:00", status: "ACTIVE" },
      });

      const session = getWorkSession("20260222-120000_dashboard-redesign");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("20260222-120000_dashboard-redesign");
      expect(session!.sessionId).toBe("sess-abc");
      expect(session!.title).toBe("Dashboard Redesign");
      expect(session!.status).toBe("ACTIVE");
      expect(session!.meta).toEqual({
        created_at: "2026-02-22T12:00:00-08:00",
        status: "ACTIVE",
      });
    });

    test("listWorkSessions returns active sessions", () => {
      createWorkSession({
        id: "ws-1",
        sessionId: "s1",
        title: "First Session",
      });
      createWorkSession({
        id: "ws-2",
        sessionId: "s2",
        title: "Second Session",
      });

      const sessions = listWorkSessions("ACTIVE");
      expect(sessions).toHaveLength(2);
    });

    test("getWorkSession returns null for missing session", () => {
      expect(getWorkSession("nonexistent")).toBeNull();
    });
  });

  // ── Work task creation ──

  describe("work task creation", () => {
    test("createWorkTask stores task with ISC and thread", () => {
      createWorkSession({
        id: "ws-1",
        sessionId: "sess-1",
        title: "Test Session",
      });

      const isc = {
        taskId: "001_implement-feature",
        status: "PENDING",
        effortLevel: "STANDARD",
        criteria: [],
        antiCriteria: [],
        satisfaction: null,
        createdAt: "2026-02-22T12:00:00",
        updatedAt: "2026-02-22T12:00:00",
      };

      const thread = `---
taskId: "001_implement-feature"
title: "Implement Feature"
---
# Algorithm Thread`;

      createWorkTask({
        sessionId: "ws-1",
        taskNumber: 1,
        slug: "implement-feature",
        isc,
        thread,
      });

      const tasks = getWorkTasks("ws-1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].taskNumber).toBe(1);
      expect(tasks[0].slug).toBe("implement-feature");
      expect(tasks[0].isc).toEqual(isc);
      expect(tasks[0].thread).toBe(thread);
    });

    test("multiple tasks in a session are ordered by taskNumber", () => {
      createWorkSession({
        id: "ws-1",
        sessionId: "sess-1",
        title: "Multi Task Session",
      });

      createWorkTask({
        sessionId: "ws-1",
        taskNumber: 1,
        slug: "first-task",
      });
      createWorkTask({
        sessionId: "ws-1",
        taskNumber: 2,
        slug: "second-task",
      });
      createWorkTask({
        sessionId: "ws-1",
        taskNumber: 3,
        slug: "third-task",
      });

      const tasks = getWorkTasks("ws-1");
      expect(tasks).toHaveLength(3);
      expect(tasks[0].taskNumber).toBe(1);
      expect(tasks[0].slug).toBe("first-task");
      expect(tasks[1].taskNumber).toBe(2);
      expect(tasks[2].taskNumber).toBe(3);
    });

    test("getWorkTasks returns empty for session with no tasks", () => {
      createWorkSession({
        id: "ws-empty",
        sessionId: "sess-empty",
        title: "Empty Session",
      });

      const tasks = getWorkTasks("ws-empty");
      expect(tasks).toEqual([]);
    });

    test("getWorkTasks returns empty for nonexistent session", () => {
      expect(getWorkTasks("nonexistent")).toEqual([]);
    });
  });

  // ── End-to-end: simulate AutoWorkCreation workflow ──

  describe("end-to-end workflow simulation", () => {
    interface CurrentWork {
      session_id: string;
      session_dir: string;
      current_task: string;
      task_title: string;
      task_count: number;
      created_at: string;
      prd_path?: string;
    }

    test("new session: creates work session, task, and current-work state", () => {
      const sessionDirName = "20260222-120000_voice-fix";
      const sessionId = "sess-new";
      const title = "Voice Fix";

      // Step 1: Create work session (what createSessionDirectory does)
      createWorkSession({
        id: sessionDirName,
        sessionId,
        title,
        meta: { created_at: "2026-02-22T12:00:00", status: "ACTIVE" },
      });

      // Step 2: Create work task (what createTaskDirectory does)
      const taskSlug = "voice-fix";
      createWorkTask({
        sessionId: sessionDirName,
        taskNumber: 1,
        slug: taskSlug,
        isc: { status: "PENDING", criteria: [] },
        thread: "# Thread",
      });

      // Step 3: Write current-work state
      const currentWork: CurrentWork = {
        session_id: sessionId,
        session_dir: sessionDirName,
        current_task: "001_voice-fix",
        task_title: title,
        task_count: 1,
        created_at: "2026-02-22T12:00:00",
      };
      writeState("current-work", sessionId, currentWork);

      // Verify everything is stored
      const session = getWorkSession(sessionDirName);
      expect(session!.title).toBe("Voice Fix");
      expect(session!.status).toBe("ACTIVE");

      const tasks = getWorkTasks(sessionDirName);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].slug).toBe("voice-fix");

      const state = readState<CurrentWork>("current-work", sessionId);
      expect(state!.current_task).toBe("001_voice-fix");
    });

    test("existing session, new topic: adds task to existing session", () => {
      const sessionDirName = "20260222-120000_initial";
      const sessionId = "sess-multi";

      // Initial session
      createWorkSession({
        id: sessionDirName,
        sessionId,
        title: "Initial",
      });
      createWorkTask({
        sessionId: sessionDirName,
        taskNumber: 1,
        slug: "initial-task",
      });
      writeState("current-work", sessionId, {
        session_id: sessionId,
        session_dir: sessionDirName,
        current_task: "001_initial-task",
        task_title: "Initial",
        task_count: 1,
        created_at: "2026-02-22T12:00:00",
      });

      // New topic arrives
      createWorkTask({
        sessionId: sessionDirName,
        taskNumber: 2,
        slug: "new-feature",
        isc: { status: "PENDING" },
      });

      // Update current-work
      const cw = readState<CurrentWork>("current-work", sessionId)!;
      cw.current_task = "002_new-feature";
      cw.task_title = "New Feature";
      cw.task_count = 2;
      writeState("current-work", sessionId, cw);

      // Verify
      const tasks = getWorkTasks(sessionDirName);
      expect(tasks).toHaveLength(2);
      expect(tasks[1].slug).toBe("new-feature");

      const state = readState<CurrentWork>("current-work", sessionId);
      expect(state!.current_task).toBe("002_new-feature");
      expect(state!.task_count).toBe(2);
    });

    test("continuation: no new task created, current-work unchanged", () => {
      const sessionId = "sess-cont";
      const cw: CurrentWork = {
        session_id: sessionId,
        session_dir: "dir-cont",
        current_task: "001_task",
        task_title: "Task",
        task_count: 1,
        created_at: "2026-02-22T12:00:00",
      };
      writeState("current-work", sessionId, cw);

      // On continuation, no writes happen — just read
      const result = readState<CurrentWork>("current-work", sessionId);
      expect(result).toEqual(cw);
    });
  });
});
