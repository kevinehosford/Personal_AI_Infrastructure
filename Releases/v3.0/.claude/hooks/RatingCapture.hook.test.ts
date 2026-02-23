import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  appendLog,
  queryLogs,
  createLearning,
  queryLearnings,
} from "./lib/storage";

/**
 * Tests for RatingCapture.hook.ts MEMORY operations.
 *
 * The hook appends rating entries to the 'ratings' log namespace
 * and creates learnings for low ratings. We test these storage
 * operations directly.
 */
describe("RatingCapture storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  test("appendLog writes rating entry to 'ratings' namespace", () => {
    const entry = {
      timestamp: "2026-01-01T00:00:00",
      rating: 8,
      session_id: "sess-abc",
    };

    appendLog("ratings", entry);

    const logs = queryLogs<typeof entry>("ratings");
    expect(logs).toHaveLength(1);
    expect(logs[0].value.rating).toBe(8);
    expect(logs[0].value.session_id).toBe("sess-abc");
  });

  test("multiple ratings accumulate in order", () => {
    appendLog("ratings", { rating: 7, session_id: "s1" });
    appendLog("ratings", { rating: 3, session_id: "s2" });
    appendLog("ratings", { rating: 9, session_id: "s3" });

    const logs = queryLogs<{ rating: number }>("ratings");
    expect(logs).toHaveLength(3);
    expect(logs[0].value.rating).toBe(7);
    expect(logs[1].value.rating).toBe(3);
    expect(logs[2].value.rating).toBe(9);
  });

  test("implicit ratings include sentiment metadata", () => {
    const entry = {
      timestamp: "2026-01-01T00:00:00",
      rating: 4,
      session_id: "sess-abc",
      source: "implicit" as const,
      sentiment_summary: "Mild frustration with output",
      confidence: 0.72,
    };

    appendLog("ratings", entry);

    const logs = queryLogs<typeof entry>("ratings");
    expect(logs[0].value.source).toBe("implicit");
    expect(logs[0].value.sentiment_summary).toBe("Mild frustration with output");
    expect(logs[0].value.confidence).toBe(0.72);
  });

  test("low rating creates a learning entry", () => {
    // Simulate what captureLowRatingLearning does
    createLearning({
      category: "ALGORITHM",
      source: "low-rating-3",
      title: "Low Rating: 3/10",
      content: "# Low Rating Captured: 3/10\n\nContext here...",
    });

    const learnings = queryLearnings({ category: "ALGORITHM" });
    expect(learnings).toHaveLength(1);
    expect(learnings[0].source).toBe("low-rating-3");
    expect(learnings[0].title).toBe("Low Rating: 3/10");
  });

  test("ratings and learnings are in separate stores", () => {
    appendLog("ratings", { rating: 2, session_id: "s1" });
    createLearning({
      category: "SYSTEM",
      source: "sentiment-rating-2",
      title: "Implicit Low Rating: 2/10",
      content: "Context...",
    });

    const ratings = queryLogs("ratings");
    const learnings = queryLearnings();

    expect(ratings).toHaveLength(1);
    expect(learnings).toHaveLength(1);
    // Different stores, different counts
  });
});
