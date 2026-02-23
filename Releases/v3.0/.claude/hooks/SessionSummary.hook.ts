#!/usr/bin/env bun
/**
 * SessionSummary.hook.ts - Mark Work Complete and Clear State (SessionEnd)
 *
 * PURPOSE:
 * Finalizes a Claude Code session by marking the current work directory as
 * COMPLETED and clearing the session state. This ensures clean session boundaries
 * and accurate work tracking.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT:
 * - stdin: Hook input JSON (session_id, transcript_path)
 * - Files: MEMORY/STATE/current-work.json
 *
 * OUTPUT:
 * - stdout: None
 * - stderr: Status messages
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Updates: MEMORY/WORK/<dir>/META.yaml (status: COMPLETED, completed_at timestamp)
 * - Deletes: MEMORY/STATE/current-work.json (clears session state)
 * - Resets: Kitty tab title and color to defaults (no lingering colored backgrounds)
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: AutoWorkCreation (expects WORK/ structure and current-work.json)
 * - COORDINATES WITH: WorkCompletionLearning (both run at SessionEnd)
 * - MUST RUN BEFORE: None (final cleanup)
 * - MUST RUN AFTER: WorkCompletionLearning (learning capture uses state before clear)
 *
 * STATE TRANSITIONS:
 * - META.yaml status: "ACTIVE" → "COMPLETED"
 * - META.yaml completed_at: null → ISO timestamp
 * - current-work.json: exists → deleted
 *
 * DESIGN NOTES:
 * - Does NOT write to SESSIONS/ directory (WORK/ is the primary tracking system)
 * - Deleting current-work.json signals a clean slate for next session
 *
 * ERROR HANDLING:
 * - No current work: Logs message, exits gracefully
 * - Missing META.yaml: Skips update, continues to state clear
 * - File operation failures: Logged to stderr
 *
 * PERFORMANCE:
 * - Non-blocking: Yes
 * - Typical execution: <50ms
 */

import { getISOTimestamp } from './lib/time';
import { setTabState, cleanupKittySession } from './lib/tab-setter';
import { readState, deleteState, completeWorkSession } from './lib/storage';

interface CurrentWork {
  session_id: string;
  session_dir: string;
  current_task: string;
  task_title: string;
  task_count: number;
  created_at: string;
}

/**
 * Mark work session as completed and clear session state
 */
function clearSessionWork(sessionId?: string): void {
  try {
    // Read current work state from SQLite (session-scoped with legacy fallback)
    let currentWork: CurrentWork | null = null;
    if (sessionId) {
      currentWork = readState<CurrentWork>('current-work', sessionId);
    }
    if (!currentWork) {
      currentWork = readState<CurrentWork>('current-work', 'legacy');
    }

    if (!currentWork) {
      console.error('[SessionSummary] No current work to complete');
      return;
    }

    // Guard: don't process another session's state
    if (sessionId && currentWork.session_id !== sessionId) {
      console.error('[SessionSummary] State belongs to different session, skipping');
      return;
    }

    // Mark work session as COMPLETED in SQLite
    if (currentWork.session_dir) {
      completeWorkSession(currentWork.session_dir, {
        status: 'COMPLETED',
        completed_at: getISOTimestamp(),
      });
      console.error(`[SessionSummary] Marked work session as COMPLETED: ${currentWork.session_dir}`);
    }

    // Delete state entries
    if (sessionId) {
      deleteState('current-work', sessionId);
    }
    deleteState('current-work', 'legacy');
    console.error('[SessionSummary] Cleared session work state');
  } catch (error) {
    console.error(`[SessionSummary] Error clearing session work: ${error}`);
  }
}

async function main() {
  try {
    // Read input from stdin with timeout — SessionEnd hooks may receive
    // empty or slow stdin. Proceed regardless since state is read from disk.
    let sessionId: string | undefined;
    try {
      const input = await Promise.race([
        Bun.stdin.text(),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      if (input && input.trim()) {
        const parsed = JSON.parse(input);
        sessionId = parsed.session_id;
      }
    } catch {
      // Timeout or parse error — proceed without session_id
    }

    // Mark work as complete and clear state
    // NOTE: Does NOT write to SESSIONS/ - WORK/ is the primary system
    clearSessionWork(sessionId);

    // Reset Kitty tab to neutral styling — no lingering colored backgrounds
    try {
      setTabState({ title: '', state: 'idle', sessionId });
      console.error('[SessionSummary] Tab reset to default styling');
    } catch {
      console.error('[SessionSummary] Tab reset failed (non-critical)');
    }

    // Clean up per-session kitty env file (prevents unbounded file accumulation)
    if (sessionId) {
      cleanupKittySession(sessionId);
      console.error(`[SessionSummary] Cleaned up kitty session: ${sessionId}`);
    }

    console.error('[SessionSummary] Session ended, work marked complete');
    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[SessionSummary] SessionEnd hook error: ${error}`);
    process.exit(0);
  }
}

main();
