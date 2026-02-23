#!/usr/bin/env bun
/**
 * WorkCompletionLearning.hook.ts - Extract Learnings from Completed Work (SessionEnd)
 *
 * PURPOSE:
 * Bridges the WORK/ system to the LEARNING/ system. When a session ends with
 * significant work completed, this hook captures the work metadata (files changed,
 * tools used, ideal state criteria) and creates a learning file for future reference.
 * This ensures insights compound over time rather than being lost.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT:
 * - stdin: Hook input JSON (session_id, transcript_path)
 * - Files: MEMORY/STATE/current-work.json, MEMORY/WORK/<dir>/META.yaml
 *
 * OUTPUT:
 * - stdout: None
 * - stderr: Status messages
 * - exit(0): Always (non-blocking)
 *
 * SIDE EFFECTS:
 * - Creates: MEMORY/LEARNING/<category>/<YYYY-MM>/<datetime>_work_<slug>.md
 * - Reads: Current work state and work directory metadata
 *
 * INTER-HOOK RELATIONSHIPS:
 * - DEPENDS ON: AutoWorkCreation (expects WORK/ structure)
 * - COORDINATES WITH: SessionSummary (both run at SessionEnd)
 * - MUST RUN BEFORE: SessionSummary (captures before state is cleared)
 * - MUST RUN AFTER: Stop handlers (captures completed work)
 *
 * SIGNIFICANT WORK CRITERIA:
 * A learning is only captured if:
 * - Files were changed, OR
 * - Multiple items exist in work directory, OR
 * - Work was manually created (source: MANUAL)
 *
 * LEARNING CATEGORIES:
 * - ALGORITHM: Insights about process/approach improvement
 * - SYSTEM: Technical system improvements
 * (Determined by getLearningCategory utility)
 *
 * ERROR HANDLING:
 * - No active work: Silent exit
 * - Missing META.yaml: Silent exit
 * - Write failures: Logged to stderr, silent exit
 *
 * PERFORMANCE:
 * - Non-blocking: Yes (fire-and-forget at session end)
 * - Typical execution: <100ms
 */

import { getISOTimestamp } from './lib/time';
import { getLearningCategory } from './lib/learning-utils';
import {
  readState,
  getWorkSession,
  getWorkTasks,
  createLearning,
} from './lib/storage';

interface CurrentWork {
  session_id: string;
  session_dir: string;
  current_task: string;
  task_title: string;
  task_count: number;
  created_at: string;
}

interface WorkMeta {
  id: string;
  title: string | null;
  created_at: string;
  completed_at: string | null;
  source: string;
  status: string;
  session_id: string | null;
  lineage?: {
    tools_used: string[];
    files_changed: string[];
    agents_spawned: string[];
  };
}

function writeLearningEntry(workMeta: WorkMeta, idealContent: string): void {
  const title = workMeta.title || 'Untitled work';
  const category = getLearningCategory(title);

  // Calculate session duration
  let duration = 'Unknown';
  if (workMeta.created_at && workMeta.completed_at) {
    const start = new Date(workMeta.created_at);
    const end = new Date(workMeta.completed_at);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (minutes < 60) {
      duration = `${minutes} minutes`;
    } else {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      duration = `${hours}h ${mins}m`;
    }
  }

  const content = `# Work Completion Learning

**Title:** ${title}
**Duration:** ${duration}
**Category:** ${category}
**Session:** ${workMeta.session_id || 'unknown'}

---

## Ideal State Criteria

${idealContent || 'Not specified'}

## What Was Done

- **Files Changed:** ${workMeta.lineage?.files_changed?.length || 0}
- **Tools Used:** ${workMeta.lineage?.tools_used?.join(', ') || 'None tracked'}
- **Agents Spawned:** ${workMeta.lineage?.agents_spawned?.length || 0}

## Insights

*This work session completed successfully. Consider what made it effective:*

- Was the approach straightforward or did it require iteration?
- Were there any blockers or surprises?
- What patterns from this work apply to future tasks?

---

*Auto-captured by WorkCompletionLearning hook at session end*
`;

  createLearning({
    category,
    source: 'work-completion',
    title: `Work: ${title}`,
    content,
  });

  console.error(`[WorkCompletionLearning] Created learning for: ${title}`);
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

    // Read current work state from SQLite (session-scoped with legacy fallback)
    let currentWork: CurrentWork | null = null;
    if (sessionId) {
      currentWork = readState<CurrentWork>('current-work', sessionId);
    }
    if (!currentWork) {
      currentWork = readState<CurrentWork>('current-work', 'legacy');
    }

    if (!currentWork) {
      console.error('[WorkCompletionLearning] No active work session');
      process.exit(0);
    }

    // Guard: don't process another session's state
    if (sessionId && currentWork.session_id !== sessionId) {
      console.error('[WorkCompletionLearning] State belongs to different session, skipping');
      process.exit(0);
    }

    if (!currentWork.session_dir) {
      console.error('[WorkCompletionLearning] No work directory in current session');
      process.exit(0);
    }

    // Read work session metadata from SQLite
    const workSession = getWorkSession(currentWork.session_dir);

    if (!workSession) {
      console.error('[WorkCompletionLearning] No work session found in database');
      process.exit(0);
    }

    // Build WorkMeta from the work session
    const meta = (workSession.meta || {}) as Record<string, unknown>;
    const workMeta: WorkMeta = {
      id: workSession.id,
      title: workSession.title,
      created_at: workSession.createdAt,
      completed_at: workSession.completedAt || getISOTimestamp(),
      source: (meta.source as string) || 'AUTO',
      status: workSession.status,
      session_id: workSession.sessionId,
      lineage: (meta.lineage as WorkMeta['lineage']) || undefined,
    };

    // Read ISC from work tasks
    let idealContent = '';
    const tasks = getWorkTasks(currentWork.session_dir);
    if (tasks.length > 0) {
      const criteria: string[] = [];
      const antiCriteria: string[] = [];
      for (const task of tasks) {
        const isc = task.isc as Record<string, unknown> | null;
        if (isc) {
          if (Array.isArray(isc.criteria)) {
            criteria.push(...(isc.criteria as string[]));
          }
          if (Array.isArray(isc.antiCriteria)) {
            antiCriteria.push(...(isc.antiCriteria as string[]));
          }
        }
      }
      if (criteria.length > 0) {
        idealContent = '**Criteria:**\n' + criteria.map((c: string) => `- ${c}`).join('\n');
      }
      if (antiCriteria.length > 0) {
        idealContent += '\n\n**Anti-Criteria:**\n' + antiCriteria.map((c: string) => `- ${c}`).join('\n');
      }
    }

    // Check if this was significant work
    const hasSignificantWork = (
      (workMeta.lineage?.files_changed?.length || 0) > 0 ||
      currentWork.task_count > 1 ||
      workMeta.source === 'MANUAL'
    );

    if (hasSignificantWork) {
      writeLearningEntry(workMeta, idealContent);
    } else {
      console.error('[WorkCompletionLearning] Trivial work session, skipping learning capture');
    }

    process.exit(0);
  } catch (error) {
    // Silent failure - don't disrupt workflow
    console.error(`[WorkCompletionLearning] Error: ${error}`);
    process.exit(0);
  }
}

main();
