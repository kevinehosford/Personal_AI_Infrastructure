import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { initDb, resetDb, getDb } from "./storage";
import {
  readState,
  writeState,
  phaseTransition,
  criteriaAdd,
  criteriaUpdate,
  agentAdd,
  effortLevelUpdate,
  algorithmEnd,
  sweepStaleActive,
  algorithmAbandon,
  type AlgorithmState,
  type AlgorithmCriterion,
  type AlgorithmPhase,
} from "./algorithm-state";

describe("algorithm-state", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  // ── Helper: create a minimal valid state ──

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
        { phase: "OBSERVE", startedAt: Date.now(), criteriaCount: 0, agentCount: 0 },
      ],
      ...overrides,
    };
  }

  function makeCriterion(overrides: Partial<AlgorithmCriterion> = {}): AlgorithmCriterion {
    return {
      id: "C1",
      description: "Test criterion",
      type: "criterion",
      status: "pending",
      createdInPhase: "OBSERVE",
      ...overrides,
    };
  }

  // ── readState / writeState ──

  describe("readState", () => {
    test("returns null for missing session", () => {
      expect(readState("nonexistent")).toBeNull();
    });

    test("returns correct state for existing session", () => {
      const state = makeState({ sessionId: "abc-123" });
      writeState(state);
      const result = readState("abc-123");
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("abc-123");
      expect(result!.active).toBe(true);
      expect(result!.currentPhase).toBe("OBSERVE");
    });
  });

  describe("writeState", () => {
    test("persists and round-trips correctly", () => {
      const state = makeState({
        sessionId: "write-test",
        sla: "Extended",
        criteria: [makeCriterion({ id: "C1" }), makeCriterion({ id: "C2" })],
      });
      writeState(state);

      const result = readState("write-test");
      expect(result).not.toBeNull();
      expect(result!.sla).toBe("Extended");
      expect(result!.effortLevel).toBe("Extended"); // writeState syncs effortLevel with sla
      expect(result!.criteria).toHaveLength(2);
      expect(result!.criteria[0].id).toBe("C1");
      expect(result!.criteria[1].id).toBe("C2");
    });

    test("upserts on second write", () => {
      const state = makeState({ sessionId: "upsert-test", sla: "Standard" });
      writeState(state);

      state.sla = "Advanced";
      writeState(state);

      const result = readState("upsert-test");
      expect(result!.sla).toBe("Advanced");
    });

    test("syncs effortLevel with sla", () => {
      const state = makeState({ sessionId: "sync-test", sla: "Deep" });
      writeState(state);

      const result = readState("sync-test");
      expect(result!.effortLevel).toBe("Deep");
    });
  });

  // ── phaseTransition ──

  describe("phaseTransition", () => {
    test("creates new state when no prior state exists", () => {
      phaseTransition("new-session", "THINK");
      const state = readState("new-session");
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.currentPhase).toBe("THINK");
      expect(state!.phaseHistory).toHaveLength(1);
      expect(state!.phaseHistory[0].phase).toBe("THINK");
    });

    test("transitions phase and records in phaseHistory", () => {
      const initial = makeState({ sessionId: "phase-test", currentPhase: "OBSERVE" });
      writeState(initial);

      phaseTransition("phase-test", "THINK");

      const state = readState("phase-test");
      expect(state!.currentPhase).toBe("THINK");
      // phaseHistory: initial OBSERVE + new THINK
      expect(state!.phaseHistory).toHaveLength(2);
      expect(state!.phaseHistory[0].phase).toBe("OBSERVE");
      expect(state!.phaseHistory[0].completedAt).toBeDefined();
      expect(state!.phaseHistory[1].phase).toBe("THINK");
    });

    test("sets completedAt when entering LEARN phase", () => {
      const initial = makeState({ sessionId: "learn-test", currentPhase: "VERIFY" });
      writeState(initial);

      phaseTransition("learn-test", "LEARN");

      const state = readState("learn-test");
      expect(state!.currentPhase).toBe("LEARN");
      expect(state!.completedAt).toBeDefined();
    });

    test("handles rework: OBSERVE after COMPLETE archives cycle", () => {
      const initial = makeState({
        sessionId: "rework-test",
        currentPhase: "COMPLETE",
        criteria: [makeCriterion({ id: "C1", status: "completed" })],
        summary: "First run done",
      });
      writeState(initial);

      phaseTransition("rework-test", "OBSERVE");

      const state = readState("rework-test");
      expect(state!.active).toBe(true);
      expect(state!.currentPhase).toBe("OBSERVE");
      expect(state!.isRework).toBe(true);
      expect(state!.reworkCount).toBe(1);
      expect(state!.reworkHistory).toHaveLength(1);
      expect(state!.reworkHistory![0].criteria).toHaveLength(1);
      expect(state!.criteria).toHaveLength(0); // Reset for new cycle
    });

    test("handles rework: OBSERVE after LEARN archives cycle", () => {
      const initial = makeState({
        sessionId: "rework-learn",
        currentPhase: "LEARN",
        criteria: [makeCriterion({ id: "C1" })],
      });
      writeState(initial);

      phaseTransition("rework-learn", "OBSERVE");

      const state = readState("rework-learn");
      expect(state!.isRework).toBe(true);
      expect(state!.reworkCount).toBe(1);
    });

    test("normal transition from OBSERVE to THINK does NOT trigger rework", () => {
      const initial = makeState({ sessionId: "normal-test", currentPhase: "OBSERVE" });
      writeState(initial);

      phaseTransition("normal-test", "THINK");

      const state = readState("normal-test");
      expect(state!.isRework).toBeUndefined();
      expect(state!.reworkCount).toBeUndefined();
    });
  });

  // ── criteriaAdd ──

  describe("criteriaAdd", () => {
    test("adds criterion to existing state", () => {
      const initial = makeState({ sessionId: "criteria-test" });
      writeState(initial);

      criteriaAdd("criteria-test", makeCriterion({ id: "C1", description: "First" }));

      const state = readState("criteria-test");
      expect(state!.criteria).toHaveLength(1);
      expect(state!.criteria[0].id).toBe("C1");
      expect(state!.criteria[0].description).toBe("First");
    });

    test("creates state if none exists", () => {
      criteriaAdd("brand-new", makeCriterion({ id: "C1" }));

      const state = readState("brand-new");
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
      expect(state!.criteria).toHaveLength(1);
    });

    test("does not add duplicate criteria", () => {
      const initial = makeState({ sessionId: "dup-test" });
      writeState(initial);

      const c = makeCriterion({ id: "C1" });
      criteriaAdd("dup-test", c);
      criteriaAdd("dup-test", c);

      const state = readState("dup-test");
      expect(state!.criteria).toHaveLength(1);
    });

    test("reactivates completed session when criteria arrive", () => {
      const completed = makeState({
        sessionId: "reactivate-test",
        active: false,
        currentPhase: "COMPLETE",
        completedAt: Date.now(),
        criteria: [makeCriterion({ id: "C1", status: "completed" })],
        summary: "Done",
      });
      writeState(completed);

      criteriaAdd("reactivate-test", makeCriterion({ id: "C2" }));

      const state = readState("reactivate-test");
      expect(state!.active).toBe(true);
      expect(state!.criteria).toHaveLength(1); // Reset: only the new criterion
      expect(state!.criteria[0].id).toBe("C2");
      expect(state!.reworkCount).toBe(1);
      expect(state!.reworkHistory).toHaveLength(1);
    });
  });

  // ── criteriaUpdate ──

  describe("criteriaUpdate", () => {
    test("updates criterion status by taskId", () => {
      const initial = makeState({
        sessionId: "update-test",
        criteria: [makeCriterion({ id: "C1", taskId: "42", status: "pending" })],
      });
      writeState(initial);

      criteriaUpdate("update-test", "42", "completed");

      const state = readState("update-test");
      expect(state!.criteria[0].status).toBe("completed");
    });

    test("no-op when session does not exist", () => {
      // Should not throw
      criteriaUpdate("missing", "42", "completed");
    });

    test("no-op when taskId not found", () => {
      const initial = makeState({
        sessionId: "no-match",
        criteria: [makeCriterion({ id: "C1", taskId: "42" })],
      });
      writeState(initial);

      criteriaUpdate("no-match", "999", "completed");

      const state = readState("no-match");
      expect(state!.criteria[0].status).toBe("pending");
    });
  });

  // ── effortLevelUpdate ──

  describe("effortLevelUpdate", () => {
    test("updates sla on existing session", () => {
      const initial = makeState({ sessionId: "effort-test", sla: "Standard" });
      writeState(initial);

      effortLevelUpdate("effort-test", "Advanced");

      const state = readState("effort-test");
      expect(state!.sla).toBe("Advanced");
    });

    test("no-op when session does not exist", () => {
      effortLevelUpdate("missing", "Deep");
      // Should not throw
    });
  });

  // ── agentAdd ──

  describe("agentAdd", () => {
    test("records agent spawn in state", () => {
      const initial = makeState({ sessionId: "agent-test" });
      writeState(initial);

      agentAdd("agent-test", { name: "researcher", agentType: "Explore", task: "Find info" });

      const state = readState("agent-test");
      expect(state!.agents).toHaveLength(1);
      expect(state!.agents[0].name).toBe("researcher");
      expect(state!.agents[0].agentType).toBe("Explore");
      expect(state!.agents[0].status).toBe("active");
      expect(state!.agents[0].phase).toBe("OBSERVE");
    });

    test("does not add duplicate agents", () => {
      const initial = makeState({ sessionId: "dup-agent" });
      writeState(initial);

      agentAdd("dup-agent", { name: "researcher", agentType: "Explore" });
      agentAdd("dup-agent", { name: "researcher", agentType: "Explore" });

      const state = readState("dup-agent");
      expect(state!.agents).toHaveLength(1);
    });

    test("no-op when session does not exist", () => {
      agentAdd("missing", { name: "researcher", agentType: "Explore" });
      // Should not throw
    });
  });

  // ── algorithmEnd ──

  describe("algorithmEnd", () => {
    test("marks terminal session when phase is LEARN", () => {
      const initial = makeState({
        sessionId: "end-test",
        currentPhase: "LEARN",
      });
      writeState(initial);

      algorithmEnd("end-test", {
        taskDescription: "Final task",
        summary: "All done",
        sla: "Extended",
        isAlgorithmResponse: true,
      });

      const state = readState("end-test");
      expect(state!.active).toBe(false);
      expect(state!.currentPhase).toBe("COMPLETE");
      expect(state!.completedAt).toBeDefined();
      expect(state!.summary).toBe("All done");
      expect(state!.sla).toBe("Extended");
      expect(state!.taskDescription).toBe("Final task");
    });

    test("marks terminal session when phase is COMPLETE", () => {
      const initial = makeState({
        sessionId: "complete-test",
        currentPhase: "COMPLETE",
      });
      writeState(initial);

      algorithmEnd("complete-test", { isAlgorithmResponse: true });

      const state = readState("complete-test");
      expect(state!.active).toBe(false);
    });

    test("enriches without deactivating when phase is BUILD", () => {
      const initial = makeState({
        sessionId: "build-test",
        currentPhase: "BUILD",
      });
      writeState(initial);

      algorithmEnd("build-test", {
        summary: "In progress",
        isAlgorithmResponse: true,
      });

      const state = readState("build-test");
      expect(state!.active).toBe(true); // Not deactivated during BUILD
      expect(state!.summary).toBe("In progress");
    });

    test("deactivates optimistic activation for non-algorithm response", () => {
      const initial = makeState({
        sessionId: "deactivate-test",
        active: true,
        criteria: [],
        phaseHistory: [
          { phase: "OBSERVE", startedAt: Date.now(), criteriaCount: 0, agentCount: 0 },
        ],
      });
      writeState(initial);

      algorithmEnd("deactivate-test", { isAlgorithmResponse: false });

      const state = readState("deactivate-test");
      expect(state!.active).toBe(false);
      expect(state!.currentPhase).toBe("COMPLETE");
    });

    test("does not deactivate when criteria exist for non-algorithm response", () => {
      const initial = makeState({
        sessionId: "keep-active",
        active: true,
        criteria: [makeCriterion()],
        phaseHistory: [
          { phase: "OBSERVE", startedAt: Date.now(), criteriaCount: 0, agentCount: 0 },
        ],
      });
      writeState(initial);

      algorithmEnd("keep-active", { isAlgorithmResponse: false });

      const state = readState("keep-active");
      expect(state!.active).toBe(true); // Should stay active -- has criteria
    });

    test("creates state if none exists for algorithm response", () => {
      algorithmEnd("brand-new", {
        taskDescription: "New task",
        isAlgorithmResponse: true,
      });

      const state = readState("brand-new");
      expect(state).not.toBeNull();
      expect(state!.taskDescription).toBe("New task");
    });

    test("merges criteria from transcript", () => {
      const initial = makeState({
        sessionId: "merge-test",
        currentPhase: "BUILD",
        criteria: [makeCriterion({ id: "C1", status: "pending" })],
      });
      writeState(initial);

      algorithmEnd("merge-test", {
        isAlgorithmResponse: true,
        criteria: [
          makeCriterion({ id: "C1", status: "completed", evidence: "Tests pass" }),
          makeCriterion({ id: "C2", status: "pending" }),
        ],
      });

      const state = readState("merge-test");
      expect(state!.criteria).toHaveLength(2);
      expect(state!.criteria[0].status).toBe("completed"); // Upgraded
      expect(state!.criteria[0].evidence).toBe("Tests pass");
      expect(state!.criteria[1].id).toBe("C2"); // New
    });
  });

  // ── sweepStaleActive ──

  describe("sweepStaleActive", () => {
    test("marks stale active sessions as complete", () => {
      // Create an old active session with an old updated_at
      const old = makeState({
        sessionId: "stale-session",
        active: true,
        currentPhase: "OBSERVE",
      });
      writeState(old);

      // Manually backdate the updated_at in the database
      const db = getDb();
      db.prepare(
        "UPDATE state SET updated_at = datetime('now', '-1 hour') WHERE key = ?"
      ).run("stale-session");

      sweepStaleActive("current-session");

      const state = readState("stale-session");
      expect(state!.active).toBe(false);
      expect(state!.currentPhase).toBe("COMPLETE");
    });

    test("does not sweep current session", () => {
      const current = makeState({
        sessionId: "current-session",
        active: true,
      });
      writeState(current);

      // Backdate
      const db = getDb();
      db.prepare(
        "UPDATE state SET updated_at = datetime('now', '-2 hours') WHERE key = ?"
      ).run("current-session");

      sweepStaleActive("current-session");

      const state = readState("current-session");
      expect(state!.active).toBe(true); // Not swept -- it's the current session
    });

    test("respects phase-aware thresholds (BUILD gets 60 min)", () => {
      const building = makeState({
        sessionId: "build-session",
        active: true,
        currentPhase: "BUILD",
      });
      writeState(building);

      // Set updated_at to 20 minutes ago -- within BUILD's 60 min threshold
      const db = getDb();
      db.prepare(
        "UPDATE state SET updated_at = datetime('now', '-20 minutes') WHERE key = ?"
      ).run("build-session");

      sweepStaleActive("other-session");

      const state = readState("build-session");
      expect(state!.active).toBe(true); // Not swept -- 20 min < 60 min threshold
    });

    test("deletes completed sessions older than 24 hours", () => {
      const old = makeState({
        sessionId: "old-completed",
        active: false,
        currentPhase: "COMPLETE",
        completedAt: Date.now() - 25 * 60 * 60 * 1000,
      });
      writeState(old);

      // Backdate the updated_at
      const db = getDb();
      db.prepare(
        "UPDATE state SET updated_at = datetime('now', '-25 hours') WHERE key = ?"
      ).run("old-completed");

      sweepStaleActive("current-session");

      const state = readState("old-completed");
      expect(state).toBeNull(); // Deleted
    });

    test("does not sweep recently updated active sessions", () => {
      const fresh = makeState({
        sessionId: "fresh-session",
        active: true,
      });
      writeState(fresh);
      // updated_at is 'now' by default -- should not be swept

      sweepStaleActive("other-session");

      const state = readState("fresh-session");
      expect(state!.active).toBe(true);
    });
  });

  // ── algorithmAbandon ──

  describe("algorithmAbandon", () => {
    test("marks session as abandoned", () => {
      const initial = makeState({ sessionId: "abandon-test", active: true });
      writeState(initial);

      const result = algorithmAbandon("abandon-test");

      expect(result).toBe(true);
      const state = readState("abandon-test");
      expect(state!.abandoned).toBe(true);
      expect(state!.active).toBe(false);
      expect(state!.completedAt).toBeDefined();
    });

    test("returns false for missing session", () => {
      const result = algorithmAbandon("nonexistent");
      expect(result).toBe(false);
    });
  });
});
