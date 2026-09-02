import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { socialDayKey, epochMinute, windowDays, SOCIAL_METRICS } from './social.js';

export function openDatabase(filename = 'data/tracker.sqlite') {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS active_sessions (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      game_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_checkpoint_at INTEGER,
      paused_at INTEGER,
      paused_seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS game_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      game_name TEXT NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, game_name)
    );
    CREATE TABLE IF NOT EXISTS play_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      game_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_play_sessions_guild_user_game ON play_sessions (guild_id, user_id, game_name);
    -- The monthly leaderboard, the recap and several server metrics filter on a time window
    -- rather than on a member, so they miss the index above entirely.
    CREATE INDEX IF NOT EXISTS idx_play_sessions_guild_ended ON play_sessions (guild_id, ended_at);
    CREATE INDEX IF NOT EXISTS idx_play_sessions_guild_started ON play_sessions (guild_id, started_at);
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      notification_channel_id TEXT,
      last_announced_release_id TEXT
    );
    CREATE TABLE IF NOT EXISTS rank_roles (
      guild_id TEXT NOT NULL,
      rank_index INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, rank_index)
    );
    CREATE TABLE IF NOT EXISTS achievements_unlocked (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, achievement_id)
    );
    CREATE TABLE IF NOT EXISTS duo_days (
      guild_id TEXT NOT NULL,
      user_id_a TEXT NOT NULL,
      user_id_b TEXT NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id_a, user_id_b, day)
    );
    CREATE TABLE IF NOT EXISTS server_achievements_unlocked (
      guild_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, achievement_id)
    );
    -- Every badge the recap has ever handed out: one row per period, per badge.
    --
    -- Without this the whole history is thrown away. guild_settings.last_monthly_recap records
    -- only *which* period was last announced, so the moment the next one turns over there is no
    -- longer anything anywhere saying who won the last — the role has simply moved on.
    --
    -- Cave Dweller is deliberately **not** recorded here. It lands on however many members were
    -- absent rather than on one, and it comes off the instant somebody turns up; a permanent,
    -- countable tally of who was missing week after week is a very different object from a role
    -- that clears itself, and a far less kind one. The badges kept here are the ones a member
    -- would want counted.
    --
    -- metric_seconds is always seconds, whichever badge the row belongs to — playtime for the
    -- champion, social minutes multiplied out for the other two — so one column never has to be
    -- read in two units depending on its neighbour.
    CREATE TABLE IF NOT EXISTS recap_winners (
      guild_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      badge TEXT NOT NULL,
      user_id TEXT NOT NULL,
      metric_seconds INTEGER NOT NULL DEFAULT 0,
      awarded_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, period_key, badge)
    );
    -- A member's own tally reads every period for one member, which the primary key cannot serve.
    CREATE INDEX IF NOT EXISTS idx_recap_winners_guild_user ON recap_winners (guild_id, user_id);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      game_name TEXT,
      starts_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      -- A recurring event advances this same row rather than being re-created, so starts_at is
      -- always the *next* occurrence and repeat_rule is the whole of the recurrence state.
      -- NULL for a one-off, which is every event written before this column existed.
      repeat_rule TEXT,
      -- The zone the start time was typed in. Only recurrence needs it — a one-off is a single
      -- instant every viewer sees in their own time — but "every Friday at 20:00" has to survive a
      -- daylight-saving change, and a bare UTC instant has no time of day left to preserve.
      timezone TEXT
    );
    CREATE TABLE IF NOT EXISTS event_signups (
      event_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS event_reminders_sent (
      event_id INTEGER NOT NULL,
      stage_minutes INTEGER NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (event_id, stage_minutes)
    );
    -- Members who asked not to be tracked. Presence-based recording stops for them entirely, and
    -- every *ranking* hides them (see NOT_OPTED_OUT below). Their existing rows are deliberately
    -- left in place: opting out is reversible, and deleting on opt-out would make it a one-way
    -- door. /privacy forgetme is the separate, explicit way to actually remove the data.
    CREATE TABLE IF NOT EXISTS tracking_optouts (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      opted_out_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    -- Every manual stat correction, permanently. Rows are never deleted or edited: an audit log
    -- that can be tidied up is not an audit log, and this is the only record that a member's total
    -- was changed by hand rather than earned. delta_seconds is what was actually applied after
    -- clamping, not what was asked for, so replaying the column reproduces the current totals.
    CREATE TABLE IF NOT EXISTS stat_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      game_name TEXT,
      delta_seconds INTEGER NOT NULL,
      session_id INTEGER,
      reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stat_adjustments_guild_user ON stat_adjustments (guild_id, user_id, created_at);
    -- Social activity, bucketed by UTC day rather than recorded per event. A row per message would
    -- be far more rows for no extra answer, and a row per voice join/leave would be a searchable
    -- log of who was in a room with whom, hour by hour — more sensitive than anything else here,
    -- and nothing the weekly window needs.
    --
    -- last_text_minute is an epoch-minute, and exists only to make the text write idempotent
    -- within its minute: ten messages in one minute is one minute. It is scoped to the day row, so
    -- a message at 23:59 and one at 00:00 land on different rows and both count.
    CREATE TABLE IF NOT EXISTS social_days (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      text_minutes INTEGER NOT NULL DEFAULT 0,
      voice_minutes INTEGER NOT NULL DEFAULT 0,
      last_text_minute INTEGER,
      PRIMARY KEY (guild_id, user_id, day)
    );
    -- Rankings scan a day range across the whole guild, which the primary key cannot serve.
    CREATE INDEX IF NOT EXISTS idx_social_days_guild_day ON social_days (guild_id, day);
    -- Who is in voice right now, mirroring active_sessions. Unlike a game session this is not
    -- self-contained: whether the clock runs depends on who else is in the room, so qualified
    -- is a cache of the room's state at the last settle, not a property of the member.
    --
    -- last_checkpoint_at carries the sub-minute remainder. Banking advances it by whole minutes
    -- only, so the seconds left over stay owed instead of being truncated away on every settle —
    -- and a busy room settles on every join, leave and mute, which would otherwise bleed minutes.
    CREATE TABLE IF NOT EXISTS active_voice (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      qualified INTEGER NOT NULL DEFAULT 0,
      last_checkpoint_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_active_voice_channel ON active_voice (guild_id, channel_id);
  `);
  const activeSessionColumns = db.prepare('PRAGMA table_info(active_sessions)').all();
  if (!activeSessionColumns.some((column) => column.name === 'last_checkpoint_at')) {
    db.exec('ALTER TABLE active_sessions ADD COLUMN last_checkpoint_at INTEGER');
  }
  if (!activeSessionColumns.some((column) => column.name === 'paused_at')) {
    db.exec('ALTER TABLE active_sessions ADD COLUMN paused_at INTEGER');
  }
  if (!activeSessionColumns.some((column) => column.name === 'paused_seconds')) {
    db.exec('ALTER TABLE active_sessions ADD COLUMN paused_seconds INTEGER NOT NULL DEFAULT 0');
  }
  const guildSettingsColumns = db.prepare('PRAGMA table_info(guild_settings)').all();
  if (!guildSettingsColumns.some((column) => column.name === 'last_announced_release_id')) {
    db.exec('ALTER TABLE guild_settings ADD COLUMN last_announced_release_id TEXT');
  }
  if (!guildSettingsColumns.some((column) => column.name === 'last_monthly_recap')) {
    db.exec('ALTER TABLE guild_settings ADD COLUMN last_monthly_recap TEXT');
  }
  // When social tracking first ran for this guild. Absence of social_days rows is not evidence of
  // silence — without a floor to measure from, a member who joined yesterday is indistinguishable
  // from one who has never said a word, and both would be handed the same title.
  if (!guildSettingsColumns.some((column) => column.name === 'social_tracking_started_at')) {
    db.exec('ALTER TABLE guild_settings ADD COLUMN social_tracking_started_at INTEGER');
  }
  const eventColumns = db.prepare('PRAGMA table_info(events)').all();
  if (!eventColumns.some((column) => column.name === 'message_id')) {
    db.exec('ALTER TABLE events ADD COLUMN message_id TEXT');
  }
  if (!eventColumns.some((column) => column.name === 'repeat_rule')) {
    db.exec('ALTER TABLE events ADD COLUMN repeat_rule TEXT');
  }
  if (!eventColumns.some((column) => column.name === 'timezone')) {
    db.exec('ALTER TABLE events ADD COLUMN timezone TEXT');
  }
  // The surviving name of a `merge` correction. game_name holds the name that disappeared, so the
  // pair reads as "X was folded into Y" — and a merge is the one correction whose subject is two
  // names rather than an amount, which is why it needs a column of its own rather than a string
  // stuffed into game_name. Null for every other kind.
  const adjustmentColumns = db.prepare('PRAGMA table_info(stat_adjustments)').all();
  if (!adjustmentColumns.some((column) => column.name === 'merged_into')) {
    db.exec('ALTER TABLE stat_adjustments ADD COLUMN merged_into TEXT');
  }
  db.exec('UPDATE active_sessions SET last_checkpoint_at = started_at WHERE last_checkpoint_at IS NULL');

  /**
   * Hides opted-out members from a ranking.
   *
   * Correlated on the row's own guild and member, so it needs **no extra bound parameter** and
   * drops into any WHERE over a table carrying those two columns. That matters: these statements
   * are positional, and threading another `?` through each one is exactly how a filter ends up
   * applied to the wrong argument.
   *
   * Applied to rankings and records only — never to a member's own profile, which is their data to
   * see, and never to server-wide totals, which are the server's history rather than a roster.
   */
  const NOT_OPTED_OUT = (table) =>
    `NOT EXISTS (SELECT 1 FROM tracking_optouts oo WHERE oo.guild_id = ${table}.guild_id AND oo.user_id = ${table}.user_id)`;

  const getStats = db.prepare('SELECT total_seconds FROM member_stats WHERE guild_id = ? AND user_id = ?');
  const addTime = db.prepare(`
    INSERT INTO member_stats (guild_id, user_id, total_seconds) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds
  `);
  const getSession = db.prepare('SELECT * FROM active_sessions WHERE guild_id = ? AND user_id = ?');
  const createSession = db.prepare(`
    INSERT INTO active_sessions (guild_id, user_id, game_name, started_at, last_checkpoint_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET game_name = excluded.game_name, started_at = excluded.started_at, last_checkpoint_at = excluded.last_checkpoint_at, paused_at = NULL, paused_seconds = 0
  `);
  const resetSessionCheckpoint = db.prepare('UPDATE active_sessions SET last_checkpoint_at = ? WHERE guild_id = ? AND user_id = ?');
  const markSessionPaused = db.prepare('UPDATE active_sessions SET paused_at = ?, last_checkpoint_at = ? WHERE guild_id = ? AND user_id = ?');
  const markSessionResumed = db.prepare(`
    UPDATE active_sessions SET paused_at = NULL, paused_seconds = paused_seconds + ?, last_checkpoint_at = ?
    WHERE guild_id = ? AND user_id = ?
  `);
  const removeSession = db.prepare('DELETE FROM active_sessions WHERE guild_id = ? AND user_id = ?');
  // Per-game time and the session tally are bumped separately: time accrues at every checkpoint so
  // an interrupted session still leaves its playtime attributed to the right game, while the tally
  // only moves when a session actually finishes.
  const addGameSeconds = db.prepare(`
    INSERT INTO game_stats (guild_id, user_id, game_name, total_seconds, session_count) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(guild_id, user_id, game_name) DO UPDATE SET
      total_seconds = total_seconds + excluded.total_seconds
  `);
  const bumpGameSessionCount = db.prepare(`
    INSERT INTO game_stats (guild_id, user_id, game_name, total_seconds, session_count) VALUES (?, ?, ?, 0, 1)
    ON CONFLICT(guild_id, user_id, game_name) DO UPDATE SET
      session_count = session_count + 1
  `);
  const saveCompletedSession = db.prepare(`
    INSERT INTO play_sessions (guild_id, user_id, game_name, started_at, ended_at, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Manual corrections. These are the only writes that can move a total *downwards*, so each one
  // clamps at zero rather than trusting the caller — a stat going negative would read as an
  // enormous number everywhere it is formatted, and there is no legitimate negative playtime.
  const getGameStatsRow = db.prepare('SELECT total_seconds, session_count FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_name = ?');
  const setGameStatsRow = db.prepare(`
    INSERT INTO game_stats (guild_id, user_id, game_name, total_seconds, session_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, game_name) DO UPDATE SET
      total_seconds = excluded.total_seconds, session_count = excluded.session_count
  `);
  const removeGameStatsRow = db.prepare('DELETE FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_name = ?');
  const setMemberTotal = db.prepare(`
    INSERT INTO member_stats (guild_id, user_id, total_seconds) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET total_seconds = excluded.total_seconds
  `);
  const getPlaySessionStmt = db.prepare('SELECT * FROM play_sessions WHERE id = ?');
  const removePlaySession = db.prepare('DELETE FROM play_sessions WHERE id = ?');
  const getRecentSessionsStmt = db.prepare(`
    SELECT id, game_name, started_at, ended_at, duration_seconds FROM play_sessions
    WHERE guild_id = ? AND user_id = ? ORDER BY ended_at DESC LIMIT ?
  `);
  // The reading half of the same history, for `/adjust sessions`: the picker above answers "which
  // session am I about to void", this one answers "what has the bot actually recorded". Optional
  // member filter in the `(? IS NULL OR ...)` shape `getAdjustments` already uses, so one statement
  // serves both the server-wide list and one member's. `ended_at DESC` rides
  // idx_play_sessions_guild_ended; the id breaks a tie between two sessions that ended in the same
  // millisecond, which is otherwise an unstable order.
  const getSessionLogStmt = db.prepare(`
    SELECT id, user_id, game_name, started_at, ended_at, duration_seconds FROM play_sessions
    WHERE guild_id = ? AND (? IS NULL OR user_id = ?)
    ORDER BY ended_at DESC, id DESC LIMIT ?
  `);
  // Oldest first, deliberately: a session that has been running for two days is the one an audit is
  // looking for, and it is the one a `LIMIT` ordered the other way would cut off.
  const getRunningSessionsStmt = db.prepare(`
    SELECT user_id, game_name, started_at, paused_at, paused_seconds FROM active_sessions
    WHERE guild_id = ? AND (? IS NULL OR user_id = ?)
    ORDER BY started_at LIMIT ?
  `);
  // Includes a running session's game, which has no game_stats row until its first checkpoint —
  // the mis-reported session an admin most wants to correct is often the one happening right now.
  const getMemberGameNamesStmt = db.prepare(`
    SELECT game_name, MAX(total_seconds) AS total_seconds FROM (
      SELECT game_name, total_seconds FROM game_stats WHERE guild_id = ? AND user_id = ?
      UNION ALL SELECT game_name, 0 FROM active_sessions WHERE guild_id = ? AND user_id = ?
    ) GROUP BY game_name ORDER BY total_seconds DESC LIMIT ?
  `);
  // The same picker as above, for the whole guild: a game name belongs to the server, not to one
  // member, so merging two spellings of it is not a per-member correction.
  const getGuildGameNamesStmt = db.prepare(`
    SELECT game_name, MAX(total_seconds) AS total_seconds FROM (
      SELECT game_name, SUM(total_seconds) AS total_seconds FROM game_stats WHERE guild_id = ? GROUP BY game_name
      UNION ALL SELECT DISTINCT game_name, 0 FROM active_sessions WHERE guild_id = ?
    ) GROUP BY game_name ORDER BY total_seconds DESC, game_name LIMIT ?
  `);
  // Everyone with anything at all under a name, including a member whose only trace of it is the
  // session running right now — they have no game_stats row until its first checkpoint.
  const getGameHoldersStmt = db.prepare(`
    SELECT user_id, MAX(total_seconds) AS total_seconds, MAX(session_count) AS session_count FROM (
      SELECT user_id, total_seconds, session_count FROM game_stats WHERE guild_id = ? AND game_name = ?
      UNION ALL SELECT DISTINCT user_id, 0, 0 FROM play_sessions WHERE guild_id = ? AND game_name = ?
      UNION ALL SELECT user_id, 0, 0 FROM active_sessions WHERE guild_id = ? AND game_name = ?
    ) GROUP BY user_id ORDER BY total_seconds DESC
  `);
  const foldGameStatsStmt = db.prepare(`
    INSERT INTO game_stats (guild_id, user_id, game_name, total_seconds, session_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, game_name) DO UPDATE SET
      total_seconds = total_seconds + excluded.total_seconds,
      session_count = session_count + excluded.session_count
  `);
  const removeGameStatsByNameStmt = db.prepare('DELETE FROM game_stats WHERE guild_id = ? AND game_name = ?');
  const renamePlaySessionsStmt = db.prepare('UPDATE play_sessions SET game_name = ? WHERE guild_id = ? AND game_name = ?');
  const renameActiveSessionsStmt = db.prepare('UPDATE active_sessions SET game_name = ? WHERE guild_id = ? AND game_name = ?');
  const countGameStatsRowsStmt = db.prepare('SELECT COUNT(*) AS n FROM game_stats WHERE guild_id = ? AND game_name = ?');
  const sumGameSecondsStmt = db.prepare(
    'SELECT COALESCE(SUM(total_seconds), 0) AS total_seconds FROM game_stats WHERE guild_id = ? AND game_name = ?');
  const recordAdjustmentStmt = db.prepare(`
    INSERT INTO stat_adjustments (guild_id, user_id, actor_id, kind, game_name, merged_into, delta_seconds, session_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getAdjustmentsStmt = db.prepare(`
    SELECT * FROM stat_adjustments WHERE guild_id = ? AND (? IS NULL OR user_id = ?)
    ORDER BY created_at DESC, id DESC LIMIT ?
  `);

  const isOptedOutStmt = db.prepare('SELECT 1 FROM tracking_optouts WHERE guild_id = ? AND user_id = ?');
  const getOptOutStmt = db.prepare('SELECT opted_out_at FROM tracking_optouts WHERE guild_id = ? AND user_id = ?');
  const setOptedOutStmt = db.prepare('INSERT OR IGNORE INTO tracking_optouts (guild_id, user_id, opted_out_at) VALUES (?, ?, ?)');
  const clearOptedOutStmt = db.prepare('DELETE FROM tracking_optouts WHERE guild_id = ? AND user_id = ?');

  // Social day buckets. The text write is a conditional upsert: the WHERE on DO UPDATE makes a
  // second message in the same minute change nothing, so `.changes` is the answer to "did this
  // message buy a new minute?" without a separate read.
  const recordTextMinuteStmt = db.prepare(`
    INSERT INTO social_days (guild_id, user_id, day, text_minutes, last_text_minute) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(guild_id, user_id, day) DO UPDATE SET
      text_minutes = text_minutes + 1, last_text_minute = excluded.last_text_minute
    WHERE last_text_minute IS NULL OR last_text_minute <> excluded.last_text_minute
  `);
  const getSocialDayStmt = db.prepare('SELECT * FROM social_days WHERE guild_id = ? AND user_id = ? AND day = ?');
  const setVoiceMinutesStmt = db.prepare(`
    INSERT INTO social_days (guild_id, user_id, day, voice_minutes) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, day) DO UPDATE SET voice_minutes = excluded.voice_minutes
  `);
  // A member's own totals, deliberately unfiltered: opting out hides you from rankings, it does
  // not hide your own record from you.
  const getSocialTotalsStmt = db.prepare(`
    SELECT COALESCE(SUM(text_minutes), 0) AS text_minutes, COALESCE(SUM(voice_minutes), 0) AS voice_minutes,
           COUNT(*) AS days
    FROM social_days WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ?
  `);
  // One statement per metric rather than an interpolated column name: the metric decides both the
  // ORDER BY and the HAVING, and building either from a caller-supplied string is how an injection
  // gets in. Both shapes return both columns, because the recap shows the runner-up's split and
  // names anyone who topped a second board without being given its badge.
  const socialLeaderboardStmts = Object.fromEntries(SOCIAL_METRICS.map((metric) => [metric, db.prepare(`
    SELECT user_id, SUM(text_minutes) AS text_minutes, SUM(voice_minutes) AS voice_minutes
    FROM social_days
    WHERE guild_id = ? AND day >= ? AND day <= ? AND ${NOT_OPTED_OUT('social_days')}
    GROUP BY user_id HAVING SUM(${metric}_minutes) > 0
    ORDER BY SUM(${metric}_minutes) DESC, user_id ASC LIMIT ?
  `)]));
  /**
   * Everyone who did *anything* in a window: played, typed, or held a qualifying voice minute.
   *
   * The complement of this set is what Cave Dweller is awarded from, so a false negative here
   * hands somebody a badge saying they were absent when they were not. It therefore also counts
   * whoever is playing or in voice right this second: an in-flight session has no play_sessions
   * row until it closes, and somebody who never stopped playing all period would otherwise look
   * like they had never started.
   */
  const getActiveMemberIdsStmt = db.prepare(`
    SELECT DISTINCT user_id FROM play_sessions WHERE guild_id = ? AND ended_at >= ? AND ended_at < ?
    UNION SELECT user_id FROM social_days
      WHERE guild_id = ? AND day >= ? AND day <= ? AND (text_minutes > 0 OR voice_minutes > 0)
    UNION SELECT user_id FROM active_sessions WHERE guild_id = ?
    UNION SELECT user_id FROM active_voice WHERE guild_id = ?
  `);
  const getFirstSocialDayStmt = db.prepare(`
    SELECT MIN(day) AS day FROM social_days
    WHERE guild_id = ? AND user_id = ? AND (text_minutes > 0 OR voice_minutes > 0)
  `);
  const getVoiceRowStmt = db.prepare('SELECT * FROM active_voice WHERE guild_id = ? AND user_id = ?');
  const getVoiceRowsForChannelStmt = db.prepare('SELECT * FROM active_voice WHERE guild_id = ? AND channel_id = ?');
  const getAllVoiceRowsStmt = db.prepare('SELECT * FROM active_voice');
  const upsertVoiceRowStmt = db.prepare(`
    INSERT INTO active_voice (guild_id, user_id, channel_id, qualified, last_checkpoint_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      channel_id = excluded.channel_id, qualified = excluded.qualified,
      last_checkpoint_at = excluded.last_checkpoint_at
  `);
  const deleteVoiceRowStmt = db.prepare('DELETE FROM active_voice WHERE guild_id = ? AND user_id = ?');
  // Deliberately leaves last_checkpoint_at alone: an existing row is carrying owed seconds, and
  // rewriting the timestamp here would throw them away every time somebody toggled their mic.
  const setVoiceQualifiedStmt = db.prepare('UPDATE active_voice SET channel_id = ?, qualified = ? WHERE guild_id = ? AND user_id = ?');
  const advanceVoiceCheckpointStmt = db.prepare('UPDATE active_voice SET last_checkpoint_at = ? WHERE guild_id = ? AND user_id = ?');

  const getSocialTrackingStartedAtStmt = db.prepare('SELECT social_tracking_started_at FROM guild_settings WHERE guild_id = ?');
  const setSocialTrackingStartedAtStmt = db.prepare(`
    INSERT INTO guild_settings (guild_id, social_tracking_started_at) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET social_tracking_started_at =
      COALESCE(guild_settings.social_tracking_started_at, excluded.social_tracking_started_at)
  `);

  const getNotificationChannel = db.prepare('SELECT notification_channel_id FROM guild_settings WHERE guild_id = ?');
  const setNotificationChannel = db.prepare(`
    INSERT INTO guild_settings (guild_id, notification_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET notification_channel_id = excluded.notification_channel_id
  `);
  const getLastAnnouncedRelease = db.prepare('SELECT last_announced_release_id FROM guild_settings WHERE guild_id = ?');
  const setLastAnnouncedRelease = db.prepare(`
    INSERT INTO guild_settings (guild_id, last_announced_release_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET last_announced_release_id = excluded.last_announced_release_id
  `);
  const getLastMonthlyRecapStmt = db.prepare('SELECT last_monthly_recap FROM guild_settings WHERE guild_id = ?');
  const setLastMonthlyRecapStmt = db.prepare(`
    INSERT INTO guild_settings (guild_id, last_monthly_recap) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET last_monthly_recap = excluded.last_monthly_recap
  `);
  // ---- Recap winners -------------------------------------------------------------------------

  // Upsert rather than insert: `announceRecap` can be re-run for a period it has already settled
  // (the preview scripts do exactly that, and `force` exists for it), and a second pass should
  // correct the record rather than refuse or duplicate it.
  const recordRecapWinnerStmt = db.prepare(`
    INSERT INTO recap_winners (guild_id, period_key, badge, user_id, metric_seconds, awarded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, period_key, badge) DO UPDATE SET
      user_id = excluded.user_id,
      metric_seconds = excluded.metric_seconds,
      awarded_at = excluded.awarded_at
  `);
  const getRecapWinCountsStmt = db.prepare(
    'SELECT badge, COUNT(*) AS wins FROM recap_winners WHERE guild_id = ? AND user_id = ? GROUP BY badge');
  // The exclusion is what makes "their 3rd win" survive a re-run: `announceRecap` can settle a
  // period it has already recorded, and counting the row it is about to write would report a win
  // one higher every time. Excluding by key rather than by date keeps it exact without depending on
  // period keys sorting against each other, which week and month keys do not.
  const getRecapWinCountStmt = db.prepare(`
    SELECT COUNT(*) AS wins FROM recap_winners
    WHERE guild_id = ? AND user_id = ? AND badge = ? AND (? IS NULL OR period_key <> ?)
  `);
  // A ranking of members, so opted-out members are hidden exactly as they are everywhere else.
  // Departed members are NOT filtered here, and that is the same call the server records make:
  // this is a record of what happened, not a roster of who is around to be ranked today.
  const getHallOfFameStmt = db.prepare(`
    SELECT user_id, COUNT(*) AS wins,
           SUM(badge = 'champion') AS champion,
           SUM(badge = 'bard') AS bard,
           SUM(badge = 'scribe') AS scribe
    FROM recap_winners
    WHERE guild_id = ? AND ${NOT_OPTED_OUT('recap_winners')}
    GROUP BY user_id
    ORDER BY wins DESC, champion DESC, user_id
    LIMIT ?
  `);
  const getRecapWinnersForPeriodStmt = db.prepare(
    'SELECT badge, user_id, metric_seconds, awarded_at FROM recap_winners WHERE guild_id = ? AND period_key = ?');

  const getRankRoles = db.prepare('SELECT rank_index, role_id FROM rank_roles WHERE guild_id = ? ORDER BY rank_index');
  const saveRankRole = db.prepare(`
    INSERT INTO rank_roles (guild_id, rank_index, role_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, rank_index) DO UPDATE SET role_id = excluded.role_id
  `);
  const countTrackedPlayersStmt = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS count FROM (
      SELECT user_id FROM member_stats WHERE guild_id = ?
      UNION SELECT user_id FROM active_sessions WHERE guild_id = ?
    )
  `);

  // Achievements
  const hasAchievementStmt = db.prepare('SELECT 1 FROM achievements_unlocked WHERE guild_id = ? AND user_id = ? AND achievement_id = ?');
  const unlockAchievementStmt = db.prepare(`
    INSERT OR IGNORE INTO achievements_unlocked (guild_id, user_id, achievement_id, unlocked_at) VALUES (?, ?, ?, ?)
  `);
  const getPlayerAchievementsStmt = db.prepare('SELECT achievement_id, unlocked_at FROM achievements_unlocked WHERE guild_id = ? AND user_id = ? ORDER BY unlocked_at');
  const getAchievementUnlockCountStmt = db.prepare('SELECT COUNT(*) AS count FROM achievements_unlocked WHERE guild_id = ? AND achievement_id = ?');
  // Games with real time in them, not merely launched once. No active_sessions union: a session
  // in flight has already banked everything but its last sub-minute tail into game_stats, and an
  // hour's threshold cannot turn on that tail.
  const getSubstantialGameCountStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM game_stats
    WHERE guild_id = ? AND user_id = ? AND total_seconds >= ?
  `);
  // Per-game seconds since a cutoff, so any tier needing "real time in it" can pick its own window
  // and its own bar — a day for the variety pair, a rolling three hours for Speedrunner. Sessions
  // are attributed by started_at, matching every other windowed query here.
  const getGameSecondsSinceStmt = db.prepare(`
    SELECT game_name, SUM(duration_seconds) AS total_seconds FROM play_sessions
    WHERE guild_id = ? AND user_id = ? AND started_at >= ?
    GROUP BY game_name
  `);
  const getGameStartCountSinceStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT started_at FROM play_sessions
      WHERE guild_id = ? AND user_id = ? AND game_name = ? AND started_at >= ?
      UNION ALL SELECT started_at FROM active_sessions
      WHERE guild_id = ? AND user_id = ? AND game_name = ? AND started_at >= ?
    )
  `);
  const getLastCompletedSessionStmt = db.prepare(`
    SELECT game_name, started_at, ended_at, duration_seconds FROM play_sessions
    WHERE guild_id = ? AND user_id = ? ORDER BY ended_at DESC LIMIT 1
  `);
  const getQualifyingSessionCountTodayStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM play_sessions
    WHERE guild_id = ? AND user_id = ? AND game_name = ? AND started_at >= ? AND duration_seconds >= ?
  `);
  const getDistinctDaysForGameStmt = db.prepare(`
    SELECT COUNT(DISTINCT day) AS count FROM (
      SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day FROM play_sessions WHERE guild_id = ? AND user_id = ? AND game_name = ?
      UNION SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') FROM active_sessions WHERE guild_id = ? AND user_id = ? AND game_name = ?
    )
  `);
  const getDistinctDaysAnyGameStmt = db.prepare(`
    SELECT COUNT(DISTINCT day) AS count FROM (
      SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day FROM play_sessions WHERE guild_id = ? AND user_id = ?
      UNION SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') FROM active_sessions WHERE guild_id = ? AND user_id = ?
    )
  `);
  const getPlayDatesStmt = db.prepare(`
    SELECT DISTINCT day FROM (
      SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day FROM play_sessions WHERE guild_id = ? AND user_id = ?
      UNION SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') FROM active_sessions WHERE guild_id = ? AND user_id = ?
    ) ORDER BY day DESC
  `);
  const getLastSessionEndForGameStmt = db.prepare(`
    SELECT MAX(ended_at) AS ended_at FROM play_sessions WHERE guild_id = ? AND user_id = ? AND game_name = ?
  `);
  const getShortGameCountTodayStmt = db.prepare(`
    SELECT COUNT(DISTINCT game_name) AS count FROM play_sessions
    WHERE guild_id = ? AND user_id = ? AND started_at >= ? AND duration_seconds < ?
  `);
  // Both feed achievements rather than a board, and both are filtered for the same reason: an
  // opted-out member should not be counted as somebody's co-op partner, nor be handed Touch Grass
  // for an absence the bot is no longer meant to be watching.
  const getActiveUsersForGameStmt = db.prepare(`
    SELECT user_id, started_at FROM active_sessions
    WHERE guild_id = ? AND game_name = ? AND ${NOT_OPTED_OUT('active_sessions')}
  `);
  const getInactivePlayersStmt = db.prepare(`
    SELECT user_id, MAX(ended_at) AS last_ended FROM play_sessions
    WHERE guild_id = ? AND user_id NOT IN (SELECT user_id FROM active_sessions WHERE guild_id = ?)
    AND ${NOT_OPTED_OUT('play_sessions')}
    GROUP BY user_id HAVING last_ended < ?
  `);
  // "Has this game ever been seen on this server before now?" — deliberately includes the asking
  // member's own past, so a game they have been playing for weeks is not treated as a discovery.
  // Their own in-flight session is excluded, since it was created moments before this is asked.
  const getGameHistoryStmt = db.prepare(`
    SELECT 1 FROM (
      SELECT user_id FROM game_stats WHERE guild_id = ? AND game_name = ?
      UNION SELECT user_id FROM play_sessions WHERE guild_id = ? AND game_name = ?
      UNION SELECT user_id FROM active_sessions WHERE guild_id = ? AND game_name = ? AND user_id != ?
    ) LIMIT 1
  `);
  const getLastSessionEndAnyStmt = db.prepare('SELECT MAX(ended_at) AS ended_at FROM play_sessions WHERE guild_id = ? AND user_id = ?');
  const getGameStatsTotalStmt = db.prepare('SELECT total_seconds FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_name = ?');
  const getGameSessionCountStmt = db.prepare('SELECT session_count FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_name = ?');
  const recordDuoDayStmt = db.prepare('INSERT OR IGNORE INTO duo_days (guild_id, user_id_a, user_id_b, day) VALUES (?, ?, ?, ?)');
  const getDuoDayCountStmt = db.prepare('SELECT COUNT(*) AS count FROM duo_days WHERE guild_id = ? AND user_id_a = ? AND user_id_b = ?');

  // Server-wide (guild-scoped, one-time) achievements
  const hasServerAchievementStmt = db.prepare('SELECT 1 FROM server_achievements_unlocked WHERE guild_id = ? AND achievement_id = ?');
  const unlockServerAchievementStmt = db.prepare(`
    INSERT OR IGNORE INTO server_achievements_unlocked (guild_id, achievement_id, unlocked_at) VALUES (?, ?, ?)
  `);
  const getServerAchievementsStmt = db.prepare('SELECT achievement_id, unlocked_at FROM server_achievements_unlocked WHERE guild_id = ? ORDER BY unlocked_at');
  // Games the server has collectively put real time into, summed across every member. Same bar and
  // same no-active_sessions reasoning as getSubstantialGameCount, one level up.
  const getGuildGameCountStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT game_name FROM game_stats WHERE guild_id = ?
      GROUP BY game_name HAVING SUM(total_seconds) >= ?
    )
  `);
  const getGuildBaseSecondsStmt = db.prepare('SELECT COALESCE(SUM(total_seconds), 0) AS total_seconds FROM member_stats WHERE guild_id = ?');
  const getGuildActiveSecondsStmt = db.prepare(`
    SELECT COALESCE(SUM(CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER)), 0) AS total_seconds
    FROM active_sessions WHERE guild_id = ?
  `);
  // Requires at least two distinct players so one person's own game can't read as "the server is
  // obsessed with this" (issue #20) — a game only one person has ever touched is excluded entirely,
  // not just docked, so a smaller game with real shared time can win instead.
  const getTopGameByHoursStmt = db.prepare(`
    SELECT game_name, SUM(total_seconds) AS total_seconds FROM (
      SELECT user_id, game_name, total_seconds FROM game_stats WHERE guild_id = ?
      UNION ALL
      SELECT user_id, game_name, CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER) FROM active_sessions WHERE guild_id = ?
    ) GROUP BY game_name HAVING COUNT(DISTINCT user_id) >= 2 ORDER BY total_seconds DESC LIMIT 1
  `);
  // Counts a member toward a game only once they personally have minSeconds in it, so a crowd that
  // all launched the same thing once does not read as a game the whole server plays.
  const getTopGameByPlayerCountStmt = db.prepare(`
    SELECT game_name, COUNT(DISTINCT user_id) AS players FROM game_stats
    WHERE guild_id = ? AND total_seconds >= ? AND ${NOT_OPTED_OUT('game_stats')}
    GROUP BY game_name ORDER BY players DESC LIMIT 1
  `);
  // Server records. The longest session can only be read from play_sessions, so it reaches back
  // exactly as far as that table does and no further — on a database that predates it the record
  // starts from the migration, not from the server's first day. Nothing else here has that limit:
  // both game counts come from game_stats, which is cumulative.
  const getLongestSessionStmt = db.prepare(`
    SELECT user_id, game_name, duration_seconds FROM play_sessions
    WHERE guild_id = ? AND ${NOT_OPTED_OUT('play_sessions')}
    ORDER BY duration_seconds DESC LIMIT 1
  `);
  // Same minSeconds bar as the collection ladder, so "most games" here means the same thing it
  // means on a member's own card. Counting bare launches would let one busy evening beat a library.
  const getTopCollectorStmt = db.prepare(`
    SELECT user_id, COUNT(DISTINCT game_name) AS games FROM game_stats
    WHERE guild_id = ? AND total_seconds >= ? AND ${NOT_OPTED_OUT('game_stats')}
    GROUP BY user_id ORDER BY games DESC LIMIT 1
  `);
  /**
   * Every session span overlapping a window, for the "when we play" histogram.
   *
   * Filtered on `ended_at` rather than `started_at` so a session that began before the window and
   * ran into it still contributes the part that lands inside — `activity.js` clamps each span to
   * the window and counts every hour it covered, which is the whole reason it needs both columns
   * and not a `GROUP BY` on the start hour. Sessions that ended before the window are excluded by
   * the same predicate, on `idx_play_sessions_guild_ended`.
   *
   * No opt-out filter, deliberately: this aggregates hours with nobody's name attached, the same
   * ground server totals stand on, and an opted-out member stops producing rows here regardless.
   */
  const getSessionSpansStmt = db.prepare(
    'SELECT started_at, ended_at FROM play_sessions WHERE guild_id = ? AND ended_at >= ?',
  );
  const getConcurrentGameCountStmt = db.prepare('SELECT COUNT(DISTINCT game_name) AS count FROM active_sessions WHERE guild_id = ?');
  const getActiveSessionCountStmt = db.prepare('SELECT COUNT(*) AS count FROM active_sessions WHERE guild_id = ?');
  const getPlayersAboveSecondsStmt = db.prepare('SELECT COUNT(*) AS count FROM member_stats WHERE guild_id = ? AND total_seconds >= ?');
  const getGuildGamesTodayStmt = db.prepare(`
    SELECT COUNT(DISTINCT game_name) AS count FROM (
      SELECT game_name FROM play_sessions WHERE guild_id = ? AND started_at >= ?
      UNION SELECT game_name FROM active_sessions WHERE guild_id = ? AND started_at >= ?
    )
  `);
  const getGuildPlayDatesStmt = db.prepare(`
    SELECT DISTINCT day FROM (
      SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day FROM play_sessions WHERE guild_id = ?
      UNION SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') FROM active_sessions WHERE guild_id = ?
    ) ORDER BY day DESC
  `);
  const getTotalAchievementUnlockCountStmt = db.prepare('SELECT COUNT(*) AS count FROM achievements_unlocked WHERE guild_id = ?');
  const getAllMemberTotalsStmt = db.prepare(`
    SELECT user_id, SUM(total_seconds) AS total_seconds FROM (
      SELECT user_id, total_seconds FROM member_stats WHERE guild_id = ?
      UNION ALL
      SELECT user_id, CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER) FROM active_sessions WHERE guild_id = ?
    ) GROUP BY user_id
  `);
  const getQualifiedDuoPairCountStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT user_id_a, user_id_b FROM duo_days WHERE guild_id = ? GROUP BY user_id_a, user_id_b HAVING COUNT(*) >= ?
    )
  `);

  // Events
  const createEventStmt = db.prepare(`
    INSERT INTO events (guild_id, channel_id, creator_id, title, description, game_name, starts_at, created_at, repeat_rule, timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getEventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const setEventMessageIdStmt = db.prepare('UPDATE events SET message_id = ? WHERE id = ?');
  const updateEventStmt = db.prepare(`
    UPDATE events SET title = ?, description = ?, game_name = ?, starts_at = ?, repeat_rule = ?, timezone = ? WHERE id = ?
  `);
  const deleteEventStmt = db.prepare('DELETE FROM events WHERE id = ?');
  const deleteEventSignupsStmt = db.prepare('DELETE FROM event_signups WHERE event_id = ?');
  const deleteEventRemindersStmt = db.prepare('DELETE FROM event_reminders_sent WHERE event_id = ?');
  const upsertEventSignupStmt = db.prepare(`
    INSERT INTO event_signups (event_id, user_id, status) VALUES (?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status
  `);
  const getEventSignupsStmt = db.prepare('SELECT user_id, status FROM event_signups WHERE event_id = ?');
  // Case-insensitive because the game name here comes from event creation's free-text field, while
  // game_stats rows come from whatever spelling Discord's presence activity reported — a mismatched
  // case shouldn't mean an empty prefill. Capped at 25 (Discord's hard limit on a select menu),
  // biased toward whoever has put in the most time so a cut-off crowd loses its least invested first.
  const getPlayersForGameStmt = db.prepare(`
    SELECT user_id FROM game_stats WHERE guild_id = ? AND game_name = ? COLLATE NOCASE AND total_seconds >= ?
    ORDER BY total_seconds DESC LIMIT 25
  `);
  const getUpcomingEventsStmt = db.prepare('SELECT * FROM events WHERE starts_at > ? ORDER BY starts_at');
  const getUpcomingEventsForGuildStmt = db.prepare('SELECT * FROM events WHERE guild_id = ? AND starts_at > ? ORDER BY starts_at LIMIT ?');
  // Full rows, not just ids: expiring an event also deletes its announcement message, which
  // needs channel_id and message_id read before the row goes.
  //
  // Recurring rows are excluded outright rather than relying on the roll loop having already moved
  // them out of range. The roll is pure arithmetic and cannot fail, but if it ever did, deleting
  // the row would cancel somebody's standing game night permanently — where skipping it leaves a
  // stale event that /event list still shows and an admin can delete by hand.
  const getStaleEventsStmt = db.prepare('SELECT * FROM events WHERE starts_at < ? AND repeat_rule IS NULL');
  const getRecurringEventsDueStmt = db.prepare('SELECT * FROM events WHERE repeat_rule IS NOT NULL AND starts_at <= ? ORDER BY starts_at');
  // The compare-and-swap that makes recurrence exactly-once: the row only moves if its start time
  // is still the one the caller read. message_id is cleared in the same statement, because the
  // announcement it points at belongs to the occurrence that just ended — leaving it would let a
  // later edit rewrite last week's post with next week's details.
  const rollEventStmt = db.prepare('UPDATE events SET starts_at = ?, message_id = NULL WHERE id = ? AND starts_at = ?');
  const clearEventRepeatStmt = db.prepare('UPDATE events SET repeat_rule = NULL WHERE id = ?');
  const hasReminderSentStmt = db.prepare('SELECT 1 FROM event_reminders_sent WHERE event_id = ? AND stage_minutes = ?');
  const getLastReminderSentAtStmt = db.prepare('SELECT MAX(sent_at) AS last FROM event_reminders_sent WHERE event_id = ?');
  const markReminderSentStmt = db.prepare(`
    INSERT OR IGNORE INTO event_reminders_sent (event_id, stage_minutes, sent_at) VALUES (?, ?, ?)
  `);

  const getLeaderboardStmt = db.prepare(`
    SELECT user_id, total_seconds FROM member_stats WHERE guild_id = ?
    AND ${NOT_OPTED_OUT('member_stats')}
    ORDER BY total_seconds DESC LIMIT ?
  `);
  // Completed sessions clamped to the window, plus whatever the live sessions have earned inside
  // it. Without the second half a member six hours into a session sees those hours on their /stats
  // card and none of them on the board. Idle time is excluded here exactly as it is everywhere else.
  const getMonthlyLeaderboardStmt = db.prepare(`
    SELECT user_id, SUM(seconds) AS total_seconds FROM (
      SELECT user_id, CASE WHEN ended_at > ? THEN
        CAST((MIN(ended_at, ?) - MAX(started_at, ?)) / 1000 AS INTEGER)
        ELSE 0 END AS seconds
      FROM play_sessions WHERE guild_id = ? AND ${NOT_OPTED_OUT('play_sessions')}

      UNION ALL

      SELECT user_id, CAST(MAX(0, MIN(
        (? - started_at) - paused_seconds * 1000
          - (CASE WHEN paused_at IS NOT NULL THEN MAX(0, ? - paused_at) ELSE 0 END),
        ? - ?
      )) / 1000 AS INTEGER) AS seconds
      FROM active_sessions WHERE guild_id = ? AND ${NOT_OPTED_OUT('active_sessions')}
    )
    GROUP BY user_id
    HAVING SUM(seconds) > 0
    ORDER BY total_seconds DESC LIMIT ?
  `);

  /**
   * Wall-clock time since the session started, minus every stretch the member spent idle.
   *
   * This is the number that drives session-length achievements and the duration written to
   * play_sessions, so an overnight AFK session is worth only the part somebody was actually at the
   * keyboard. `started_at` itself stays truthful — the pause is subtracted rather than folded into
   * it — because the day-boundary queries group on `started_at` and must not be shifted.
   */
  function activeElapsedMs(session, now) {
    const pausedSoFar = session.paused_at ? now - session.paused_at : 0;
    return Math.max(0, (now - session.started_at) - session.paused_seconds * 1000 - pausedSoFar);
  }

  /** Seconds owed but not yet banked. A paused session owes nothing past the moment it paused. */
  function unbankedSeconds(session, now) {
    if (!session) return 0;
    return Math.max(0, Math.floor(((session.paused_at ?? now) - session.last_checkpoint_at) / 1000));
  }

  function closeSession(guildId, userId, now = Date.now(), capSeconds = Infinity) {
    const session = getSession.get(guildId, userId);
    if (!session) return null;
    // Only the slice since the last checkpoint is new; everything before it was already banked by
    // checkpointAll into both member_stats and game_stats. A paused session banked its time up to
    // the moment it paused, so nothing after that point is owed.
    const creditableUntil = session.paused_at ?? now;
    const unrecordedSeconds = Math.max(0, Math.floor((creditableUntil - session.last_checkpoint_at) / 1000));
    if (unrecordedSeconds) {
      addTime.run(guildId, userId, unrecordedSeconds);
      addGameSeconds.run(guildId, userId, session.game_name, unrecordedSeconds);
    }
    // capSeconds only bites from closeSessionsExceeding: the checkpoint tick that notices a runaway
    // session does not always land within a minute of it crossing the cap (host sleep, a blocked
    // event loop, a stalled interval), so the raw span can run well past the limit. Clamping here
    // means the play_sessions row, the duration handed to session-length achievements, and the
    // aggregates all agree on the same capped number instead of three different ones — the caller
    // gets `excessSeconds` back so it can claw that part out of game_stats/member_stats too.
    const rawSeconds = Math.max(0, Math.floor(activeElapsedMs(session, now) / 1000));
    const totalSeconds = Math.min(rawSeconds, capSeconds);
    let completed = null;
    if (totalSeconds) {
      bumpGameSessionCount.run(guildId, userId, session.game_name);
      saveCompletedSession.run(guildId, userId, session.game_name, session.started_at, now, totalSeconds);
      completed = {
        gameName: session.game_name, startedAt: session.started_at, endedAt: now,
        durationSeconds: totalSeconds, excessSeconds: rawSeconds - totalSeconds,
      };
    }
    removeSession.run(guildId, userId);
    return completed;
  }

  /**
   * Closes sessions left behind by an unclean exit (crash, kill, reboot — anything that skips the
   * SIGINT flush). They are closed as of their last checkpoint rather than now, because the bot has
   * no idea whether the member kept playing while it was down; billing that gap as playtime would
   * inflate every total. Anyone still playing gets a fresh session once presences are read.
   * Returns the number of sessions recovered.
   */
  function recoverStaleSessions() {
    const stale = db.prepare('SELECT guild_id, user_id, last_checkpoint_at FROM active_sessions').all();
    for (const session of stale) closeSession(session.guild_id, session.user_id, session.last_checkpoint_at);
    return stale.length;
  }

  /**
   * Adds voice minutes to a day bucket, clamped to the daily cap. Returns what actually landed.
   * Not exported directly — `bankVoiceTime` owns the only correct way to call it, since the amount
   * always has to come from a row's elapsed time rather than from a caller's arithmetic.
   */
  function creditVoice(guildId, userId, minutes, dailyCapMinutes = Infinity, now = Date.now()) {
    if (!(minutes > 0)) return 0;
    const day = socialDayKey(now);
    const before = getSocialDayStmt.get(guildId, userId, day)?.voice_minutes ?? 0;
    const after = Math.min(before + minutes, dailyCapMinutes);
    if (after <= before) return 0;
    setVoiceMinutesStmt.run(guildId, userId, day, after);
    return after - before;
  }

  /**
   * Banks whatever this member's voice row owes, and returns the minutes credited.
   *
   * Three behaviours worth keeping straight:
   * - **Not qualified**: nothing is owed, and the clock restarts at `now`. Without that reset, the
   *   stretch spent muted or alone would be credited retroactively the moment they qualify again.
   * - **Qualified**: only whole minutes are banked, and the checkpoint advances by exactly those
   *   minutes rather than to `now`, so the leftover seconds stay owed. A busy room settles on every
   *   join, leave and mute; truncating each time would quietly bleed minutes out of active calls.
   * - **Capped out**: the checkpoint still advances. Holding the time back instead would let a
   *   capped member accumulate an unbounded owed span and dump all of it into the next day.
   *
   * Time is credited to the day containing `now`. The checkpoint loop bounds any single span to a
   * minute, so at most a minute of a call spanning midnight lands on the wrong side of it.
   */
  const bankVoiceTime = db.transaction((guildId, userId, now = Date.now(), dailyCapMinutes = Infinity) => {
    const row = getVoiceRowStmt.get(guildId, userId);
    if (!row) return 0;
    if (!row.qualified) {
      advanceVoiceCheckpointStmt.run(now, guildId, userId);
      return 0;
    }
    const minutes = Math.floor(Math.max(0, now - row.last_checkpoint_at) / 60_000);
    if (minutes <= 0) return 0;
    const credited = creditVoice(guildId, userId, minutes, dailyCapMinutes, now);
    advanceVoiceCheckpointStmt.run(row.last_checkpoint_at + minutes * 60_000, guildId, userId);
    return credited;
  });

  const recoveredSessions = recoverStaleSessions();
  if (recoveredSessions) {
    console.log(`Recovered ${recoveredSessions} session(s) left open by a previous unclean shutdown.`);
  }

  // Voice rows left by an unclean exit are dropped rather than closed. Whole minutes were already
  // banked at the last checkpoint, what is left is the sub-minute remainder, and the bot has no
  // idea whether anyone stayed in the channel while it was down. Anyone still in voice is picked
  // up again when occupancy is read on ready.
  const staleVoiceRows = db.prepare('DELETE FROM active_voice').run().changes;
  if (staleVoiceRows) {
    console.log(`Dropped ${staleVoiceRows} voice row(s) left by a previous unclean shutdown.`);
  }

  return {
    recoverStaleSessions,
    getTotalSeconds: (guildId, userId) => getStats.get(guildId, userId)?.total_seconds ?? 0,
    getPlayerProfile(guildId, userId, now = Date.now(), topGamesLimit = 3) {
      const active = getSession.get(guildId, userId);
      const activeSeconds = unbankedSeconds(active, now);
      const totalSeconds = (getStats.get(guildId, userId)?.total_seconds ?? 0) + activeSeconds;
      const nowDate = new Date(now);
      const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
      const monthSeconds = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN ended_at > ? THEN
          CAST((MIN(ended_at, ?) - MAX(started_at, ?)) / 1000 AS INTEGER)
          ELSE 0 END), 0) AS total_seconds
        FROM play_sessions WHERE guild_id = ? AND user_id = ?
      `).get(monthStart, now, monthStart, guildId, userId).total_seconds
        + (active ? Math.floor(Math.min(activeElapsedMs(active, now), now - monthStart) / 1000) : 0);
      const topGames = db.prepare(`
		SELECT game_name, SUM(total_seconds) AS total_seconds
		FROM (
			SELECT game_name, total_seconds
			FROM game_stats
			WHERE guild_id = ? AND user_id = ?

		UNION ALL

			SELECT game_name,
			CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER)
			FROM active_sessions
			WHERE guild_id = ? AND user_id = ?
			)
		GROUP BY game_name
		ORDER BY total_seconds DESC
		LIMIT ${Math.max(1, Math.floor(topGamesLimit))}
`).all(guildId, userId, now, guildId, userId);
      const longest = db.prepare(`
        SELECT MAX(duration_seconds) AS duration_seconds FROM play_sessions WHERE guild_id = ? AND user_id = ?
      `).get(guildId, userId).duration_seconds ?? 0;
      const activeDuration = active ? Math.floor(activeElapsedMs(active, now) / 1000) : 0;
      const gamesPlayed = db.prepare(`
        SELECT COUNT(DISTINCT game_name) AS count FROM (
          SELECT game_name FROM game_stats WHERE guild_id = ? AND user_id = ?
          UNION SELECT game_name FROM active_sessions WHERE guild_id = ? AND user_id = ?
        )
      `).get(guildId, userId, guildId, userId).count;
      return {
        totalSeconds,
        monthSeconds,
        topGames,
        longestSeconds: Math.max(longest, activeDuration),
        gamesPlayed,
      };
    },
    getServerProfile(guildId, now = Date.now(), topPlayersLimit = 3) {
      const activeSeconds = db.prepare(`
        SELECT COALESCE(SUM(CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER)), 0) AS total_seconds
        FROM active_sessions WHERE guild_id = ?
      `).get(now, guildId).total_seconds;
      const totalSeconds = (db.prepare(`
        SELECT COALESCE(SUM(total_seconds), 0) AS total_seconds FROM member_stats WHERE guild_id = ?
      `).get(guildId).total_seconds) + activeSeconds;
      const trackedPlayers = countTrackedPlayersStmt.get(guildId, guildId).count;
      const topGames = db.prepare(`
		SELECT game_name, SUM(total_seconds) AS total_seconds
		FROM (
			SELECT game_name, total_seconds
			FROM game_stats
			WHERE guild_id = ?

			UNION ALL

			SELECT game_name,
				CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER)
			FROM active_sessions
			WHERE guild_id = ?
		)
		GROUP BY game_name
		ORDER BY total_seconds DESC
		LIMIT 3
		`).all(guildId, now, guildId);
      const topPlayers = db.prepare(`
        SELECT user_id, SUM(total_seconds) AS total_seconds FROM (
          SELECT user_id, total_seconds FROM member_stats
          WHERE guild_id = ? AND ${NOT_OPTED_OUT('member_stats')}
          UNION ALL
          SELECT user_id, CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER)
          FROM active_sessions WHERE guild_id = ? AND ${NOT_OPTED_OUT('active_sessions')}
        ) GROUP BY user_id ORDER BY total_seconds DESC LIMIT ?
      `).all(guildId, now, guildId, Math.max(1, Math.floor(topPlayersLimit)));
      const gamesTracked = db.prepare(`
        SELECT COUNT(DISTINCT game_name) AS count FROM (
          SELECT game_name FROM game_stats WHERE guild_id = ?
          UNION SELECT game_name FROM active_sessions WHERE guild_id = ?
        )
      `).get(guildId, guildId).count;
      return { trackedPlayers, totalSeconds, topGames, topPlayers, gamesTracked };
    },
    getNotificationChannel: (guildId) => getNotificationChannel.get(guildId)?.notification_channel_id ?? null,
    setNotificationChannel: (guildId, channelId) => setNotificationChannel.run(guildId, channelId),
    getLastAnnouncedRelease: (guildId) => getLastAnnouncedRelease.get(guildId)?.last_announced_release_id ?? null,
    setLastAnnouncedRelease: (guildId, releaseId) => setLastAnnouncedRelease.run(guildId, String(releaseId)),
    getRankRoles: (guildId) => getRankRoles.all(guildId),
    saveRankRole: (guildId, rankIndex, roleId) => saveRankRole.run(guildId, rankIndex, roleId),
    getLeaderboard: (guildId, limit = 10) => getLeaderboardStmt.all(guildId, limit),
    getMonthlyLeaderboard: (guildId, monthStart, now = Date.now(), limit = 10) =>
      getMonthlyLeaderboardStmt.all(
        monthStart, now, monthStart, guildId,
        now, now, now, monthStart, guildId,
        limit,
      ),
    startSession(guildId, userId, gameName, now = Date.now()) {
      const existing = getSession.get(guildId, userId);
      if (existing?.game_name === gameName) return { changed: false, previous: null };
      const previous = closeSession(guildId, userId, now);
      createSession.run(guildId, userId, gameName, now, now);
      return { changed: true, previous };
    },
    stopSession: (guildId, userId, now = Date.now()) => closeSession(guildId, userId, now),
    // Paused (idle) sessions are skipped outright: their clock stopped when they paused, so they
    // accrue nothing and their checkpoint stays put until the member comes back.
    checkpointAll(now = Date.now()) {
      const sessions = db.prepare('SELECT guild_id, user_id FROM active_sessions WHERE paused_at IS NULL').all();
      for (const session of sessions) {
        const active = getSession.get(session.guild_id, session.user_id);
        const seconds = Math.max(0, Math.floor((now - active.last_checkpoint_at) / 1000));
        if (seconds) {
          addTime.run(session.guild_id, session.user_id, seconds);
          addGameSeconds.run(session.guild_id, session.user_id, active.game_name, seconds);
        }
        resetSessionCheckpoint.run(now, session.guild_id, session.user_id);
        session.elapsed_seconds = seconds;
        session.game_name = active.game_name;
        session.started_at = active.started_at;
        session.paused_ms = active.paused_seconds * 1000;
      }
      return sessions;
    },

    /**
     * Stops the clock on a member's session without ending it, banking everything owed up to now.
     * Returns false when there is nothing to do, so callers can skip the work a real change implies.
     */
    pauseSession(guildId, userId, now = Date.now()) {
      const session = getSession.get(guildId, userId);
      if (!session || session.paused_at) return false;
      const seconds = Math.max(0, Math.floor((now - session.last_checkpoint_at) / 1000));
      if (seconds) {
        addTime.run(guildId, userId, seconds);
        addGameSeconds.run(guildId, userId, session.game_name, seconds);
      }
      markSessionPaused.run(now, now, guildId, userId);
      return true;
    },

    /** Restarts the clock, adding the idle stretch to paused_seconds so it is never credited. */
    resumeSession(guildId, userId, now = Date.now()) {
      const session = getSession.get(guildId, userId);
      if (!session || !session.paused_at) return false;
      const pausedSeconds = Math.max(0, Math.floor((now - session.paused_at) / 1000));
      markSessionResumed.run(pausedSeconds, now, guildId, userId);
      return true;
    },

    isSessionPaused: (guildId, userId) => !!getSession.get(guildId, userId)?.paused_at,

    /**
     * Hard cap. Closes any session whose *active* time has run past the limit, which is the only
     * defence against a member who never goes idle (a jiggler, or a client that just never reports
     * it). Returns the closed sessions so the caller can still run end-of-session achievements.
     *
     * The row is written at the cap, not the raw span — see `closeSession`'s `capSeconds` param.
     * Whatever ran over comes back as `completed.excessSeconds`, and the cap it was measured
     * against comes back beside it, so the caller never re-derives it from `maxActiveMs` and the
     * two can't drift apart. This function does not itself touch game_stats/member_stats, so
     * clawing that part back is the caller's job (see `clawBackSessionCap` in adjustments.js).
     */
    closeSessionsExceeding(maxActiveMs, now = Date.now()) {
      const capSeconds = Math.floor(maxActiveMs / 1000);
      const closed = [];
      for (const row of db.prepare('SELECT guild_id, user_id FROM active_sessions').all()) {
        const session = getSession.get(row.guild_id, row.user_id);
        if (!session || activeElapsedMs(session, now) < maxActiveMs) continue;
        const completed = closeSession(row.guild_id, row.user_id, now, capSeconds);
        if (completed) closed.push({ guildId: row.guild_id, userId: row.user_id, completed, capSeconds });
      }
      return closed;
    },
    flushAll(now = Date.now()) {
      const sessions = db.prepare('SELECT guild_id, user_id FROM active_sessions').all();
      for (const session of sessions) closeSession(session.guild_id, session.user_id, now);
      return sessions;
    },
    close: () => db.close(),
    /**
     * SQLite's online backup API, not a file copy. It produces one consistent file while the bot
     * keeps writing — a plain copy of the .sqlite/-wal/-shm trio can catch a checkpoint mid-commit.
     */
    backup: (destination) => db.backup(destination),

    // ---- Manual corrections ------------------------------------------------------------------
    // The only writes in this module that can lower a total. Both keep member_stats and game_stats
    // moving by the same amount so the two cannot drift apart, and both run in a transaction
    // because a half-applied correction is worse than none.

    /**
     * Adds (or, with a negative delta, removes) time on one game.
     *
     * A subtraction is bounded by what that game actually holds: asking to remove two hours from a
     * game with forty minutes on it removes forty minutes, not two hours, because the rest was
     * never this game's to give. The same clamped amount comes off member_stats, and the caller is
     * told what was really applied so it can say so rather than silently doing less than asked.
     *
     * Note member_stats can legitimately exceed the sum of game_stats — per-game recording arrived
     * later than the running totals — so the member total is never used to bound an addition.
     */
    adjustPlaytime: db.transaction((guildId, userId, gameName, deltaSeconds) => {
      const game = getGameStatsRow.get(guildId, userId, gameName) ?? { total_seconds: 0, session_count: 0 };
      const totalBefore = getStats.get(guildId, userId)?.total_seconds ?? 0;
      const applied = deltaSeconds < 0
        ? -Math.min(-deltaSeconds, game.total_seconds, totalBefore)
        : deltaSeconds;
      const gameAfter = game.total_seconds + applied;
      const totalAfter = totalBefore + applied;
      // A game with no time and no sessions left is not in the member's collection any more, and
      // leaving an empty row behind would keep it counted by /stats' games-played tally.
      if (gameAfter === 0 && game.session_count === 0) removeGameStatsRow.run(guildId, userId, gameName);
      else setGameStatsRow.run(guildId, userId, gameName, gameAfter, game.session_count);
      setMemberTotal.run(guildId, userId, totalAfter);
      return { requestedSeconds: deltaSeconds, appliedSeconds: applied, totalBefore, totalAfter, gameAfter };
    }),

    getPlaySession: (sessionId) => getPlaySessionStmt.get(sessionId) ?? null,
    /** Game names this member has on record, most-played first — the source for /adjust's picker. */
    getMemberGameNames: (guildId, userId, limit = 25) =>
      getMemberGameNamesStmt.all(guildId, userId, guildId, userId, limit).map((row) => row.game_name),
    getGuildGameNames: (guildId, limit = 25) =>
      getGuildGameNamesStmt.all(guildId, guildId, limit).map((row) => row.game_name),
    getRecentSessions: (guildId, userId, limit = 25) => getRecentSessionsStmt.all(guildId, userId, limit),
    /** Completed sessions, newest first. `userId` null means the whole guild. */
    getSessionLog: (guildId, userId = null, limit = 10) =>
      getSessionLogStmt.all(guildId, userId, userId, limit),
    /**
     * Sessions in flight right now, carrying the same idle-adjusted elapsed time that will be
     * written to `play_sessions` when they close — so a running row can never show a number the
     * completed row then contradicts. A paused session reports the time it had when it went idle.
     */
    getRunningSessions: (guildId, userId = null, limit = 10, now = Date.now()) =>
      getRunningSessionsStmt.all(guildId, userId, userId, limit).map((session) => ({
        userId: session.user_id,
        gameName: session.game_name,
        startedAt: session.started_at,
        pausedAt: session.paused_at,
        elapsedSeconds: Math.floor(activeElapsedMs(session, now) / 1000),
      })),

    /**
     * Voids one completed session: the history row goes, and the time and the session tally it
     * contributed come back out of both stat tables.
     *
     * `guildId` is checked against the row rather than trusted, because play_sessions ids are a
     * single global sequence — without it an admin in one guild could void a session in another by
     * naming its id. Returns null when the id does not exist or belongs elsewhere.
     */
    deletePlaySession: db.transaction((guildId, sessionId) => {
      const row = getPlaySessionStmt.get(sessionId);
      if (!row || row.guild_id !== guildId) return null;
      const game = getGameStatsRow.get(guildId, row.user_id, row.game_name) ?? { total_seconds: 0, session_count: 0 };
      const totalBefore = getStats.get(guildId, row.user_id)?.total_seconds ?? 0;
      const applied = -Math.min(row.duration_seconds, game.total_seconds, totalBefore);
      const gameAfter = game.total_seconds + applied;
      const sessionsAfter = Math.max(0, game.session_count - 1);
      const totalAfter = totalBefore + applied;
      if (gameAfter === 0 && sessionsAfter === 0) removeGameStatsRow.run(guildId, row.user_id, row.game_name);
      else setGameStatsRow.run(guildId, row.user_id, row.game_name, gameAfter, sessionsAfter);
      setMemberTotal.run(guildId, row.user_id, totalAfter);
      removePlaySession.run(sessionId);
      return { session: row, appliedSeconds: applied, totalBefore, totalAfter, gameAfter };
    }),

    /**
     * Folds every trace of one game name into another, for the whole guild.
     *
     * `game_stats` is keyed on whatever string Rich Presence reported, so an upstream rename or a
     * variant spelling splits one game's history across two rows — which costs the per-game
     * milestones on a game genuinely played, and inflates the distinct-game count that feeds the
     * collection ladder and the server library tiers.
     *
     * **No time is created or destroyed.** `member_stats` is not touched at all: this moves rows
     * between game names, so every member's total, rank and standing are exactly what they were.
     * That is what makes it safe to run guild-wide without a per-member clamp — unlike
     * `adjustPlaytime` and `deletePlaySession`, there is no amount here to get wrong.
     *
     * **`play_sessions` and `active_sessions` move too, not just the aggregates.** Leaving the
     * history behind would be a half-merge: the longest-session record, the day-count queries and
     * the session picker all read `play_sessions.game_name`, so the dead name would keep surfacing
     * in exactly the places the merge was meant to clean up, and the game would still count twice
     * in "games played today". The cost is that first-and-last-played for the surviving name shift
     * to cover the older history, which is what those dates now honestly describe.
     *
     * Deliberately **not** rewritten: `events.game_name`, which is text a member typed for a game
     * night rather than a tracked stat, and `stat_adjustments`, which records what was done at the
     * time and is never edited.
     *
     * Returns null when nothing is recorded under `fromName`, or when the two names are equal.
     */
    mergeGameNames: db.transaction((guildId, fromName, intoName) => {
      if (fromName === intoName) return null;
      const holders = getGameHoldersStmt.all(guildId, fromName, guildId, fromName, guildId, fromName);
      if (!holders.length) return null;
      const intoExisted = countGameStatsRowsStmt.get(guildId, intoName).n > 0;
      for (const holder of holders) {
        if (holder.total_seconds || holder.session_count) {
          foldGameStatsStmt.run(guildId, holder.user_id, intoName, holder.total_seconds, holder.session_count);
        }
      }
      removeGameStatsByNameStmt.run(guildId, fromName);
      const sessionsMoved = renamePlaySessionsStmt.run(intoName, guildId, fromName).changes;
      const activeMoved = renameActiveSessionsStmt.run(intoName, guildId, fromName).changes;
      return {
        fromName,
        intoName,
        intoExisted,
        sessionsMoved,
        activeMoved,
        members: holders.map((holder) => ({
          userId: holder.user_id,
          movedSeconds: holder.total_seconds,
          movedSessionCount: holder.session_count,
        })),
        intoTotalSeconds: sumGameSecondsStmt.get(guildId, intoName).total_seconds,
      };
    }),

    // ---- Social minutes ----------------------------------------------------------------------

    /**
     * Marks the minute containing `now` as text-active. Returns true when this bought a new
     * minute, false when an earlier message in the same minute already did — so ten messages in
     * one minute is one minute, and the caller needs no read of its own to know which happened.
     */
    recordTextMinute: (guildId, userId, now = Date.now()) =>
      recordTextMinuteStmt.run(guildId, userId, socialDayKey(now), epochMinute(now)).changes === 1,

    /**
     * Credits voice minutes to the day containing `now`, clamped to `dailyCapMinutes`, returning
     * how many actually landed — fewer than asked for once the cap is reached, zero once it is met.
     *
     * Read-clamp-write in one transaction, the same shape the manual corrections use, rather than
     * a clever single statement: the cap applies to the day's running total, not to this one
     * credit. The cap bounds the damage from two members idling together in a channel, which the
     * qualification gate cannot see; it is not a correctness mechanism.
     *
     * Prefer `bankVoiceTime` — it derives the amount from a real elapsed span instead of trusting
     * a caller's arithmetic. This is exposed for tests and for seeding.
     */
    creditVoiceMinutes: db.transaction(creditVoice),

    // ---- Voice presence ----------------------------------------------------------------------

    getVoiceRow: (guildId, userId) => getVoiceRowStmt.get(guildId, userId) ?? null,
    /** How many members are in voice here, and how many of them are actually earning. */
    getVoiceCounts: (guildId) => db.prepare(
      'SELECT COUNT(*) AS present, COALESCE(SUM(qualified), 0) AS counting FROM active_voice WHERE guild_id = ?',
    ).get(guildId),
    getVoiceRowsForChannel: (guildId, channelId) => getVoiceRowsForChannelStmt.all(guildId, channelId),
    getAllVoiceRows: () => getAllVoiceRowsStmt.all(),

    /**
     * Records where a member is and whether their clock should be running.
     *
     * A member already on record keeps their `last_checkpoint_at`, because it is carrying the
     * seconds they are still owed; only a genuinely new arrival starts the clock at `now`.
     */
    setVoiceState: db.transaction((guildId, userId, channelId, qualified, now = Date.now()) => {
      const flag = qualified ? 1 : 0;
      if (getVoiceRowStmt.get(guildId, userId)) setVoiceQualifiedStmt.run(channelId, flag, guildId, userId);
      else upsertVoiceRowStmt.run(guildId, userId, channelId, flag, now);
    }),

    clearVoiceRow: (guildId, userId) => deleteVoiceRowStmt.run(guildId, userId).changes === 1,

    bankVoiceTime,

    /**
     * Banks everything owed and empties the table, for a clean shutdown. The mirror of what
     * `flushAll` does for game sessions: stopping deliberately should not cost anyone their
     * minutes, and every row is settled as of this moment because the bot knows it is stopping now.
     */
    flushVoice: db.transaction((now = Date.now(), dailyCapMinutes = Infinity) => {
      let credited = 0;
      for (const row of getAllVoiceRowsStmt.all()) {
        credited += bankVoiceTime(row.guild_id, row.user_id, now, dailyCapMinutes);
        deleteVoiceRowStmt.run(row.guild_id, row.user_id);
      }
      return credited;
    }),

    /** One member's own totals over a window. Unfiltered — their record is theirs to see. */
    getSocialTotals(guildId, userId, fromMs, toMs) {
      const { fromDay, toDay } = windowDays(fromMs, toMs);
      return getSocialTotalsStmt.get(guildId, userId, fromDay, toDay);
    },

    /**
     * Ranked candidates for one badge over a window, opted-out members hidden.
     *
     * Deliberately returns candidates rather than a winner, and applies no minimum: the award pass
     * walks this list applying the floor and the one-badge-per-member rule together. Splitting
     * those rules between SQL and JS is how a crown ends up handed to someone who should have been
     * skipped. Over-fetch, as the existing leaderboards do, so pass-down has somewhere to go.
     */
    getSocialLeaderboard(guildId, fromMs, toMs, metric, limit) {
      const statement = socialLeaderboardStmts[metric];
      if (!statement) throw new Error(`Unknown social metric "${metric}" — expected ${SOCIAL_METRICS.join(' or ')}.`);
      const { fromDay, toDay } = windowDays(fromMs, toMs);
      return statement.all(guildId, fromDay, toDay, limit);
    },

    /** The first day this member was active at all, or null if they never have been. */
    getFirstSocialDay: (guildId, userId) => getFirstSocialDayStmt.get(guildId, userId)?.day ?? null,

    /**
     * Everyone who played, typed or held a qualifying voice minute in a window, plus anyone
     * mid-session or in voice right now. Cave Dweller is awarded to the members who are *not* in
     * this set, so it is deliberately generous about what counts as having shown up.
     */
    getActiveMemberIds(guildId, fromMs, toMs) {
      const { fromDay, toDay } = windowDays(fromMs, toMs);
      return getActiveMemberIdsStmt
        .all(guildId, fromMs, toMs, guildId, fromDay, toDay, guildId, guildId)
        .map((row) => row.user_id);
    },

    getSocialTrackingStartedAt: (guildId) =>
      getSocialTrackingStartedAtStmt.get(guildId)?.social_tracking_started_at ?? null,

    /**
     * Records when social tracking first ran for this guild, if it has not been recorded already.
     * The first call wins: moving the floor later would reset everyone's silence to zero and hand
     * out fresh titles on every restart.
     */
    markSocialTrackingStarted(guildId, now = Date.now()) {
      setSocialTrackingStartedAtStmt.run(guildId, now);
      return this.getSocialTrackingStartedAt(guildId);
    },

    // ---- Opt-out and erasure -----------------------------------------------------------------

    isOptedOut: (guildId, userId) => !!isOptedOutStmt.get(guildId, userId),
    getOptOutAt: (guildId, userId) => getOptOutStmt.get(guildId, userId)?.opted_out_at ?? null,
    /** Also closes any session in flight, so the minutes since the last checkpoint are not banked later. */
    optOut: db.transaction((guildId, userId, now = Date.now()) => {
      const closed = closeSession(guildId, userId, now);
      // The voice row goes the same way and for the same reason: left in place, the next settle
      // would credit minutes accrued after the member had already asked to stop being recorded.
      // What is dropped with it is the sub-minute remainder the row was carrying, exactly as an
      // unclean exit drops it — whole minutes were banked at the last checkpoint.
      deleteVoiceRowStmt.run(guildId, userId);
      setOptedOutStmt.run(guildId, userId, now);
      return closed;
    }),
    optIn: (guildId, userId) => clearOptedOutStmt.run(guildId, userId).changes === 1,

    /** What this member has on record, for the /privacy status view. Counts only — never contents. */
    getStoredDataSummary(guildId, userId) {
      const count = (sql, ...params) => db.prepare(sql).get(guildId, userId, ...params).n;
      return {
        totalSeconds: getStats.get(guildId, userId)?.total_seconds ?? 0,
        games: count('SELECT COUNT(*) AS n FROM game_stats WHERE guild_id = ? AND user_id = ?'),
        sessions: count('SELECT COUNT(*) AS n FROM play_sessions WHERE guild_id = ? AND user_id = ?'),
        achievements: count('SELECT COUNT(*) AS n FROM achievements_unlocked WHERE guild_id = ? AND user_id = ?'),
        activeSession: !!getSession.get(guildId, userId),
        // A pair table, so this is also the number of other members whose duo count would drop.
        duoPartners: db.prepare(`
          SELECT COUNT(DISTINCT partner) AS n FROM (
            SELECT user_id_b AS partner FROM duo_days WHERE guild_id = ? AND user_id_a = ?
            UNION SELECT user_id_a FROM duo_days WHERE guild_id = ? AND user_id_b = ?
          )
        `).get(guildId, userId, guildId, userId).n,
        eventSignups: db.prepare(`
          SELECT COUNT(*) AS n FROM event_signups s JOIN events e ON e.id = s.event_id
          WHERE e.guild_id = ? AND s.user_id = ?
        `).get(guildId, userId).n,
        eventsCreated: count('SELECT COUNT(*) AS n FROM events WHERE guild_id = ? AND creator_id = ?'),
        corrections: count('SELECT COUNT(*) AS n FROM stat_adjustments WHERE guild_id = ? AND user_id = ?'),
        recapWins: count('SELECT COUNT(*) AS n FROM recap_winners WHERE guild_id = ? AND user_id = ?'),
        // All time rather than the current period: this answers "what do you hold about me",
        // which is not the same question the badges ask.
        social: db.prepare(`
          SELECT COALESCE(SUM(text_minutes), 0) AS text_minutes,
                 COALESCE(SUM(voice_minutes), 0) AS voice_minutes, COUNT(*) AS days
          FROM social_days WHERE guild_id = ? AND user_id = ?
        `).get(guildId, userId),
        inVoice: !!getVoiceRowStmt.get(guildId, userId),
      };
    },

    /**
     * Erases everything this bot holds about one member of one guild. Irreversible by design —
     * the only way back is a backup.
     *
     * Two things are deliberately not simple deletes. `duo_days` is a *pair* table, so removing
     * these rows also lowers the co-op day count of everyone they played alongside; that is
     * unavoidable and is disclosed before the member confirms. And `stat_adjustments` rows where
     * they were the *actor* are kept but anonymised rather than dropped: those rows document a
     * change made to somebody else's totals, which is that other member's record, not this one's.
     */
    purgeMember: db.transaction((guildId, userId) => {
      const removed = {};
      const run = (label, sql, ...params) => { removed[label] = db.prepare(sql).run(guildId, userId, ...params).changes; };
      run('activeSessions', 'DELETE FROM active_sessions WHERE guild_id = ? AND user_id = ?');
      run('sessions', 'DELETE FROM play_sessions WHERE guild_id = ? AND user_id = ?');
      run('games', 'DELETE FROM game_stats WHERE guild_id = ? AND user_id = ?');
      run('achievements', 'DELETE FROM achievements_unlocked WHERE guild_id = ? AND user_id = ?');
      run('stats', 'DELETE FROM member_stats WHERE guild_id = ? AND user_id = ?');
      run('corrections', 'DELETE FROM stat_adjustments WHERE guild_id = ? AND user_id = ?');
      // Nothing in a social day row documents anyone else's action, so it is a plain delete —
      // no anonymising, and no pair-table side effect on another member's count.
      run('socialDays', 'DELETE FROM social_days WHERE guild_id = ? AND user_id = ?');
      run('activeVoice', 'DELETE FROM active_voice WHERE guild_id = ? AND user_id = ?');
      // A plain delete, unlike the events and corrections below: a badge documents what this member
      // did, not something anybody else did to them, so there is nothing here belonging to a second
      // person that anonymising would preserve. The period simply loses its named holder.
      run('recapWins', 'DELETE FROM recap_winners WHERE guild_id = ? AND user_id = ?');
      removed.duoDays = db.prepare(
        'DELETE FROM duo_days WHERE guild_id = ? AND (user_id_a = ? OR user_id_b = ?)',
      ).run(guildId, userId, userId).changes;
      removed.eventSignups = db.prepare(`
        DELETE FROM event_signups WHERE user_id = ?
        AND event_id IN (SELECT id FROM events WHERE guild_id = ?)
      `).run(userId, guildId).changes;
      db.prepare("UPDATE stat_adjustments SET actor_id = '0' WHERE guild_id = ? AND actor_id = ?").run(guildId, userId);
      // Events they created are anonymised rather than deleted: an upcoming game night belongs to
      // everyone who signed up for it, and cancelling other people's plans is not what erasing
      // one member's data should mean. Manage Server can still edit or cancel it afterwards.
      removed.eventsAnonymised = db.prepare(
        "UPDATE events SET creator_id = '0' WHERE guild_id = ? AND creator_id = ?",
      ).run(guildId, userId).changes;
      // `tracking_optouts` is deliberately left alone. Erasing is about the data already held, not
      // about consent going forward: somebody who opted out and then erased wants to stay
      // untracked, and clearing the row here would quietly switch recording back on for them.
      return removed;
    }),

    recordAdjustment: ({
      guildId, userId, actorId, kind, gameName = null, mergedInto = null, deltaSeconds, sessionId = null, reason = null,
    }, now = Date.now()) =>
      recordAdjustmentStmt.run(guildId, userId, actorId, kind, gameName, mergedInto, deltaSeconds, sessionId, reason, now).lastInsertRowid,
    /** `userId` of null returns the whole guild's corrections rather than one member's. */
    getAdjustments: (guildId, userId = null, limit = 10) => getAdjustmentsStmt.all(guildId, userId, userId, limit),

    // Achievements
    hasAchievement: (guildId, userId, achievementId) => !!hasAchievementStmt.get(guildId, userId, achievementId),
    unlockAchievement: (guildId, userId, achievementId, now = Date.now()) =>
      unlockAchievementStmt.run(guildId, userId, achievementId, now).changes === 1,
    getPlayerAchievements: (guildId, userId) => getPlayerAchievementsStmt.all(guildId, userId),
    getAchievementUnlockCount: (guildId, achievementId) => getAchievementUnlockCountStmt.get(guildId, achievementId).count,
    getTrackedPlayerCount: (guildId) => countTrackedPlayersStmt.get(guildId, guildId).count,
    getSubstantialGameCount: (guildId, userId, minSeconds) =>
      getSubstantialGameCountStmt.get(guildId, userId, minSeconds).count,
    getGameSecondsSince: (guildId, userId, sinceMs) => getGameSecondsSinceStmt.all(guildId, userId, sinceMs),
    getGameStartCountSince: (guildId, userId, gameName, sinceMs) =>
      getGameStartCountSinceStmt.get(guildId, userId, gameName, sinceMs, guildId, userId, gameName, sinceMs).count,
    getLastCompletedSession: (guildId, userId) => getLastCompletedSessionStmt.get(guildId, userId) ?? null,
    getQualifyingSessionCountToday: (guildId, userId, gameName, dayStartMs, minDurationSeconds) =>
      getQualifyingSessionCountTodayStmt.get(guildId, userId, gameName, dayStartMs, minDurationSeconds).count,
    getDistinctDaysForGame: (guildId, userId, gameName) =>
      getDistinctDaysForGameStmt.get(guildId, userId, gameName, guildId, userId, gameName).count,
    getDistinctDaysAnyGame: (guildId, userId) => getDistinctDaysAnyGameStmt.get(guildId, userId, guildId, userId).count,
    getPlayDates: (guildId, userId) => getPlayDatesStmt.all(guildId, userId, guildId, userId).map((row) => row.day),
    getLastSessionEndForGame: (guildId, userId, gameName) =>
      getLastSessionEndForGameStmt.get(guildId, userId, gameName).ended_at ?? null,
    getShortGameCountToday: (guildId, userId, sinceMs, underSeconds) =>
      getShortGameCountTodayStmt.get(guildId, userId, sinceMs, underSeconds).count,
    getActiveUsersForGame: (guildId, gameName) => getActiveUsersForGameStmt.all(guildId, gameName),
    getInactivePlayers: (guildId, cutoffMs) => getInactivePlayersStmt.all(guildId, guildId, cutoffMs),
    hasGameBeenPlayedBefore: (guildId, gameName, currentUserId) =>
      !!getGameHistoryStmt.get(guildId, gameName, guildId, gameName, guildId, gameName, currentUserId),
    getLastSessionEndAny: (guildId, userId) => getLastSessionEndAnyStmt.get(guildId, userId).ended_at ?? null,
    getGameStatsTotal: (guildId, userId, gameName) => getGameStatsTotalStmt.get(guildId, userId, gameName)?.total_seconds ?? 0,
    getGameSessionCount: (guildId, userId, gameName) => getGameSessionCountStmt.get(guildId, userId, gameName)?.session_count ?? 0,

    // Monthly recap. All three clamp sessions to the window so a session straddling the month
    // boundary only counts the part that actually falls inside it, matching getMonthlyLeaderboard.
    getMonthlyTopGame: (guildId, userId, fromMs, toMs) => db.prepare(`
      SELECT game_name, SUM(CAST((MIN(ended_at, ?) - MAX(started_at, ?)) / 1000 AS INTEGER)) AS total_seconds
      FROM play_sessions
      WHERE guild_id = ? AND user_id = ? AND ended_at > ? AND started_at < ?
      GROUP BY game_name HAVING total_seconds > 0
      ORDER BY total_seconds DESC LIMIT 1
    `).get(toMs, fromMs, guildId, userId, fromMs, toMs) ?? null,
    getMonthlyGameCount: (guildId, userId, fromMs, toMs) => db.prepare(`
      SELECT COUNT(DISTINCT game_name) AS count FROM play_sessions
      WHERE guild_id = ? AND user_id = ? AND ended_at > ? AND started_at < ?
    `).get(guildId, userId, fromMs, toMs).count,
    getAchievementsUnlockedBetween: (guildId, userId, fromMs, toMs) => db.prepare(`
      SELECT achievement_id FROM achievements_unlocked
      WHERE guild_id = ? AND user_id = ? AND unlocked_at >= ? AND unlocked_at < ?
      ORDER BY unlocked_at
    `).all(guildId, userId, fromMs, toMs).map((row) => row.achievement_id),
    getLastMonthlyRecap: (guildId) => getLastMonthlyRecapStmt.get(guildId)?.last_monthly_recap ?? null,
    setLastMonthlyRecap: (guildId, monthKey) => setLastMonthlyRecapStmt.run(guildId, monthKey),

    // ---- Recap winners -----------------------------------------------------------------------

    /** Records one badge for one period. Re-recording the same period and badge corrects it. */
    recordRecapWinner: ({ guildId, periodKey, badge, userId, metricSeconds = 0 }, now = Date.now()) =>
      recordRecapWinnerStmt.run(guildId, periodKey, badge, userId, Math.max(0, Math.round(metricSeconds)), now).changes,
    /** Every badge this member has ever taken, as `{ <badge>: wins }`. Absent badges are omitted. */
    getRecapWinCounts: (guildId, userId) => Object.fromEntries(
      getRecapWinCountsStmt.all(guildId, userId).map((row) => [row.badge, row.wins]),
    ),
    /** `excludePeriodKey` leaves that one period out, so a re-run counts the same as a first run. */
    getRecapWinCount: (guildId, userId, badge, excludePeriodKey = null) =>
      getRecapWinCountStmt.get(guildId, userId, badge, excludePeriodKey, excludePeriodKey).wins,
    getHallOfFame: (guildId, limit = 5) => getHallOfFameStmt.all(guildId, limit),
    getRecapWinnersForPeriod: (guildId, periodKey) => getRecapWinnersForPeriodStmt.all(guildId, periodKey),
    recordDuoDay: (guildId, userIdA, userIdB, day) => recordDuoDayStmt.run(guildId, userIdA, userIdB, day),
    getDuoDayCount: (guildId, userIdA, userIdB) => getDuoDayCountStmt.get(guildId, userIdA, userIdB).count,

    hasServerAchievement: (guildId, achievementId) => !!hasServerAchievementStmt.get(guildId, achievementId),
    unlockServerAchievement: (guildId, achievementId, now = Date.now()) =>
      unlockServerAchievementStmt.run(guildId, achievementId, now).changes === 1,
    getServerAchievements: (guildId) => getServerAchievementsStmt.all(guildId),
    getGuildGameCount: (guildId, minSeconds) => getGuildGameCountStmt.get(guildId, minSeconds).count,
    getGuildTotalSeconds: (guildId, now = Date.now()) =>
      getGuildBaseSecondsStmt.get(guildId).total_seconds + getGuildActiveSecondsStmt.get(now, guildId).total_seconds,
    getTopGameByHours: (guildId, now = Date.now()) => getTopGameByHoursStmt.get(guildId, now, guildId) ?? null,
    getTopGameByPlayerCount: (guildId, minSeconds) => getTopGameByPlayerCountStmt.get(guildId, minSeconds) ?? null,
    /**
     * The "server records" shown on the /server card. Every field is independently nullable:
     * a brand-new server has none of them, and a server with play but no game past `minSeconds`
     * has a longest session but no collector. Callers render only what came back.
     */
    getServerRecords(guildId, minSeconds) {
      return {
        longestSession: getLongestSessionStmt.get(guildId) ?? null,
        topGameByPlayers: getTopGameByPlayerCountStmt.get(guildId, minSeconds) ?? null,
        topCollector: getTopCollectorStmt.get(guildId, minSeconds) ?? null,
      };
    },
    getSessionSpans: (guildId, sinceMs) => getSessionSpansStmt.all(guildId, sinceMs),
    getConcurrentGameCount: (guildId) => getConcurrentGameCountStmt.get(guildId).count,
    getActiveSessionCount: (guildId) => getActiveSessionCountStmt.get(guildId).count,
    /**
     * Cheap "is the file still there and readable" probe for /health. Deliberately not an
     * integrity check — `npm run db-check` is where the expensive verification lives.
     */
    ping() {
      try {
        db.prepare('SELECT 1').get();
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
    getPlayersAboveSeconds: (guildId, thresholdSeconds) => getPlayersAboveSecondsStmt.get(guildId, thresholdSeconds).count,
    getGuildGamesToday: (guildId, dayStartMs) => getGuildGamesTodayStmt.get(guildId, dayStartMs, guildId, dayStartMs).count,
    getGuildPlayDates: (guildId) => getGuildPlayDatesStmt.all(guildId, guildId).map((row) => row.day),
    getTotalAchievementUnlockCount: (guildId) => getTotalAchievementUnlockCountStmt.get(guildId).count,
    getAllMemberTotals: (guildId, now = Date.now()) => getAllMemberTotalsStmt.all(guildId, now, guildId),
    getQualifiedDuoPairCount: (guildId, daysNeeded) => getQualifiedDuoPairCountStmt.get(guildId, daysNeeded).count,

    createEvent: (guildId, channelId, creatorId, title, description, gameName, startsAt, now = Date.now(), repeatRule = null, timeZone = null) =>
      createEventStmt.run(guildId, channelId, creatorId, title, description, gameName, startsAt, now, repeatRule, timeZone).lastInsertRowid,
    getEvent: (eventId) => getEventStmt.get(eventId) ?? null,
    setEventMessageId: (eventId, messageId) => setEventMessageIdStmt.run(messageId, eventId),
    updateEvent(eventId, title, description, gameName, startsAt, repeatRule = null, timeZone = null) {
      const existing = getEventStmt.get(eventId);
      updateEventStmt.run(title, description, gameName, startsAt, repeatRule, timeZone, eventId);
      // Only reset which reminder stages have fired if the start time actually moved —
      // otherwise an already-sent reminder would immediately re-fire on the next tick.
      if (existing && existing.starts_at !== startsAt) deleteEventRemindersStmt.run(eventId);
    },
    deleteEvent(eventId) {
      const remove = db.transaction((id) => {
        deleteEventSignupsStmt.run(id);
        deleteEventRemindersStmt.run(id);
        deleteEventStmt.run(id);
      });
      remove(eventId);
    },
    upsertEventSignup: (eventId, userId, status) => upsertEventSignupStmt.run(eventId, userId, status),
    getEventSignups: (eventId) => getEventSignupsStmt.all(eventId),
    getPlayersForGame: (guildId, gameName, minSeconds) =>
      getPlayersForGameStmt.all(guildId, gameName, minSeconds).map((row) => row.user_id),
    getUpcomingEvents: (afterMs) => getUpcomingEventsStmt.all(afterMs),
    getUpcomingEventsForGuild: (guildId, afterMs, limit = 10) => getUpcomingEventsForGuildStmt.all(guildId, afterMs, limit),
    getStaleEvents: (beforeMs) => getStaleEventsStmt.all(beforeMs),
    getRecurringEventsDue: (beforeMs) => getRecurringEventsDueStmt.all(beforeMs),
    /**
     * Moves a recurring event on to its next occurrence, clearing the RSVPs and fired reminder
     * stages that belonged to the one just gone. Answers false when the row had already moved,
     * which is what makes a retry — or a second bot on the same token — harmless.
     */
    rollEventForward(eventId, fromStartsAt, nextStartsAt) {
      const roll = db.transaction(() => {
        if (!rollEventStmt.run(nextStartsAt, eventId, fromStartsAt).changes) return false;
        // Last week's "I'm in" is not an answer about next week, and a stage marked sent for the
        // occurrence that just passed would otherwise suppress the same stage for the next one.
        deleteEventSignupsStmt.run(eventId);
        deleteEventRemindersStmt.run(eventId);
        return true;
      });
      return roll();
    },
    clearEventRepeat: (eventId) => clearEventRepeatStmt.run(eventId),
    hasReminderSent: (eventId, stageMinutes) => !!hasReminderSentStmt.get(eventId, stageMinutes),
    getLastReminderSentAt: (eventId) => getLastReminderSentAtStmt.get(eventId).last ?? null,
    markReminderSent: (eventId, stageMinutes, now = Date.now()) => markReminderSentStmt.run(eventId, stageMinutes, now),
  };
}
