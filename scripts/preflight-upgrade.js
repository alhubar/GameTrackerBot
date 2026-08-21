/**
 * Deploy preflight: answers "what happens the first time this version meets an existing database?"
 *
 *   node scripts/preflight-upgrade.js --db path/to/tracker.sqlite            (report only)
 *   node scripts/preflight-upgrade.js --db path/to/tracker.sqlite --apply    (seed them silently)
 *
 * Members who have been playing since before achievements existed have already earned a pile of
 * them, and the bot would announce every one the first time it sees each of them play — dozens of
 * embeds in a burst. This measures that, and can pre-empt it.
 *
 * The measurement always runs against a throwaway COPY, so a plain run never writes to the real
 * database. It applies the current schema migration to that copy and replays the real evaluators —
 * the same ones index.js calls — to find every achievement that would unlock.
 *
 * With --apply, the exact set found is then written into the real database as already-unlocked,
 * after taking a timestamped backup. Members keep the credit for their history, and because the
 * rows are already there the bot has nothing left to announce. Run it once, with the bot stopped,
 * before starting the new version.
 *
 * Thresholds come from the .env in this folder, so run it with the same .env the target host uses
 * or the numbers will not match. The values actually used are printed up front.
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { openDatabase } from '../src/database.js';
import { achievementById, evaluateSessionStart, evaluateTouchGrass } from '../src/achievements.js';
import { evaluateServerAchievements } from '../src/serverAchievements.js';
import { RANKS, RANK_HOURS } from '../src/ranks.js';

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const sourcePath = dbFlag !== -1 ? args[dbFlag + 1] : 'data/tracker.sqlite';
const apply = args.includes('--apply');

if (!existsSync(sourcePath)) {
  console.error(`No database at ${sourcePath}. Pass --db <path>.`);
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'tracker-preflight-'));
const copyPath = join(workDir, basename(sourcePath));
copyFileSync(sourcePath, copyPath);
// A live bot leaves recent commits in the write-ahead log; copy those too or the snapshot is stale.
for (const suffix of ['-wal', '-shm']) {
  if (existsSync(sourcePath + suffix)) copyFileSync(sourcePath + suffix, copyPath + suffix);
}

const line = (char = '─') => console.log(char.repeat(72));
const tableNames = (handle) =>
  handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((row) => row.name).sort();

try {
  console.log(`\nPreflight for ${sourcePath}`);
  console.log(`Working on a copy at ${copyPath} — the original is only ever read.\n`);
  line('═');
  console.log('CONFIGURATION IN USE');
  line();
  console.log(`Ranks           ${RANKS.length} tiers at ${RANK_HOURS.join(', ')} hours`);
  for (const [key, value] of Object.entries(process.env).filter(([key]) => key.startsWith('SERVER_')).sort()) {
    console.log(`${key.padEnd(34)} ${value}`);
  }

  // ---- Schema migration -------------------------------------------------------------------
  const before = new Database(copyPath);
  const tablesBefore = tableNames(before);
  const countsBefore = Object.fromEntries(
    tablesBefore.map((name) => [name, before.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]),
  );
  before.close();

  const db = openDatabase(copyPath);

  const raw = new Database(copyPath);
  const tablesAfter = tableNames(raw);
  const countsAfter = Object.fromEntries(
    tablesAfter.map((name) => [name, raw.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]),
  );

  console.log('');
  line('═');
  console.log('SCHEMA MIGRATION');
  line();
  const added = tablesAfter.filter((name) => !tablesBefore.includes(name));
  const removed = tablesBefore.filter((name) => !tablesAfter.includes(name));
  console.log(`Tables added:   ${added.length ? added.join(', ') : 'none'}`);
  console.log(`Tables removed: ${removed.length ? removed.join(', ') : 'none'}`);
  let dataLoss = false;
  for (const name of tablesBefore) {
    const from = countsBefore[name];
    const to = countsAfter[name] ?? 0;
    if (from !== to) {
      dataLoss = true;
      console.log(`  ! ${name}: ${from} rows -> ${to} rows`);
    }
  }
  console.log(dataLoss ? '  ! existing row counts changed' : 'Existing tables: all row counts unchanged.');
  for (const name of tablesBefore) console.log(`  ${name.padEnd(30)} ${countsAfter[name]} rows`);

  // ---- Retroactive unlocks ----------------------------------------------------------------
  // Each member is simulated starting their most-played game, one at a time, then stopped again,
  // so nobody is left artificially "playing alongside" anyone else. Co-op tiers therefore do not
  // appear here; they need genuinely concurrent play and will unlock naturally afterwards.
  const now = Date.now();
  const guilds = raw.prepare('SELECT DISTINCT guild_id FROM member_stats').all().map((row) => row.guild_id);
  let totalMessages = 0;
  const seedPersonal = [];
  const seedServer = [];

  for (const guildId of guilds) {
    console.log('');
    line('═');
    console.log(`GUILD ${guildId}`);
    line();

    const members = raw.prepare('SELECT user_id, total_seconds FROM member_stats WHERE guild_id = ? ORDER BY total_seconds DESC')
      .all(guildId);
    const perMember = [];
    const unpredictable = [];

    for (const { user_id: userId, total_seconds: totalSeconds } of members) {
      const topGame = raw.prepare(
        'SELECT game_name FROM game_stats WHERE guild_id = ? AND user_id = ? ORDER BY total_seconds DESC LIMIT 1',
      ).get(guildId, userId)?.game_name;
      // Members carrying playtime from before per-game recording existed have nothing to simulate
      // from — which game they open next is unknowable, so report them rather than skip silently.
      if (!topGame) {
        if (totalSeconds > 0) unpredictable.push({ userId, totalSeconds });
        continue;
      }

      const { previous } = db.startSession(guildId, userId, topGame, now);
      const unlocked = evaluateSessionStart(db, guildId, userId, topGame, now, previous);
      // Stop again before moving on, so members are never left looking concurrently active and
      // the co-op tiers don't fire off a lineup that never actually happened.
      db.stopSession(guildId, userId, now);
      if (unlocked.length) perMember.push({ userId, topGame, unlocked });
    }

    const grass = evaluateTouchGrass(db, guildId, now);
    for (const { userId, unlocked } of grass) {
      const existing = perMember.find((entry) => entry.userId === userId);
      if (existing) existing.unlocked.push(...unlocked);
      else perMember.push({ userId, topGame: '(inactive)', unlocked });
    }

    console.log(`Members with history: ${members.length}`);
    console.log('');
    console.log('PERSONAL ACHIEVEMENTS that would unlock on each member\'s next session:');
    if (!perMember.length) {
      console.log('  none');
    }
    for (const { userId, unlocked } of perMember.sort((a, b) => b.unlocked.length - a.unlocked.length)) {
      totalMessages += unlocked.length;
      console.log(`  ${userId}  ->  ${unlocked.length} message${unlocked.length === 1 ? '' : 's'} at once`);
      for (const id of unlocked) {
        const achievement = achievementById(id);
        console.log(`       ${achievement ? `${achievement.emoji} ${achievement.name}` : id}`);
        seedPersonal.push({ guildId, userId, achievementId: id });
      }
    }

    if (unpredictable.length) {
      console.log('');
      console.log('NOT PREDICTABLE — playtime on record but no per-game history to simulate from:');
      for (const { userId, totalSeconds } of unpredictable) {
        console.log(`  ${userId}  (${(totalSeconds / 3600).toFixed(2)}h, 0 recorded sessions)`);
      }
      console.log('  Their next session is whatever they happen to open, so it cannot be simulated.');
      console.log('  Most likely nothing: their history is a bare total with no games, days or');
      console.log('  sessions behind it, so there is little for the rules to award against.');
    }

    const { unlocked: serverUnlocked, metrics } = evaluateServerAchievements(db, guildId, now);
    totalMessages += serverUnlocked.length;
    for (const tier of serverUnlocked) seedServer.push({ guildId, achievementId: tier.id });
    console.log('');
    console.log('SERVER ACHIEVEMENTS that would unlock immediately:');
    if (!serverUnlocked.length) console.log('  none');
    for (const tier of serverUnlocked) console.log(`  ${tier.emoji} ${tier.name}`);
    console.log('');
    console.log(`Server snapshot: ${metrics.trackedPlayers} players, ${metrics.gamesTracked} games, `
      + `${Math.round(metrics.totalHours)}h total`);
  }

  console.log('');
  line('═');
  console.log('BOTTOM LINE');
  line();
  console.log(`${totalMessages} embed${totalMessages === 1 ? '' : 's'} would be posted to ACHIEVEMENT_CHANNEL.`);
  console.log('Server-wide ones land as soon as anyone is seen playing; personal ones land per member,');
  console.log('all at once, the first time that member is seen playing.');
  db.close?.();
  raw.close();

  // ---- Optional silent seed ----------------------------------------------------------------
  if (!apply) {
    console.log('');
    console.log('This was a dry run — nothing was written. Re-run with --apply to record all of the');
    console.log('above as already-unlocked, so members keep the credit but nothing gets announced.');
    console.log('');
  } else {
    console.log('');
    line('═');
    console.log('APPLYING');
    line();
    const backupPath = `${sourcePath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(sourcePath, backupPath);
    console.log(`Backup written to ${backupPath}`);

    // openDatabase runs the schema migration, which the seed rows need in order to have somewhere
    // to go — the old release has no achievement tables at all.
    const target = openDatabase(sourcePath);
    let personalWritten = 0;
    let serverWritten = 0;
    for (const { guildId, userId, achievementId } of seedPersonal) {
      if (target.unlockAchievement(guildId, userId, achievementId, now)) personalWritten++;
    }
    for (const { guildId, achievementId } of seedServer) {
      if (target.unlockServerAchievement(guildId, achievementId, now)) serverWritten++;
    }
    target.close?.();
    console.log(`Seeded ${personalWritten} personal and ${serverWritten} server achievements as already-unlocked.`);
    console.log('Start the bot normally — these will not be announced, anything new still will.');
    console.log('');
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
