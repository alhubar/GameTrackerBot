/**
 * Read-only integrity report for a tracker database.
 *
 *   node scripts/db-check.js                              (checks data/tracker.sqlite)
 *   node scripts/db-check.js --db path/to/tracker.sqlite
 *   node scripts/db-check.js --db ... --verbose            (list every offending row)
 *
 * Opens the file `{ readonly: true }` and never writes, so it is safe to point at a live database
 * with the bot running. It answers "is anything in here impossible?", not "make it right" — there
 * is deliberately no repair or rebuild mode, for a reason worth stating plainly:
 *
 *   `member_stats` is NOT derivable from `play_sessions`.
 *
 * `play_sessions` and `game_stats` were added to a schema that already had `member_stats`, and
 * `CREATE TABLE IF NOT EXISTS` creates them empty on an existing database. Every hour banked before
 * that migration lives in `member_stats` alone. On a real database that gap can be most of the
 * server's history, so a "rebuild aggregates from sessions" command would silently delete it and
 * demote members whose rank depends on those hours. This script therefore REPORTS the gap and
 * explains it, and leaves the numbers alone.
 *
 * Exit code is 1 if any ERROR was found, 0 otherwise (warnings and notes do not fail the run), so
 * it can be dropped into a cron job or CI step.
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { ACHIEVEMENTS } from '../src/achievements.js';
import { SERVER_ACHIEVEMENTS } from '../src/serverAchievements.js';
import { RANKS } from '../src/ranks.js';

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const sourcePath = dbFlag !== -1 ? args[dbFlag + 1] : (process.env.DATABASE_PATH?.trim() || 'data/tracker.sqlite');
const verbose = args.includes('--verbose');

if (!existsSync(sourcePath)) {
  console.error(`No database at ${sourcePath}. Pass --db <path>.`);
  process.exit(1);
}

const db = new Database(sourcePath, { readonly: true });
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));

let errors = 0;
let warnings = 0;

const HOUR = 3600;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hours = (seconds) => `${(seconds / HOUR).toFixed(1)}h`;

function report(level, label, detail, rows = []) {
  const icon = { ERROR: '✗', WARN: '!', OK: '✓', NOTE: 'i' }[level];
  console.log(`${icon} ${label}${detail ? ` — ${detail}` : ''}`);
  if (level === 'ERROR') errors += 1;
  if (level === 'WARN') warnings += 1;
  if (verbose && rows.length) {
    for (const row of rows.slice(0, 20)) console.log(`    ${JSON.stringify(row)}`);
    if (rows.length > 20) console.log(`    … and ${rows.length - 20} more`);
  }
}

const columnCache = new Map();
/** Columns of a table, or an empty set if the table itself is absent. */
function columnsOf(table) {
  if (!columnCache.has(table)) {
    columnCache.set(table, tables.has(table)
      ? new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
      : new Set());
  }
  return columnCache.get(table);
}

/**
 * Runs a query only if everything it touches exists. Requirements are `'table'` or
 * `'table.column'`, because features arrived here two ways: whole tables via CREATE TABLE IF NOT
 * EXISTS, and individual columns via ALTER TABLE. A database old enough to be missing either is a
 * normal thing to point this script at, so a gap is a skipped check, never a crash.
 */
function check(label, needs, sql, onRows) {
  const missing = needs.filter((need) => {
    const [table, column] = need.split('.');
    return column ? !columnsOf(table).has(column) : !tables.has(table);
  });
  if (missing.length) {
    report('NOTE', label, `skipped, this database has no ${missing.join(' / ')}`);
    return;
  }
  const rows = db.prepare(sql).all();
  onRows(rows, label);
}

const expectFalsy = (level, ok, bad) => (rows, label) =>
  (rows.length ? report(level, label, bad(rows), rows) : report('OK', label, ok));

console.log(`\nGame Tracker database check\n${sourcePath}\n${'─'.repeat(60)}\n`);
console.log(`Tables present: ${[...tables].filter((t) => t !== 'sqlite_sequence').sort().join(', ')}\n`);

console.log('Completed sessions');
check('negative or zero session durations', ['play_sessions'],
  'SELECT id, guild_id, user_id, game_name, duration_seconds FROM play_sessions WHERE duration_seconds < 0',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'session')));

check('sessions that end before they start', ['play_sessions'],
  'SELECT id, guild_id, user_id, game_name, started_at, ended_at FROM play_sessions WHERE ended_at < started_at',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'session')));

check('durations longer than their own wall-clock span', ['play_sessions'],
  // Idle time is subtracted from duration, so duration must never EXCEED the span. One second of
  // slack absorbs integer-division rounding at the second boundary.
  'SELECT id, guild_id, user_id, game_name, started_at, ended_at, duration_seconds FROM play_sessions '
  + 'WHERE duration_seconds > ((ended_at - started_at) / 1000) + 1',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'session')));

check('sessions with no game name', ['play_sessions'],
  "SELECT id, guild_id, user_id FROM play_sessions WHERE game_name IS NULL OR TRIM(game_name) = ''",
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'session')));

console.log('\nActive sessions');
check('active sessions with a checkpoint before their start', ['active_sessions.last_checkpoint_at'],
  'SELECT guild_id, user_id, game_name, started_at, last_checkpoint_at FROM active_sessions '
  + 'WHERE last_checkpoint_at IS NOT NULL AND last_checkpoint_at < started_at',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'session')));

check('active sessions older than 24h', ['active_sessions'],
  // MAX_SESSION_HOURS should have retired these. Survivors mean the cap is off, or the bot has
  // been down long enough that recoverStaleSessions has not run yet.
  `SELECT guild_id, user_id, game_name, started_at FROM active_sessions WHERE started_at < ${Date.now() - 24 * 60 * 60 * 1000}`,
  expectFalsy('WARN', 'none', (r) => `${plural(r.length, 'session')} — check MAX_SESSION_HOURS, or the bot is mid-recovery`));

check('active sessions paused in the future', ['active_sessions.paused_at'],
  `SELECT guild_id, user_id, game_name, paused_at FROM active_sessions WHERE paused_at > ${Date.now() + 60_000}`,
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'session')));

check('negative accumulated pause time', ['active_sessions.paused_seconds'],
  'SELECT guild_id, user_id, game_name, paused_seconds FROM active_sessions WHERE paused_seconds < 0',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'session')));

console.log('\nAggregates');
check('negative member totals', ['member_stats'],
  'SELECT guild_id, user_id, total_seconds FROM member_stats WHERE total_seconds < 0',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'member')));

check('negative game totals', ['game_stats'],
  'SELECT guild_id, user_id, game_name, total_seconds FROM game_stats WHERE total_seconds < 0',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'row')));

check('game totals exceeding the member total that contains them', ['game_stats', 'member_stats'],
  // Per-game seconds are a partition of the member's banked seconds, so their sum cannot be larger.
  // A small overshoot is normal mid-session (game_stats is credited at each checkpoint alongside
  // member_stats), so only a meaningful gap is worth flagging.
  'SELECT g.guild_id, g.user_id, SUM(g.total_seconds) AS game_total, m.total_seconds AS member_total '
  + 'FROM game_stats g JOIN member_stats m ON m.guild_id = g.guild_id AND m.user_id = g.user_id '
  + `GROUP BY g.guild_id, g.user_id HAVING SUM(g.total_seconds) > m.total_seconds + ${HOUR}`,
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'member')));

// The expected, benign divergence — reported as a note with its explanation attached.
if (tables.has('member_stats') && tables.has('play_sessions')) {
  const banked = db.prepare('SELECT COALESCE(SUM(total_seconds), 0) AS s FROM member_stats').get().s;
  const derived = db.prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM play_sessions').get().s;
  const gap = banked - derived;
  if (gap > HOUR) {
    const pct = banked ? Math.round((gap / banked) * 100) : 0;
    report('NOTE', 'history predating play_sessions',
      `${hours(gap)} of ${hours(banked)} (${pct}%) exists only in member_stats`);
    console.log('    This is expected, not corruption: play_sessions was added to an existing schema');
    console.log('    and started empty. Those hours cannot be reconstructed from session rows, which');
    console.log('    is why this tool has no rebuild mode — a rebuild would delete them.');
  } else {
    report('OK', 'aggregates and session history agree', `within ${hours(Math.max(0, gap))}`);
  }
}

console.log('\nReferences');
const knownAchievements = new Set(ACHIEVEMENTS.map((a) => a.id));
check('unlocked achievements that no longer exist', ['achievements_unlocked'],
  'SELECT DISTINCT achievement_id FROM achievements_unlocked',
  (rows, label) => {
    const unknown = rows.filter((r) => !knownAchievements.has(r.achievement_id));
    if (unknown.length) {
      report('WARN', label, `${unknown.map((r) => r.achievement_id).join(', ')} — renamed or removed; members keep the row but it renders as nothing`, unknown);
    } else {
      report('OK', label, `all ${rows.length} referenced ids are defined`);
    }
  });

const knownServerAchievements = new Set(SERVER_ACHIEVEMENTS.map((a) => a.id));
check('unlocked server achievements that no longer exist', ['server_achievements_unlocked'],
  'SELECT DISTINCT achievement_id FROM server_achievements_unlocked',
  (rows, label) => {
    const unknown = rows.filter((r) => !knownServerAchievements.has(r.achievement_id));
    if (unknown.length) {
      report('WARN', label, `${unknown.map((r) => r.achievement_id).join(', ')} — renamed or removed`, unknown);
    } else {
      report('OK', label, `all ${rows.length} referenced ids are defined`);
    }
  });

check('event signups whose event is gone', ['event_signups', 'events'],
  'SELECT s.event_id, s.user_id FROM event_signups s LEFT JOIN events e ON e.id = s.event_id WHERE e.id IS NULL',
  expectFalsy('ERROR', 'none', (r) => `${plural(r.length, 'signup')} orphaned — deleteEvent should have removed these`));

check('reminder rows whose event is gone', ['event_reminders_sent', 'events'],
  'SELECT r.event_id, r.stage_minutes FROM event_reminders_sent r LEFT JOIN events e ON e.id = r.event_id WHERE e.id IS NULL',
  expectFalsy('ERROR', 'none', (r) => `${plural(r.length, 'row')} orphaned`));

console.log('\nSocial activity');
// Every check here is guarded on the table, because social_days and active_voice arrived after
// this script did and a real snapshot taken before then simply will not have them.
check('recorded social days', ['social_days'],
  `SELECT guild_id, COUNT(*) AS n, COUNT(DISTINCT user_id) AS members,
          COALESCE(SUM(text_minutes), 0) AS text, COALESCE(SUM(voice_minutes), 0) AS voice
     FROM social_days GROUP BY guild_id`,
  (rows, label) => {
    if (!rows.length) { report('OK', label, 'none yet'); return; }
    report('NOTE', label, rows.map((r) =>
      `guild ${r.guild_id}: ${plural(r.n, 'day-row')} for ${plural(r.members, 'member')}, `
      + `${plural(r.text, 'text minute')} and ${hours(r.voice * 60)} of voice`).join('; '), rows);
  });

check('negative social minutes', ['social_days'],
  // Nothing subtracts from these — the only writes add, and the voice credit clamps at the cap.
  // A negative therefore means something wrote a total directly rather than going through them.
  'SELECT guild_id, user_id, day, text_minutes, voice_minutes FROM social_days '
  + 'WHERE text_minutes < 0 OR voice_minutes < 0',
  expectFalsy('ERROR', 'none', (r) => `${plural(r.length, 'day-row')} below zero`));

check('the silence floor', ['guild_settings.social_tracking_started_at', 'social_days'],
  // Without it, Cave Dweller cannot tell a member who said nothing from one who joined yesterday,
  // so it refuses to award at all. Worth naming, because the symptom is a badge that never appears.
  `SELECT DISTINCT s.guild_id FROM social_days s
     LEFT JOIN guild_settings g ON g.guild_id = s.guild_id
    WHERE g.social_tracking_started_at IS NULL`,
  expectFalsy('WARN', 'recorded for every guild with activity',
    (r) => `${plural(r.length, 'guild')} tracking social activity with no start recorded — `
      + 'Cave Dweller cannot be awarded there'));

check('members in voice right now', ['active_voice'],
  // Not a fault: this table is live state, and the report may well be run while the bot is up.
  // Rows surviving a *stopped* bot would be, since both shutdown paths empty it.
  `SELECT guild_id, COUNT(*) AS n, SUM(qualified) AS counting FROM active_voice GROUP BY guild_id`,
  (rows, label) => {
    if (!rows.length) { report('OK', label, 'none'); return; }
    report('NOTE', label, rows.map((r) =>
      `guild ${r.guild_id}: ${plural(r.n, 'member')}, ${r.counting} with the clock running`).join('; '), rows);
  });

check('voice rows with no checkpoint', ['active_voice'],
  // last_checkpoint_at carries the owed seconds. A null would make the next settle credit from
  // the epoch, which is where an implausible pile of voice minutes would come from.
  'SELECT guild_id, user_id, channel_id FROM active_voice WHERE last_checkpoint_at IS NULL',
  expectFalsy('ERROR', 'none', (r) => plural(r.length, 'row')));

console.log('\nOpt-outs');
// Informational, not a fault. Worth surfacing because an opted-out member is filtered out of every
// ranking, so "why is X missing from the leaderboard" has an answer here rather than in the data.
check('members opted out of tracking', ['tracking_optouts'],
  'SELECT guild_id, COUNT(*) AS n FROM tracking_optouts GROUP BY guild_id',
  (rows, label) => {
    if (!rows.length) { report('OK', label, 'none'); return; }
    report('NOTE', label, rows.map((r) => `guild ${r.guild_id}: ${plural(r.n, 'member')}`).join('; '), rows);
  });

check('opted-out members with a session still running', ['tracking_optouts', 'active_sessions'],
  // optOut closes the session in flight inside the same transaction, so a survivor means something
  // wrote an active_sessions row for a member the tracker is supposed to be ignoring.
  `SELECT o.guild_id, o.user_id FROM tracking_optouts o
     JOIN active_sessions s ON s.guild_id = o.guild_id AND s.user_id = o.user_id`,
  expectFalsy('WARN', 'none', (r) => `${plural(r.length, 'session')} running for an opted-out member`));

check('opted-out members still in a voice row', ['tracking_optouts', 'active_voice'],
  // Same shape as the session check above: optOut drops the voice row in the same transaction, and
  // settleRoom refuses to create one, so a survivor means both gates were bypassed.
  `SELECT o.guild_id, o.user_id FROM tracking_optouts o
     JOIN active_voice v ON v.guild_id = o.guild_id AND v.user_id = o.user_id`,
  expectFalsy('WARN', 'none', (r) => `${plural(r.length, 'voice row')} for an opted-out member`));

check('social activity recorded after opting out', ['tracking_optouts', 'social_days'],
  // The day the member opted out is ambiguous — minutes earned that morning are legitimate — so
  // only days strictly after it can indicate the write gate leaked.
  `SELECT s.guild_id, s.user_id, s.day FROM social_days s
     JOIN tracking_optouts o ON o.guild_id = s.guild_id AND o.user_id = s.user_id
    WHERE s.day > date(o.opted_out_at / 1000, 'unixepoch')
      AND (s.text_minutes > 0 OR s.voice_minutes > 0)`,
  expectFalsy('WARN', 'none', (r) => `${plural(r.length, 'day-row')} written after the member opted out`));

console.log('\nManual corrections');
// Not a fault of any kind — but a total that was set by hand is otherwise indistinguishable from
// one that was earned, and that is exactly the context someone reading this report needs.
check('recorded corrections', ['stat_adjustments'],
  `SELECT guild_id, COUNT(*) AS n, SUM(delta_seconds) AS net FROM stat_adjustments GROUP BY guild_id`,
  (rows, label) => {
    if (!rows.length) { report('OK', label, 'none — no stats have been changed by hand'); return; }
    report('NOTE', label, rows.map((r) =>
      `guild ${r.guild_id}: ${plural(r.n, 'correction')}, net ${r.net < 0 ? '−' : '+'}${hours(Math.abs(r.net))}`).join('; '), rows);
  });

check('voided sessions that are still present', ['stat_adjustments', 'play_sessions'],
  // play_sessions ids come from an AUTOINCREMENT column and are never reused, so a logged void
  // whose session row still exists means the delete half of that transaction did not stick.
  `SELECT a.id, a.session_id, a.guild_id FROM stat_adjustments a
     JOIN play_sessions p ON p.id = a.session_id WHERE a.kind = 'session'`,
  expectFalsy('ERROR', 'none', (r) => `${plural(r.length, 'session')} logged as voided but still in play_sessions`));

console.log('');
check('duplicate rank role assignments', ['rank_roles'],
  'SELECT guild_id, role_id, COUNT(*) AS uses FROM rank_roles GROUP BY guild_id, role_id HAVING COUNT(*) > 1',
  expectFalsy('ERROR', 'none', (r) => `${plural(r.length, 'role')} mapped to more than one rank`));

check('rank role rows', ['rank_roles'],
  'SELECT guild_id, COUNT(*) AS ranks FROM rank_roles GROUP BY guild_id',
  (rows, label) => {
    if (!rows.length) { report('NOTE', label, 'no rank roles saved yet — /setup has not been run'); return; }
    // Whether the Discord roles still exist can only be answered by the bot with a gateway
    // connection; /setup re-creates any that were deleted.
    report('OK', label, rows.map((r) => `${r.ranks} in guild ${r.guild_id}`).join(', '));
  });

check('rank roles left behind by a shorter RANK_NAMES', ['rank_roles'],
  // /setup writes one row per configured rank but never deletes rows above the new top index, so
  // shortening RANK_NAMES strands the extras. The Discord roles they point at are still on members
  // and are no longer managed by the bot — syncRank will not remove them, because it only tracks
  // roles it can still see in this table for a *current* rank index.
  `SELECT guild_id, rank_index, role_id FROM rank_roles WHERE rank_index >= ${RANKS.length} ORDER BY guild_id, rank_index`,
  expectFalsy('WARN', `none — all rows are within the ${RANKS.length} configured ranks`,
    (r) => `${plural(r.length, 'row')} above rank index ${RANKS.length - 1}; leftovers from a longer RANK_NAMES, and those Discord roles are now unmanaged`));

console.log(`\n${'─'.repeat(60)}`);
if (errors) {
  console.log(`✗ ${plural(errors, 'error')}, ${plural(warnings, 'warning')}.\n`);
} else {
  console.log(`✓ No errors${warnings ? `, ${plural(warnings, 'warning')}` : ''}.\n`);
}
db.close();
process.exit(errors ? 1 : 0);
