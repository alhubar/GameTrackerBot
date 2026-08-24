import { openDatabase } from '../src/database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Opens a throwaway database in a fresh temp directory.
 * Returns the db handle plus a cleanup() that closes it and removes the files.
 */
export function tempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A fixed, timezone-safe reference point so tests never depend on the clock. */
export const T0 = Date.parse('2026-06-15T12:00:00Z');

/** Records a completed session of a given length, returning the end timestamp. */
export function playSession(db, guildId, userId, gameName, startAt, durationMs) {
  db.startSession(guildId, userId, gameName, startAt);
  const endAt = startAt + durationMs;
  db.stopSession(guildId, userId, endAt);
  return endAt;
}
