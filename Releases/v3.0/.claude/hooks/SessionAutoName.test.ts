import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  readState,
  writeState,
} from "./lib/storage";
import {
  readState as readAlgoState,
  writeState as writeAlgoState,
  type AlgorithmState,
} from "./lib/algorithm-state";

/**
 * Tests for SessionAutoName hook's storage migration.
 *
 * Since SessionAutoName.hook.ts is an executable hook (reads stdin, calls inference, exits),
 * we test the storage operations it depends on in isolation:
 * - session-names map: read, write, update via storage.ts
 * - algorithm state reads for rework detection via algorithm-state.ts
 * - algorithm state writes for previousNames archival
 */

describe("SessionAutoName storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  // ── Session names map ──

  describe("session-names map", () => {
    test("readState returns null when no session-names exist", () => {
      const names = readState("session-names", "map");
      expect(names).toBeNull();
    });

    test("writeState + readState round-trips session names", () => {
      const names = { "sess-1": "Voice Fix", "sess-2": "Dashboard Redesign" };
      writeState("session-names", "map", names);

      const result = readState<Record<string, string>>("session-names", "map");
      expect(result).toEqual(names);
    });

    test("updating session names preserves existing entries", () => {
      writeState("session-names", "map", { "sess-1": "Voice Fix" });

      const names = readState<Record<string, string>>("session-names", "map")!;
      names["sess-2"] = "New Session";
      writeState("session-names", "map", names);

      const result = readState<Record<string, string>>("session-names", "map");
      expect(result).toEqual({
        "sess-1": "Voice Fix",
        "sess-2": "New Session",
      });
    });

    test("overwriting a session name works (rename on rework)", () => {
      writeState("session-names", "map", { "sess-1": "Original Name" });

      const names = readState<Record<string, string>>("session-names", "map")!;
      names["sess-1"] = "Reworked Name";
      writeState("session-names", "map", names);

      const result = readState<Record<string, string>>("session-names", "map");
      expect(result!["sess-1"]).toBe("Reworked Name");
    });

    test("deleting a session name from the map", () => {
      writeState("session-names", "map", {
        "sess-1": "Name A",
        "sess-2": "Name B",
      });

      const names = readState<Record<string, string>>("session-names", "map")!;
      delete names["sess-1"];
      writeState("session-names", "map", names);

      const result = readState<Record<string, string>>("session-names", "map");
      expect(result).toEqual({ "sess-2": "Name B" });
    });
  });

  // ── Algorithm state reads (rework detection) ──

  describe("rework detection via algorithm state", () => {
    function makeState(overrides: Partial<AlgorithmState> = {}): AlgorithmState {
      return {
        active: true,
        sessionId: "test-session",
        taskDescription: "Test task",
        currentPhase: "OBSERVE",
        phaseStartedAt: Date.now(),
        algorithmStartedAt: Date.now(),
        sla: "Standard",
        criteria: [],
        agents: [],
        capabilities: ["Task Tool"],
        phaseHistory: [
          {
            phase: "OBSERVE",
            startedAt: Date.now(),
            criteriaCount: 0,
            agentCount: 0,
          },
        ],
        ...overrides,
      };
    }

    test("readAlgoState returns null for missing session", () => {
      expect(readAlgoState("nonexistent")).toBeNull();
    });

    test("detects completed session (rework signal)", () => {
      const state = makeState({
        sessionId: "rework-test",
        active: false,
        currentPhase: "COMPLETE",
        completedAt: Date.now(),
        criteria: [
          {
            id: "C1",
            description: "Test",
            type: "criterion",
            status: "completed",
            createdInPhase: "OBSERVE",
          },
        ],
        summary: "Done",
      });
      writeAlgoState(state);

      const result = readAlgoState("rework-test");
      expect(result).not.toBeNull();
      expect(result!.active).toBe(false);
      expect(result!.currentPhase).toBe("COMPLETE");
      expect(result!.criteria.length).toBeGreaterThan(0);
      expect(result!.summary).toBe("Done");
    });

    test("detects active session (no rework)", () => {
      const state = makeState({
        sessionId: "active-test",
        active: true,
        currentPhase: "BUILD",
      });
      writeAlgoState(state);

      const result = readAlgoState("active-test");
      expect(result!.active).toBe(true);
      expect(result!.currentPhase).toBe("BUILD");
    });
  });

  // ── Algorithm state writes (previousNames archival) ──

  describe("previousNames archival on rework", () => {
    function makeState(overrides: Partial<AlgorithmState> = {}): AlgorithmState {
      return {
        active: false,
        sessionId: "rework-session",
        taskDescription: "Old Task",
        currentPhase: "COMPLETE",
        phaseStartedAt: Date.now(),
        algorithmStartedAt: Date.now(),
        sla: "Standard",
        criteria: [
          {
            id: "C1",
            description: "Test",
            type: "criterion",
            status: "completed",
            createdInPhase: "OBSERVE",
          },
        ],
        agents: [],
        capabilities: ["Task Tool"],
        phaseHistory: [],
        completedAt: Date.now(),
        summary: "First run done",
        ...overrides,
      };
    }

    test("can add previousNames to algorithm state", () => {
      const state = makeState();
      writeAlgoState(state);

      // Simulate what storeName() does on rework
      const algoState = readAlgoState("rework-session")!;
      if (!algoState.previousNames) algoState.previousNames = [];
      algoState.previousNames.push({
        name: "Old Task",
        changedAt: new Date().toISOString(),
      });
      writeAlgoState(algoState);

      const result = readAlgoState("rework-session");
      expect(result!.previousNames).toHaveLength(1);
      expect(result!.previousNames![0].name).toBe("Old Task");
      expect(result!.previousNames![0].changedAt).toBeTruthy();
    });

    test("can accumulate multiple previousNames across reworks", () => {
      const state = makeState();
      writeAlgoState(state);

      // First rework
      const s1 = readAlgoState("rework-session")!;
      s1.previousNames = [{ name: "Name V1", changedAt: "2026-01-01T00:00:00Z" }];
      writeAlgoState(s1);

      // Second rework
      const s2 = readAlgoState("rework-session")!;
      s2.previousNames!.push({ name: "Name V2", changedAt: "2026-02-01T00:00:00Z" });
      writeAlgoState(s2);

      const result = readAlgoState("rework-session");
      expect(result!.previousNames).toHaveLength(2);
      expect(result!.previousNames![0].name).toBe("Name V1");
      expect(result!.previousNames![1].name).toBe("Name V2");
    });
  });

  // ── Cross-cutting: session-names used by algorithm-state.ts getSessionName ──

  describe("session-names read by algorithm-state writeState", () => {
    test("writeAlgoState picks up session name from storage", () => {
      // Store a session name in storage
      writeState("session-names", "map", { "name-test": "Dashboard Fix" });

      // Create algorithm state — writeState should pick up the name
      const state: AlgorithmState = {
        active: true,
        sessionId: "name-test",
        taskDescription: "Starting...",
        currentPhase: "OBSERVE",
        phaseStartedAt: Date.now(),
        algorithmStartedAt: Date.now(),
        sla: "Standard",
        criteria: [],
        agents: [],
        capabilities: ["Task Tool"],
        phaseHistory: [],
      };
      writeAlgoState(state);

      const result = readAlgoState("name-test");
      // writeState reads session-names and updates taskDescription if non-placeholder
      expect(result!.taskDescription).toBe("Dashboard Fix");
    });

    test("writeAlgoState uses default when no session name exists", () => {
      const state: AlgorithmState = {
        active: true,
        sessionId: "no-name",
        taskDescription: "Starting...",
        currentPhase: "OBSERVE",
        phaseStartedAt: Date.now(),
        algorithmStartedAt: Date.now(),
        sla: "Standard",
        criteria: [],
        agents: [],
        capabilities: ["Task Tool"],
        phaseHistory: [],
      };
      writeAlgoState(state);

      const result = readAlgoState("no-name");
      // No session name in storage, getSessionName returns "Algorithm run" which is a placeholder
      // so taskDescription stays as-is
      expect(result!.taskDescription).toBe("Starting...");
    });
  });
});
