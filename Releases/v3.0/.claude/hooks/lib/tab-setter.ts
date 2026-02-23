/**
 * tab-setter.ts - Unified tab state setter.
 *
 * Single function that:
 * 1. Sets Kitty tab title and color via remote control
 * 2. Persists per-window state for daemon recovery
 *
 * All hooks call setTabState() instead of directly running kitten commands.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { TAB_COLORS, PHASE_TAB_CONFIG, ACTIVE_TAB_BG, ACTIVE_TAB_FG, INACTIVE_TAB_FG, type TabState, type AlgorithmTabPhase } from './tab-constants';
import { paiPath } from './paths';
import {
  readState as storageRead,
  writeState as storageWrite,
  deleteState as storageDelete,
  listKeys,
} from './storage';

/**
 * Get Kitty environment from env vars or persisted per-session file.
 *
 * Resolution order:
 * 1. Process env vars (direct terminal context — always correct)
 * 2. Per-session file: kitty-sessions/{sessionId}.json (no shared state, no races)
 * 3. Default socket at /tmp/kitty-$USER (fallback for socket-only configs)
 *
 * IMPORTANT: listenOn MUST be set for remote control to work safely.
 * Without it, kitten @ commands fall back to escape-sequence IPC which
 * leaks garbage text into the terminal output. See PR #493.
 */
function getKittyEnv(sessionId?: string): { listenOn: string | null; windowId: string | null } {
  // Try environment first (direct terminal calls)
  let listenOn = process.env.KITTY_LISTEN_ON || null;
  let windowId = process.env.KITTY_WINDOW_ID || null;
  if (listenOn && windowId) return { listenOn, windowId };

  // Per-session lookup from SQLite (preferred — no shared mutable state)
  if (sessionId) {
    try {
      const entry = storageRead<{ listenOn: string; windowId: string }>('kitty-sessions', sessionId);
      if (entry) {
        listenOn = listenOn || entry.listenOn || null;
        windowId = windowId || entry.windowId || null;
        if (listenOn && windowId) return { listenOn, windowId };
      }
    } catch { /* silent */ }
  }

  // Fallback: check default socket path used by kitty's listen_on config.
  // This prevents escape-sequence IPC when KITTY_LISTEN_ON isn't propagated
  // to subprocess contexts (the root cause of terminal garbage in #493).
  if (!listenOn) {
    const defaultSocket = `/tmp/kitty-${process.env.USER}`;
    try {
      if (existsSync(defaultSocket)) {
        listenOn = `unix:${defaultSocket}`;
      }
    } catch { /* silent */ }
  }

  // Log when kitty env lookup fails with a session ID (diagnostic for compaction issues)
  if (sessionId && !listenOn && !windowId) {
    console.error(`[tab-setter] getKittyEnv: no kitty env found for session ${sessionId.slice(0, 8)} (no env vars, no session entry, no default socket)`);
  }

  return { listenOn, windowId };
}

/**
 * Persist a session's Kitty environment for later hook lookups.
 * Called by StartupGreeting at session start.
 *
 * Each session gets its own file: kitty-sessions/{sessionId}.json
 * - No shared mutable state (concurrent session starts are safe)
 * - No unbounded growth (files cleaned up on session end)
 * - Simple atomic write (no read-modify-write cycle)
 *
 */
export function persistKittySession(sessionId: string, listenOn: string, windowId: string): void {
  try {
    storageWrite('kitty-sessions', sessionId, { listenOn, windowId });
  } catch { /* silent */ }
}

/**
 * Remove a session's persisted Kitty environment from SQLite.
 * Called by SessionSummary at session end.
 */
export function cleanupKittySession(sessionId: string): void {
  try {
    storageDelete('kitty-sessions', sessionId);
  } catch { /* silent */ }
}

interface SetTabOptions {
  title: string;
  state: TabState;
  previousTitle?: string;
  sessionId?: string;
}

/**
 * Clean up tab-title entries for kitty windows that no longer exist.
 * Runs opportunistically on each setTabState call (lightweight).
 */
function cleanupStaleStateEntries(): void {
  try {
    const keys = listKeys('tab-titles');
    if (keys.length === 0) return;

    // Get live window IDs from kitty via socket (prevents escape sequence leaks)
    const defaultSocket = `/tmp/kitty-${process.env.USER}`;
    const socketPath = process.env.KITTY_LISTEN_ON || (existsSync(defaultSocket) ? `unix:${defaultSocket}` : null);
    if (!socketPath) return; // No socket — skip cleanup to avoid escape sequence IPC
    const liveOutput = execSync(`kitten @ --to="${socketPath}" ls 2>/dev/null | jq -r ".[].tabs[].windows[].id" 2>/dev/null`, {
      encoding: 'utf-8', timeout: 2000,
    }).trim();
    if (!liveOutput) return;

    const liveIds = new Set(liveOutput.split('\n').map(id => id.trim()));

    for (const winId of keys) {
      if (!liveIds.has(winId)) {
        try { storageDelete('tab-titles', winId); } catch { /* silent */ }
      }
    }
  } catch { /* silent — cleanup is best-effort */ }
}

export function setTabState(opts: SetTabOptions): void {
  const { title, state, previousTitle, sessionId } = opts;
  const colors = TAB_COLORS[state];
  const kittyEnv = getKittyEnv(sessionId);

  try {
    // Need either TERM=xterm-kitty OR a valid KITTY_LISTEN_ON to proceed
    const isKitty = process.env.TERM === 'xterm-kitty' || kittyEnv.listenOn;
    if (!isKitty) return;

    // CRITICAL: Always use --to flag for socket-based remote control.
    // Without it, kitten @ falls back to escape-sequence IPC which leaks
    // garbage text (e.g. "P@kitty-cmd{...}") into terminal output when
    // running in subprocess contexts. See PR #493.
    if (!kittyEnv.listenOn) {
      console.error(`[tab-setter] No kitty socket available, skipping tab update to prevent escape sequence leaks`);
      return;
    }

    const escaped = title.replace(/"/g, '\\"');
    // Set BOTH tab title AND window title. Kitty's tab_title_template uses
    // {active_window.title} (the window title). OSC escape codes from Claude Code
    // reset set-tab-title overrides, so the template falls back to window title.
    // By setting both, our title survives OSC resets.
    const toFlag = `--to="${kittyEnv.listenOn}"`;
    console.error(`[tab-setter] Setting tab: "${escaped}" with toFlag: ${toFlag}`);
    execSync(`kitten @ ${toFlag} set-tab-title "${escaped}"`, { stdio: 'ignore', timeout: 2000 });
    execSync(`kitten @ ${toFlag} set-window-title "${escaped}"`, { stdio: 'ignore', timeout: 2000 });

    // For idle state, reset ALL colors to Kitty defaults (no lingering backgrounds)
    if (state === 'idle') {
      execSync(
        `kitten @ ${toFlag} set-tab-color --self active_bg=none active_fg=none inactive_bg=none inactive_fg=none`,
        { stdio: 'ignore', timeout: 2000 }
      );
    } else {
      execSync(
        `kitten @ ${toFlag} set-tab-color --self active_bg=${ACTIVE_TAB_BG} active_fg=${ACTIVE_TAB_FG} inactive_bg=${colors.inactiveBg} inactive_fg=${INACTIVE_TAB_FG}`,
        { stdio: 'ignore', timeout: 2000 }
      );
    }
    console.error(`[tab-setter] Tab commands completed successfully`);
  } catch (err) {
    console.error(`[tab-setter] Error setting tab:`, err);
  }

  // Persist per-window state (or clean up on idle/session end)
  const windowId = kittyEnv.windowId;
  if (!windowId) return;

  try {
    if (state === 'idle') {
      // Session ended — remove state entry so no stale data lingers
      storageDelete('tab-titles', windowId);
    } else {
      const stateData: Record<string, unknown> = {
        title,
        inactiveBg: colors.inactiveBg,
        state,
        timestamp: new Date().toISOString(),
      };
      if (previousTitle) stateData.previousTitle = previousTitle;
      storageWrite('tab-titles', windowId, stateData);
    }
  } catch { /* silent */ }

  // Opportunistic cleanup of stale entries for dead windows
  cleanupStaleStateEntries();
}

/**
 * Read per-window state file. Returns null if not found or invalid.
 */
export function readTabState(sessionId?: string): { title: string; state: TabState; previousTitle?: string; phase?: string } | null {
  const kittyEnv = getKittyEnv(sessionId);
  const windowId = kittyEnv.windowId;
  if (!windowId) return null;
  try {
    const raw = storageRead<Record<string, unknown>>('tab-titles', windowId);
    if (!raw) return null;
    return {
      title: (raw.title as string) || '',
      state: (raw.state as TabState) || 'idle',
      previousTitle: raw.previousTitle as string | undefined,
      phase: raw.phase as string | undefined,
    };
  } catch { return null; }
}

/**
 * Strip emoji prefix from a tab title to get raw text.
 * Handles both working-state prefixes (🧠⚙️✓❓) and Algorithm phase symbols (👁️📋🔨⚡✅📚).
 */
export function stripPrefix(title: string): string {
  return title.replace(/^(?:🧠|⚙️|⚙|✓|❓|👁️|📋|🔨|⚡|✅|📚)\s*/, '').trim();
}

// Noise words to skip when extracting the session label
const SESSION_NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'of', 'with',
  'my', 'our', 'new', 'old', 'fix', 'add', 'update', 'set', 'get',
]);

/**
 * Extract two representative words from a session name.
 * "Tab Title Upgrade" → "TAB TITLE", "Security Redesign" → "SECURITY REDESIGN"
 * "Fix Activity Dashboard" → "ACTIVITY DASHBOARD"
 * Returns uppercase. Falls back to first two words if all are noise.
 */
export function getSessionOneWord(sessionId: string): string | null {
  try {
    const names = storageRead<Record<string, string>>('session-names', 'map');
    if (!names) return null;
    const fullName = names[sessionId];
    if (!fullName) return null;

    const words = fullName.split(/\s+/).filter((w: string) => w.length > 0);
    if (words.length === 0) return null;

    // Collect up to 2 non-noise words
    const meaningful = words.filter((w: string) => !SESSION_NOISE.has(w.toLowerCase()));
    if (meaningful.length >= 2) {
      return `${meaningful[0]} ${meaningful[1]}`.toUpperCase();
    } else if (meaningful.length === 1) {
      // One meaningful word — grab the next word (even if noise) for context
      const idx = words.indexOf(meaningful[0]);
      const next = words[idx + 1];
      if (next) return `${meaningful[0]} ${next}`.toUpperCase();
      return meaningful[0].toUpperCase();
    }
    // All noise — take first two
    return words.slice(0, 2).join(' ').toUpperCase();
  } catch {
    return null;
  }
}

/**
 * Set tab title and color for an Algorithm phase.
 * Active format:    {SYMBOL} {ONE_WORD} | {PHASE}
 * Complete format:  {ONE_WORD} | {summary}
 *
 * Called by AlgorithmTracker on phase transitions.
 */
export function setPhaseTab(phase: AlgorithmTabPhase, sessionId: string, summary?: string): void {
  const config = PHASE_TAB_CONFIG[phase];
  if (!config) return;

  const oneWord = getSessionOneWord(sessionId) || 'WORKING';
  const kittyEnv = getKittyEnv(sessionId);

  // Build title based on phase
  let title: string;
  if (phase === 'COMPLETE' && summary) {
    title = `✅ ${summary}`;
  } else if (phase === 'COMPLETE') {
    // No summary extracted — use session name instead of generic "Done."
    title = `✅ ${oneWord}`;
  } else if (phase === 'IDLE') {
    title = oneWord;
  } else {
    // Preserve existing working description from UpdateTabTitle if available.
    // Only swap the emoji prefix to show current phase — keep the real task context.
    let existingDesc = '';
    const currentState = readTabState(sessionId);
    if (currentState?.title) {
      const pipeIdx = currentState.title.indexOf('|');
      if (pipeIdx !== -1) existingDesc = currentState.title.slice(pipeIdx + 1).trim();
    }
    const desc = existingDesc || config.gerund;
    title = `${config.symbol} ${oneWord} | ${desc}`;
  }

  try {
    const isKitty = process.env.TERM === 'xterm-kitty' || kittyEnv.listenOn;
    if (!isKitty) return;

    // CRITICAL: Require socket for remote control. See PR #493.
    if (!kittyEnv.listenOn) {
      console.error(`[tab-setter] No kitty socket available, skipping phase tab update`);
      return;
    }

    const escaped = title.replace(/"/g, '\\"');
    const toFlag = `--to="${kittyEnv.listenOn}"`;

    execSync(`kitten @ ${toFlag} set-tab-title "${escaped}"`, { stdio: 'ignore', timeout: 2000 });
    execSync(`kitten @ ${toFlag} set-window-title "${escaped}"`, { stdio: 'ignore', timeout: 2000 });

    if (phase === 'IDLE') {
      execSync(
        `kitten @ ${toFlag} set-tab-color --self active_bg=none active_fg=none inactive_bg=none inactive_fg=none`,
        { stdio: 'ignore', timeout: 2000 }
      );
    } else {
      execSync(
        `kitten @ ${toFlag} set-tab-color --self active_bg=${ACTIVE_TAB_BG} active_fg=${ACTIVE_TAB_FG} inactive_bg=${config.inactiveBg} inactive_fg=${INACTIVE_TAB_FG}`,
        { stdio: 'ignore', timeout: 2000 }
      );
    }
    console.error(`[tab-setter] Phase tab: "${escaped}" (${phase}, bg=${config.inactiveBg})`);
  } catch (err) {
    console.error(`[tab-setter] Error setting phase tab:`, err);
  }

  // Persist per-window state to SQLite
  const windowId = kittyEnv.windowId;
  if (!windowId) return;

  try {
    storageWrite('tab-titles', windowId, {
      title,
      inactiveBg: config.inactiveBg,
      state: phase === 'COMPLETE' ? 'completed' : 'working',
      phase,
      timestamp: new Date().toISOString(),
    });
  } catch { /* silent */ }
}
