import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  readState,
  writeState,
  deleteState,
  listKeys,
} from "./storage";

/**
 * Tests for tab-setter.ts MEMORY operations.
 *
 * The tab-setter uses SQLite for:
 * - kitty-sessions: per-session kitty environment persistence
 * - tab-titles: per-window tab state persistence
 * - session-names: session name lookup for tab labels
 */
describe("tab-setter storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  // ── Kitty sessions ──

  describe("kitty-sessions namespace", () => {
    test("persists kitty session environment", () => {
      writeState("kitty-sessions", "sess-abc", {
        listenOn: "unix:/tmp/kitty-user",
        windowId: "42",
      });

      const entry = readState<{ listenOn: string; windowId: string }>(
        "kitty-sessions",
        "sess-abc"
      );
      expect(entry).not.toBeNull();
      expect(entry!.listenOn).toBe("unix:/tmp/kitty-user");
      expect(entry!.windowId).toBe("42");
    });

    test("cleans up kitty session on delete", () => {
      writeState("kitty-sessions", "sess-abc", {
        listenOn: "unix:/tmp/kitty-user",
        windowId: "42",
      });

      deleteState("kitty-sessions", "sess-abc");

      expect(readState("kitty-sessions", "sess-abc")).toBeNull();
    });

    test("multiple sessions coexist", () => {
      writeState("kitty-sessions", "sess-1", {
        listenOn: "unix:/tmp/k1",
        windowId: "1",
      });
      writeState("kitty-sessions", "sess-2", {
        listenOn: "unix:/tmp/k2",
        windowId: "2",
      });

      expect(readState("kitty-sessions", "sess-1")).not.toBeNull();
      expect(readState("kitty-sessions", "sess-2")).not.toBeNull();
    });
  });

  // ── Tab titles ──

  describe("tab-titles namespace", () => {
    test("writes and reads tab state for window", () => {
      const stateData = {
        title: "Fix Auth Bug | Building",
        inactiveBg: "#2D3A4C",
        state: "working",
        timestamp: "2026-01-15T14:30:00Z",
      };

      writeState("tab-titles", "42", stateData);

      const result = readState<typeof stateData>("tab-titles", "42");
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Fix Auth Bug | Building");
      expect(result!.state).toBe("working");
    });

    test("clears tab state on idle (delete)", () => {
      writeState("tab-titles", "42", {
        title: "Working...",
        state: "working",
      });

      deleteState("tab-titles", "42");

      expect(readState("tab-titles", "42")).toBeNull();
    });

    test("updates tab state in place (upsert)", () => {
      writeState("tab-titles", "42", {
        title: "Observing",
        state: "working",
        phase: "OBSERVE",
      });

      writeState("tab-titles", "42", {
        title: "Building",
        state: "working",
        phase: "BUILD",
      });

      const result = readState<{ title: string; phase: string }>(
        "tab-titles",
        "42"
      );
      expect(result!.title).toBe("Building");
      expect(result!.phase).toBe("BUILD");
    });

    test("lists all window IDs with tab state", () => {
      writeState("tab-titles", "42", { title: "t1" });
      writeState("tab-titles", "43", { title: "t2" });
      writeState("tab-titles", "44", { title: "t3" });

      const keys = listKeys("tab-titles");
      expect(keys).toHaveLength(3);
      expect(keys).toContain("42");
      expect(keys).toContain("43");
      expect(keys).toContain("44");
    });

    test("preserves previousTitle in tab state", () => {
      writeState("tab-titles", "42", {
        title: "New Title",
        state: "working",
        previousTitle: "Old Title",
      });

      const result = readState<{ previousTitle: string }>("tab-titles", "42");
      expect(result!.previousTitle).toBe("Old Title");
    });
  });

  // ── Session names ──

  describe("session-names namespace", () => {
    test("reads session name mapping", () => {
      writeState("session-names", "map", {
        "sess-abc": "Fix Authentication",
        "sess-def": "Add Logging",
      });

      const names = readState<Record<string, string>>("session-names", "map");
      expect(names).not.toBeNull();
      expect(names!["sess-abc"]).toBe("Fix Authentication");
    });

    test("returns null for missing session names", () => {
      expect(readState("session-names", "map")).toBeNull();
    });
  });
});
