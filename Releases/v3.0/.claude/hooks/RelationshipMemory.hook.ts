#!/usr/bin/env bun
/**
 * RelationshipMemory.hook.ts - Extract relationship notes from sessions
 *
 * PURPOSE:
 * Analyzes session transcripts to extract relationship-relevant learnings
 * and appends them to the daily relationship log. This builds the memory
 * that makes our relationship feel like it's growing.
 *
 * TRIGGER: Stop (session end)
 *
 * INPUT:
 * - session_id: Current session identifier
 * - transcript_path: Path to conversation transcript
 *
 * OUTPUT:
 * - Writes to: MEMORY/RELATIONSHIP/YYYY-MM/YYYY-MM-DD.md
 * - May update: skills/PAI/USER/ABOUT_USER.md (significant learnings)
 *
 * RELATIONSHIP NOTE TYPES:
 * - W (World): Objective facts about {PRINCIPAL.NAME}'s situation
 * - B (Biographical): What happened this session (first-person DA)
 * - O (Opinion): Preference/belief with confidence
 *
 * EXAMPLES:
 * - W @Principal: Currently focused on PAI infrastructure improvements
 * - B @DA: Successfully debugged voice notifications after 5 attempts
 * - O(c=0.85) @Principal: Appreciates when I admit mistakes early
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getPaiDir } from './lib/paths';
import { getISOTimestamp, getPSTComponents } from './lib/time';
import { getDAName, getPrincipalName } from './lib/identity';
import { appendLog } from './lib/storage';

interface HookInput {
  session_id: string;
  transcript_path?: string;
}

interface RelationshipNote {
  type: 'W' | 'B' | 'O';
  entities: string[];
  content: string;
  confidence?: number;
}

interface TranscriptEntry {
  type: 'user' | 'assistant';
  message?: {
    content: string | Array<{ type: string; text?: string }>;
  };
}

/**
 * Read stdin with timeout
 */
async function readStdinWithTimeout(timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    process.stdin.on('data', (chunk) => { data += chunk.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Extract text content from transcript entry
 */
function extractText(entry: TranscriptEntry): string {
  if (!entry.message?.content) return '';

  if (typeof entry.message.content === 'string') {
    return entry.message.content;
  }

  if (Array.isArray(entry.message.content)) {
    return entry.message.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join(' ');
  }

  return '';
}

/**
 * Read and parse transcript
 */
function readTranscript(path: string): TranscriptEntry[] {
  if (!path || !existsSync(path)) return [];

  try {
    const content = readFileSync(path, 'utf-8');
    const entries: TranscriptEntry[] = [];

    for (const line of content.trim().split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' || entry.type === 'assistant') {
          entries.push(entry);
        }
      } catch {
        // Skip invalid lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Analyze transcript for relationship-relevant content
 */
function analyzeForRelationship(entries: TranscriptEntry[]): RelationshipNote[] {
  const notes: RelationshipNote[] = [];

  // Patterns that indicate relationship-relevant content
  const patterns = {
    preference: /(?:prefer|like|want|appreciate|enjoy|love|hate|dislike)\s+(?:when|that|to)/i,
    frustration: /(?:frustrat|annoy|bother|irritat)/i,
    positive: /(?:great|awesome|perfect|excellent|good job|well done|nice)/i,
    learning: /(?:learn|discover|realize|understand|figure out)/i,
    milestone: /(?:first time|finally|breakthrough|success|accomplish)/i,
  };

  // Track what happened this session
  let sessionSummary: string[] = [];
  let userPreferences: string[] = [];
  let frustrations: string[] = [];
  let positives: string[] = [];

  for (const entry of entries) {
    const text = extractText(entry);
    if (!text || text.length < 10) continue;

    // User messages might reveal preferences
    if (entry.type === 'user') {
      if (patterns.preference.test(text)) {
        // Extract preference (simplified - would benefit from LLM analysis)
        const snippet = text.slice(0, 200);
        userPreferences.push(snippet);
      }

      if (patterns.frustration.test(text)) {
        frustrations.push(text.slice(0, 150));
      }

      if (patterns.positive.test(text)) {
        positives.push(text.slice(0, 150));
      }
    }

    // Assistant messages with SUMMARY tags indicate completed work
    if (entry.type === 'assistant') {
      const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
      if (summaryMatch) {
        sessionSummary.push(summaryMatch[1].trim());
      }

      // Check for milestones
      if (patterns.milestone.test(text)) {
        const snippet = text.match(/[^.]*(?:first time|finally|breakthrough|success)[^.]*/i)?.[0];
        if (snippet) {
          sessionSummary.push(snippet.trim());
        }
      }
    }
  }

  // Generate relationship notes from analysis

  // B (Biographical) - What the DA did this session
  if (sessionSummary.length > 0) {
    const uniqueSummaries = [...new Set(sessionSummary)].slice(0, 3);
    for (const summary of uniqueSummaries) {
      notes.push({
        type: 'B',
        entities: [`@${getDAName()}`],
        content: summary
      });
    }
  }

  // O (Opinion) - Inferred preferences
  if (positives.length >= 2) {
    notes.push({
      type: 'O',
      entities: [`@${getPrincipalName()}`],
      content: 'Responded positively to this session\'s approach',
      confidence: 0.70
    });
  }

  if (frustrations.length >= 2) {
    notes.push({
      type: 'O',
      entities: [`@${getPrincipalName()}`],
      content: 'Experienced frustration during this session (likely tooling-related)',
      confidence: 0.75
    });
  }

  return notes;
}

/**
 * Format a single note for storage
 */
function formatNote(note: RelationshipNote): string {
  const entities = note.entities.join(' ');
  const confidence = note.confidence ? `(c=${note.confidence.toFixed(2)})` : '';
  return `${note.type}${confidence} ${entities}: ${note.content}`;
}

async function main() {
  try {
    console.error('[RelationshipMemory] Hook started');

    const input = await readStdinWithTimeout();
    const data: HookInput = JSON.parse(input);

    if (!data.transcript_path) {
      console.error('[RelationshipMemory] No transcript path, exiting');
      process.exit(0);
    }

    // Read and analyze transcript
    const entries = readTranscript(data.transcript_path);
    if (entries.length === 0) {
      console.error('[RelationshipMemory] No transcript entries, exiting');
      process.exit(0);
    }

    console.error(`[RelationshipMemory] Analyzing ${entries.length} transcript entries`);

    const notes = analyzeForRelationship(entries);
    if (notes.length === 0) {
      console.error('[RelationshipMemory] No relationship notes to capture');
      process.exit(0);
    }

    // Write relationship notes to SQLite log
    const { year, month, day, hours, minutes } = getPSTComponents();
    const date = `${year}-${month}-${day}`;

    for (const note of notes) {
      appendLog('relationship', {
        date,
        time: `${hours}:${minutes}`,
        type: note.type,
        entities: note.entities,
        content: note.content,
        confidence: note.confidence,
        formatted: formatNote(note),
      });
    }

    console.error(`[RelationshipMemory] Captured ${notes.length} notes to SQLite`);
    process.exit(0);

  } catch (err) {
    console.error(`[RelationshipMemory] Error: ${err}`);
    process.exit(0); // Don't fail the session end
  }
}

main();
