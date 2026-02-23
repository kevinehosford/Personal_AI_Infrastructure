import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  appendLog,
  queryLogs,
} from "./lib/storage";

/**
 * Tests for RelationshipMemory.hook.ts MEMORY operations.
 *
 * The hook appends relationship notes to the 'relationship' log namespace.
 */
describe("RelationshipMemory storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  test("appends relationship note to log", () => {
    appendLog("relationship", {
      date: "2026-01-15",
      time: "14:30",
      type: "B",
      entities: ["@Sam"],
      content: "Debugged voice notification system",
      formatted: "B @Sam: Debugged voice notification system",
    });

    const logs = queryLogs<{
      date: string;
      type: string;
      formatted: string;
    }>("relationship");

    expect(logs).toHaveLength(1);
    expect(logs[0].value.date).toBe("2026-01-15");
    expect(logs[0].value.type).toBe("B");
    expect(logs[0].value.formatted).toBe("B @Sam: Debugged voice notification system");
  });

  test("appends multiple notes from one session", () => {
    const notes = [
      {
        date: "2026-01-15",
        time: "14:30",
        type: "B",
        entities: ["@Sam"],
        content: "Fixed auth flow",
        formatted: "B @Sam: Fixed auth flow",
      },
      {
        date: "2026-01-15",
        time: "14:30",
        type: "O",
        entities: ["@Kevin"],
        content: "Responded positively to this session's approach",
        confidence: 0.70,
        formatted: "O(c=0.70) @Kevin: Responded positively to this session's approach",
      },
    ];

    for (const note of notes) {
      appendLog("relationship", note);
    }

    const logs = queryLogs("relationship");
    expect(logs).toHaveLength(2);
  });

  test("notes with confidence values are preserved", () => {
    appendLog("relationship", {
      date: "2026-01-15",
      time: "15:00",
      type: "O",
      entities: ["@Kevin"],
      content: "Frustrated during this session",
      confidence: 0.75,
      formatted: "O(c=0.75) @Kevin: Frustrated during this session",
    });

    const logs = queryLogs<{ confidence: number }>("relationship");
    expect(logs[0].value.confidence).toBe(0.75);
  });

  test("relationship notes are isolated from other namespaces", () => {
    appendLog("relationship", { type: "B", content: "note" });
    appendLog("security", { type: "alert", content: "event" });
    appendLog("ratings", { rating: 7 });

    expect(queryLogs("relationship")).toHaveLength(1);
    expect(queryLogs("security")).toHaveLength(1);
    expect(queryLogs("ratings")).toHaveLength(1);
  });

  test("recent notes can be queried with limit", () => {
    for (let i = 0; i < 20; i++) {
      appendLog("relationship", {
        date: "2026-01-15",
        content: `note-${i}`,
      });
    }

    const recent = queryLogs("relationship", { limit: 10 });
    expect(recent).toHaveLength(10);
  });

  test("handles empty relationship namespace", () => {
    const logs = queryLogs("relationship");
    expect(logs).toEqual([]);
  });
});
