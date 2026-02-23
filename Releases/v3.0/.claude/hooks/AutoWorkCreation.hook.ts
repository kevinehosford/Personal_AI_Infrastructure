#!/usr/bin/env bun
/**
 * AutoWorkCreation.hook.ts - Session/Task Management (UserPromptSubmit)
 *
 * PURPOSE:
 * Creates and manages the session/task hierarchy for each Claude Code session.
 * - SESSION: One directory per Claude Code session (the primitive)
 * - TASK: Subdirectories for distinct work items within a session
 *
 * Each task has its own algorithm execution context (ISC.json, THREAD.md).
 *
 * TRIGGER: UserPromptSubmit
 *
 * STORAGE:
 * Primary: SQLite via storage.ts (work_sessions, work_tasks, state tables)
 * Secondary: Filesystem WORK/ directories for backward compat with LoadContext, WorkCompletionLearning
 *
 * FILESYSTEM STRUCTURE (backward compat):
 * WORK/{timestamp}_{session-title}/
 * ├── META.yaml                    # Session metadata
 * ├── tasks/
 * │   ├── 001_{task-slug}/
 * │   │   ├── ISC.json             # Task's Ideal State Criteria
 * │   │   └── THREAD.md            # Task's algorithm log (includes metadata in frontmatter)
 * │   └── current -> 001_...       # Symlink to active task
 * └── scratch/                     # Temporary files
 */

import { mkdirSync, existsSync, writeFileSync, symlinkSync, unlinkSync, lstatSync } from 'fs';
import { join } from 'path';
import { getPSTComponents, getISOTimestamp } from './lib/time';
import { generatePRDTemplate, generatePRDFilename } from './lib/prd-template';
import { paiPath } from './lib/paths';
import {
  readState as storageRead,
  writeState as storageWrite,
  createWorkSession,
  createWorkTask,
} from './lib/storage';

interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;
}

interface CurrentWork {
  session_id: string;
  session_dir: string;
  current_task: string;
  task_title: string;
  task_count: number;
  created_at: string;
  prd_path?: string;
}

interface PromptClassification {
  type: 'work' | 'question' | 'conversational';
  title: string;
  effort: 'TRIVIAL' | 'QUICK' | 'STANDARD' | 'THOROUGH';
  is_new_topic: boolean;
}

const WORK_DIR = paiPath('MEMORY', 'WORK');

async function readStdinWithTimeout(timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    process.stdin.on('data', (chunk) => { data += chunk.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function readCurrentWork(sessionId?: string): CurrentWork | null {
  try {
    // Try session-scoped key first, fall back to legacy
    if (sessionId) {
      const scoped = storageRead<CurrentWork>('current-work', sessionId);
      if (scoped) return scoped;
    }
    return storageRead<CurrentWork>('current-work', 'legacy') ?? null;
  } catch {
    return null;
  }
}

function writeCurrentWork(state: CurrentWork): void {
  storageWrite('current-work', state.session_id, state);
}

function slugify(text: string, maxLen: number = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, maxLen)
    .replace(/-$/, '') || 'task';
}

function generateSessionDirName(title: string): string {
  const { year, month, day, hours, minutes, seconds } = getPSTComponents();
  const timestamp = `${year}${month}${day}-${hours}${minutes}${seconds}`;
  return `${timestamp}_${slugify(title, 50)}`;
}

/**
 * Create session directory structure + SQLite work_sessions record.
 * Filesystem structure kept for backward compatibility with LoadContext, WorkCompletionLearning.
 */
function createSessionDirectory(sessionDirName: string, sessionId: string, title: string): string {
  const sessionPath = join(WORK_DIR, sessionDirName);
  const timestamp = getISOTimestamp();

  // Create session structure (still needed for PRD files and other hooks)
  mkdirSync(join(sessionPath, 'tasks'), { recursive: true });
  mkdirSync(join(sessionPath, 'scratch'), { recursive: true });

  // Session META.yaml (backward compat for hooks that still read filesystem)
  const metaYaml = `id: "${sessionDirName}"
title: "${title}"
session_id: "${sessionId}"
created_at: "${timestamp}"
completed_at: null
status: "ACTIVE"
`;
  writeFileSync(join(sessionPath, 'META.yaml'), metaYaml, 'utf-8');

  // Store in SQLite (primary record)
  createWorkSession({
    id: sessionDirName,
    sessionId,
    title,
    meta: { created_at: timestamp, status: 'ACTIVE' },
  });

  console.error(`[AutoWork] Created session: ${sessionPath}`);
  return sessionPath;
}

/**
 * Create task directory with ISC.json and THREAD.md (with frontmatter metadata).
 * Also stores task data in SQLite via createWorkTask().
 * Filesystem files kept for backward compatibility with other hooks.
 */
function createTaskDirectory(
  sessionDirName: string,
  sessionPath: string,
  taskNumber: number,
  title: string,
  effort: string,
  prompt: string
): { taskDirName: string; prdPath: string } {
  const taskId = String(taskNumber).padStart(3, '0');
  const taskSlug = slugify(title);
  const taskDirName = `${taskId}_${taskSlug}`;
  const taskPath = join(sessionPath, 'tasks', taskDirName);
  const timestamp = getISOTimestamp();

  mkdirSync(taskPath, { recursive: true });

  // Task THREAD.md with frontmatter metadata (backward compat for filesystem consumers)
  const thread = `---
taskId: "${taskDirName}"
title: "${title}"
effortLevel: "${effort}"
status: "IN_PROGRESS"
createdAt: "${timestamp}"
prompt: |
  ${prompt.substring(0, 500).replace(/\n/g, '\n  ')}
---

# Algorithm Thread: ${title}

## Phase Log

### OBSERVE Phase
_Pending..._

### THINK Phase
_Pending..._

### PLAN Phase
_Pending..._

### BUILD Phase
_Pending..._

### EXECUTE Phase
_Pending..._

### VERIFY Phase
_Pending..._

### LEARN Phase
_Pending..._

---

## ISC Evolution

_Criteria updates logged here..._

---

## Key Observations

_Important observations during execution..._
`;
  writeFileSync(join(taskPath, 'THREAD.md'), thread, 'utf-8');

  // Task ISC.json with proper scaffold (backward compat for filesystem consumers)
  const isc = {
    taskId: taskDirName,
    status: 'PENDING',
    effortLevel: effort,
    criteria: [],
    antiCriteria: [],
    satisfaction: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeFileSync(join(taskPath, 'ISC.json'), JSON.stringify(isc, null, 2), 'utf-8');

  // Task PRD file — stub for model to populate during Algorithm phases
  const prdSlug = taskSlug.substring(0, 40);
  const prdFilename = generatePRDFilename(prdSlug);
  const prdContent = generatePRDTemplate({
    title,
    slug: prdSlug,
    effortLevel: effort,
    prompt,
  });
  writeFileSync(join(taskPath, prdFilename), prdContent, 'utf-8');

  // Update 'current' symlink (backward compat — queryable via SQL now)
  const currentLink = join(sessionPath, 'tasks', 'current');
  try {
    if (existsSync(currentLink) || lstatSync(currentLink)) {
      unlinkSync(currentLink);
    }
  } catch { /* ignore if doesn't exist */ }
  symlinkSync(taskDirName, currentLink);

  // Store in SQLite (primary record)
  createWorkTask({
    sessionId: sessionDirName,
    taskNumber,
    slug: taskSlug,
    isc,
    thread,
  });

  console.error(`[AutoWork] Created task: ${taskPath}`);
  console.error(`[AutoWork] Created PRD: ${prdFilename}`);
  return { taskDirName, prdPath: join(taskPath, prdFilename) };
}

/**
 * Simple heuristic classification — no inference call.
 * First prompt = new work. Short confirmations = conversational continuation.
 * Everything else = continuation of current work.
 */
function classifyPrompt(prompt: string, hasExistingSession: boolean): PromptClassification {
  const trimmed = prompt.trim();

  // Short confirmations/greetings
  if (trimmed.length < 20 && /^(yes|no|ok|okay|thanks|proceed|continue|go ahead|sure|got it|hi|hello|hey|good morning|good evening|\d{1,2})$/i.test(trimmed)) {
    return { type: 'conversational', title: '', effort: 'TRIVIAL', is_new_topic: false };
  }

  // First prompt in session = always new work
  if (!hasExistingSession) {
    const title = trimmed.substring(0, 60).replace(/[^a-zA-Z0-9\s]/g, '').trim();
    return { type: 'work', title, effort: 'STANDARD', is_new_topic: true };
  }

  // Existing session — default to continuation
  return {
    type: 'work',
    title: trimmed.substring(0, 60).replace(/[^a-zA-Z0-9\s]/g, '').trim(),
    effort: 'STANDARD',
    is_new_topic: false,
  };
}

async function main() {
  try {
    const input = await readStdinWithTimeout();
    const data: HookInput = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || '';
    const sessionId = data.session_id || 'unknown';

    if (!prompt || prompt.length < 2) {
      process.exit(0);
    }

    if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

    let currentWork = readCurrentWork(sessionId);
    const isExistingSession = currentWork && currentWork.session_id === sessionId;

    const classification = classifyPrompt(prompt, !!isExistingSession);

    // Skip task creation for pure conversational
    if (classification.type === 'conversational' && !classification.is_new_topic) {
      console.error('[AutoWork] Conversational continuation, no new task');
      process.exit(0);
    }

    if (!isExistingSession) {
      // New session: create session directory + first task
      const title = classification.title || prompt.substring(0, 50);
      const sessionDirName = generateSessionDirName(title);
      const sessionPath = createSessionDirectory(sessionDirName, sessionId, title);

      const { taskDirName, prdPath } = createTaskDirectory(
        sessionDirName,
        sessionPath,
        1,
        title,
        classification.effort,
        prompt
      );

      currentWork = {
        session_id: sessionId,
        session_dir: sessionDirName,
        current_task: taskDirName,
        task_title: title,
        task_count: 1,
        created_at: getISOTimestamp(),
        prd_path: prdPath,
      };
      writeCurrentWork(currentWork);

      console.error(`[AutoWork] New session with task: ${taskDirName}`);
    } else if (classification.is_new_topic) {
      // Existing session, new topic: create new task
      const sessionPath = join(WORK_DIR, currentWork!.session_dir);
      const newTaskNumber = currentWork!.task_count + 1;
      const title = classification.title || prompt.substring(0, 50);

      const { taskDirName, prdPath } = createTaskDirectory(
        currentWork!.session_dir,
        sessionPath,
        newTaskNumber,
        title,
        classification.effort,
        prompt
      );

      currentWork!.current_task = taskDirName;
      currentWork!.task_title = title;
      currentWork!.task_count = newTaskNumber;
      currentWork!.prd_path = prdPath;
      writeCurrentWork(currentWork!);

      console.error(`[AutoWork] New task in session: ${taskDirName}`);
    } else {
      // Continuation of current task - no new task needed
      console.error(`[AutoWork] Continuing task: ${currentWork!.current_task}`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`[AutoWork] Error: ${err}`);
    process.exit(0);
  }
}

main();
