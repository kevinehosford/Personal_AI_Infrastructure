import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  initDb,
  resetDb,
  appendLog,
  queryLogs,
} from "./lib/storage";

/**
 * Tests for SecurityValidator.hook.ts MEMORY operations.
 *
 * The hook appends security event logs to the 'security' namespace.
 * We test the storage operations directly.
 */
describe("SecurityValidator storage operations", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    resetDb();
  });

  test("logs security block event", () => {
    const event = {
      timestamp: "2026-01-01T00:00:00",
      session_id: "sess-abc",
      event_type: "block" as const,
      tool: "Bash",
      category: "bash_command" as const,
      target: "rm -rf /",
      reason: "Destructive command",
      action_taken: "Hard block - exit 2",
    };

    appendLog("security", event);

    const logs = queryLogs<typeof event>("security");
    expect(logs).toHaveLength(1);
    expect(logs[0].value.event_type).toBe("block");
    expect(logs[0].value.target).toBe("rm -rf /");
    expect(logs[0].value.reason).toBe("Destructive command");
  });

  test("logs security confirm event", () => {
    appendLog("security", {
      timestamp: new Date().toISOString(),
      session_id: "sess-abc",
      event_type: "confirm",
      tool: "Bash",
      category: "bash_command",
      target: "git push --force",
      reason: "Force push requires confirmation",
      action_taken: "Prompted user for confirmation",
    });

    const logs = queryLogs("security");
    expect(logs).toHaveLength(1);
  });

  test("logs security alert event", () => {
    appendLog("security", {
      timestamp: new Date().toISOString(),
      session_id: "sess-abc",
      event_type: "alert",
      tool: "Bash",
      category: "bash_command",
      target: "sudo apt-get install",
      reason: "Sudo usage detected",
      action_taken: "Logged alert, allowed execution",
    });

    const logs = queryLogs("security");
    expect(logs).toHaveLength(1);
  });

  test("logs path access events", () => {
    appendLog("security", {
      timestamp: new Date().toISOString(),
      session_id: "sess-abc",
      event_type: "block",
      tool: "Read",
      category: "path_access",
      target: "/home/user/.ssh/id_rsa",
      reason: "Zero access path: ~/.ssh",
      action_taken: "Hard block - exit 2",
    });

    const logs = queryLogs<{ category: string; tool: string }>("security");
    expect(logs[0].value.category).toBe("path_access");
    expect(logs[0].value.tool).toBe("Read");
  });

  test("multiple security events accumulate", () => {
    for (let i = 0; i < 5; i++) {
      appendLog("security", {
        timestamp: new Date().toISOString(),
        session_id: `sess-${i}`,
        event_type: "alert",
        tool: "Bash",
        category: "bash_command",
        target: `command-${i}`,
        action_taken: "allowed",
      });
    }

    const logs = queryLogs("security");
    expect(logs).toHaveLength(5);
  });

  test("security events are isolated from other log namespaces", () => {
    appendLog("security", { event: "security-event" });
    appendLog("ratings", { event: "rating-event" });

    const securityLogs = queryLogs("security");
    const ratingLogs = queryLogs("ratings");

    expect(securityLogs).toHaveLength(1);
    expect(ratingLogs).toHaveLength(1);
  });
});
