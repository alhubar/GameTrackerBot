import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nightly rotated copies of the database.
 *
 * There is deliberately no stored "last backup" timestamp. Whether tonight's copy has been taken is
 * derived from the filenames already on disk, so a restart cannot lose that state and cause either a
 * skipped night or a second copy — the files are the record.
 *
 * The copy itself goes through `db.backup()` (SQLite's online backup API), not a file copy of the
 * .sqlite/-wal/-shm trio: the bot keeps writing throughout, and a plain copy can catch the
 * checkpoint loop mid-commit and produce a snapshot that is internally inconsistent.
 */

const PREFIX = 'tracker-';
const SUFFIX = '.sqlite';
// A copy in progress is written under this extension and renamed into place only once it completes,
// so a crash mid-backup cannot leave a truncated file sitting where a good one used to be.
const PARTIAL_SUFFIX = '.partial';
const NAME_PATTERN = /^tracker-\d{4}-\d{2}-\d{2}\.sqlite$/;

/** UTC, so the stamp matches the UTC schedule and sorts lexicographically by age. */
export const backupDay = (now) => new Date(now).toISOString().slice(0, 10);

export const backupFileName = (now) => `${PREFIX}${backupDay(now)}${SUFFIX}`;

/** Existing backups, newest first. A missing directory is simply "no backups yet". */
export function listBackups(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.filter((name) => NAME_PATTERN.test(name)).sort().reverse();
}

/**
 * Due once the configured hour has arrived on a day with no copy yet. After downtime spanning the
 * hour, the copy is taken at the next tick rather than being treated as missed.
 */
export function isBackupDue(dir, now, hourUtc) {
  if (new Date(now).getUTCHours() < hourUtc) return false;
  return !listBackups(dir).includes(backupFileName(now));
}

/** Trims to the newest `keep` copies. Returns the names removed. */
export function rotateBackups(dir, keep) {
  const removed = listBackups(dir).slice(keep);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}

export async function runBackup(db, dir, now, keep) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, backupFileName(now));
  const partial = path + PARTIAL_SUFFIX;
  try {
    await db.backup(partial);
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return { path, removed: rotateBackups(dir, keep) };
}
