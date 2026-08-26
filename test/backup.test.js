import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupFileName, isBackupDue, listBackups, rotateBackups, runBackup } from '../src/backup.js';
import { tempDatabase, DAY, HOUR, T0 } from './helpers.js';

const withDir = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-backup-'));
  try { body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const seed = (dir, ...names) => {
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), '');
};

test('names backups by UTC day', () => {
  assert.equal(backupFileName(T0), 'tracker-2026-06-15.sqlite');
});

test('lists only backup files, newest first', () => {
  withDir((dir) => {
    seed(dir, 'tracker-2026-06-13.sqlite', 'tracker-2026-06-15.sqlite', 'tracker-2026-06-14.sqlite',
      'notes.txt', 'tracker-2026-06-15.sqlite.partial');
    assert.deepEqual(listBackups(dir), [
      'tracker-2026-06-15.sqlite', 'tracker-2026-06-14.sqlite', 'tracker-2026-06-13.sqlite',
    ]);
  });
});

test('a missing directory is no backups rather than an error', () => {
  assert.deepEqual(listBackups(join(tmpdir(), 'tracker-backup-does-not-exist')), []);
});

test('not due before the configured hour', () => {
  withDir((dir) => {
    const threeAm = Date.parse('2026-06-15T03:00:00Z');
    assert.equal(isBackupDue(dir, threeAm, 4), false);
    assert.equal(isBackupDue(dir, threeAm + HOUR, 4), true);
  });
});

test('not due again once the day already has a copy', () => {
  withDir((dir) => {
    seed(dir, 'tracker-2026-06-15.sqlite');
    assert.equal(isBackupDue(dir, T0, 4), false);
    // A restart the following day still takes that day's copy.
    assert.equal(isBackupDue(dir, T0 + DAY, 4), true);
  });
});

test('downtime past the hour takes the copy on the next check rather than skipping the day', () => {
  withDir((dir) => {
    seed(dir, 'tracker-2026-06-14.sqlite');
    assert.equal(isBackupDue(dir, Date.parse('2026-06-15T23:00:00Z'), 4), true);
  });
});

test('rotation keeps the newest and reports what it removed', () => {
  withDir((dir) => {
    seed(dir, 'tracker-2026-06-12.sqlite', 'tracker-2026-06-13.sqlite',
      'tracker-2026-06-14.sqlite', 'tracker-2026-06-15.sqlite');
    assert.deepEqual(rotateBackups(dir, 2), ['tracker-2026-06-13.sqlite', 'tracker-2026-06-12.sqlite']);
    assert.deepEqual(listBackups(dir), ['tracker-2026-06-15.sqlite', 'tracker-2026-06-14.sqlite']);
  });
});

test('rotation leaves a series shorter than the limit alone', () => {
  withDir((dir) => {
    seed(dir, 'tracker-2026-06-15.sqlite');
    assert.deepEqual(rotateBackups(dir, 7), []);
    assert.deepEqual(listBackups(dir), ['tracker-2026-06-15.sqlite']);
  });
});

test('the backup is a readable database holding the data at the time it was taken', async () => {
  const { db, cleanup } = tempDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'tracker-backup-'));
  try {
    db.startSession('g1', 'u1', 'Some Game', T0);
    db.stopSession('g1', 'u1', T0 + HOUR);

    const { path, removed } = await runBackup(db, dir, T0, 7);
    assert.equal(path, join(dir, 'tracker-2026-06-15.sqlite'));
    assert.deepEqual(removed, []);
    assert.equal(existsSync(path + '.partial'), false);

    const copy = new Database(path, { readonly: true });
    assert.equal(copy.prepare('SELECT total_seconds FROM member_stats WHERE user_id = ?').get('u1').total_seconds, 3600);
    copy.close();
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second backup on the same day replaces it rather than starting a new series', async () => {
  const { db, cleanup } = tempDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'tracker-backup-'));
  try {
    await runBackup(db, dir, T0, 7);
    db.startSession('g1', 'u1', 'Some Game', T0);
    db.stopSession('g1', 'u1', T0 + HOUR);
    await runBackup(db, dir, T0 + HOUR, 7);

    assert.deepEqual(listBackups(dir), ['tracker-2026-06-15.sqlite']);
    const copy = new Database(join(dir, 'tracker-2026-06-15.sqlite'), { readonly: true });
    assert.equal(copy.prepare('SELECT total_seconds FROM member_stats WHERE user_id = ?').get('u1').total_seconds, 3600);
    copy.close();
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed backup leaves no partial file behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-backup-'));
  try {
    const failing = { backup: () => Promise.reject(new Error('disk full')) };
    await assert.rejects(() => runBackup(failing, dir, T0, 7), /disk full/);
    assert.deepEqual(listBackups(dir), []);
    assert.equal(existsSync(join(dir, 'tracker-2026-06-15.sqlite.partial')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
