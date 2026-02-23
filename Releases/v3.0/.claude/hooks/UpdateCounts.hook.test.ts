import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  writeState,
  readState,
  appendLog,
  queryLogs,
} from "./lib/storage";

/**
 * Tests for UpdateCounts handler MEMORY operations.
 *
 * The handler writes usage cache to SQLite and reads ratings count
 * from the logs table.
 */
describe("UpdateCounts storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  test("writes usage cache to state store", () => {
    const usageData = {
      five_hour: { utilization: 45 },
      seven_day: { utilization: 30 },
    };

    writeState("usage-cache", "anthropic-usage", usageData);

    const result = readState<typeof usageData>("usage-cache", "anthropic-usage");
    expect(result).not.toBeNull();
    expect(result!.five_hour.utilization).toBe(45);
    expect(result!.seven_day.utilization).toBe(30);
  });

  test("usage cache updates overwrite previous values", () => {
    writeState("usage-cache", "anthropic-usage", {
      five_hour: { utilization: 20 },
    });

    writeState("usage-cache", "anthropic-usage", {
      five_hour: { utilization: 80 },
    });

    const result = readState<{ five_hour: { utilization: number } }>(
      "usage-cache",
      "anthropic-usage"
    );
    expect(result!.five_hour.utilization).toBe(80);
  });

  test("ratings count reflects number of log entries", () => {
    // Empty initially
    expect(queryLogs("ratings").length).toBe(0);

    // Add some ratings
    appendLog("ratings", { rating: 8, session_id: "s1" });
    appendLog("ratings", { rating: 6, session_id: "s2" });
    appendLog("ratings", { rating: 9, session_id: "s3" });

    expect(queryLogs("ratings").length).toBe(3);
  });

  test("usage cache with workspace cost data", () => {
    const usageData = {
      five_hour: { utilization: 55 },
      seven_day: { utilization: 40 },
      workspace_cost: {
        month_used_cents: 4500,
        updated_at: "2026-01-15T12:00:00Z",
      },
    };

    writeState("usage-cache", "anthropic-usage", usageData);

    const result = readState<typeof usageData>("usage-cache", "anthropic-usage");
    expect(result!.workspace_cost.month_used_cents).toBe(4500);
  });
});
