import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
      created_at INTEGER NOT NULL
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
  const eventColumns = db.prepare('PRAGMA table_info(events)').all();
  if (!eventColumns.some((column) => column.name === 'message_id')) {
    db.exec('ALTER TABLE events ADD COLUMN message_id TEXT');
  }
  db.exec('UPDATE active_sessions SET last_checkpoint_at = started_at WHERE last_checkpoint_at IS NULL');

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
  const getActiveUsersForGameStmt = db.prepare('SELECT user_id, started_at FROM active_sessions WHERE guild_id = ? AND game_name = ?');
  const getInactivePlayersStmt = db.prepare(`
    SELECT user_id, MAX(ended_at) AS last_ended FROM play_sessions
    WHERE guild_id = ? AND user_id NOT IN (SELECT user_id FROM active_sessions WHERE guild_id = ?)
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
  const getTopGameByHoursStmt = db.prepare(`
    SELECT game_name, SUM(total_seconds) AS total_seconds FROM (
      SELECT game_name, total_seconds FROM game_stats WHERE guild_id = ?
      UNION ALL
      SELECT game_name, CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER) FROM active_sessions WHERE guild_id = ?
    ) GROUP BY game_name ORDER BY total_seconds DESC LIMIT 1
  `);
  // Counts a member toward a game only once they personally have minSeconds in it, so a crowd that
  // all launched the same thing once does not read as a game the whole server plays.
  const getTopGameByPlayerCountStmt = db.prepare(`
    SELECT game_name, COUNT(DISTINCT user_id) AS players FROM game_stats
    WHERE guild_id = ? AND total_seconds >= ?
    GROUP BY game_name ORDER BY players DESC LIMIT 1
  `);
  // Server records. The longest session can only be read from play_sessions, so it reaches back
  // exactly as far as that table does and no further — on a database that predates it the record
  // starts from the migration, not from the server's first day. Nothing else here has that limit:
  // both game counts come from game_stats, which is cumulative.
  const getLongestSessionStmt = db.prepare(`
    SELECT user_id, game_name, duration_seconds FROM play_sessions
    WHERE guild_id = ? ORDER BY duration_seconds DESC LIMIT 1
  `);
  // Same minSeconds bar as the collection ladder, so "most games" here means the same thing it
  // means on a member's own card. Counting bare launches would let one busy evening beat a library.
  const getTopCollectorStmt = db.prepare(`
    SELECT user_id, COUNT(DISTINCT game_name) AS games FROM game_stats
    WHERE guild_id = ? AND total_seconds >= ?
    GROUP BY user_id ORDER BY games DESC LIMIT 1
  `);
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
    INSERT INTO events (guild_id, channel_id, creator_id, title, description, game_name, starts_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getEventStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const setEventMessageIdStmt = db.prepare('UPDATE events SET message_id = ? WHERE id = ?');
  const updateEventStmt = db.prepare(`
    UPDATE events SET title = ?, description = ?, game_name = ?, starts_at = ? WHERE id = ?
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
  const getStaleEventsStmt = db.prepare('SELECT * FROM events WHERE starts_at < ?');
  const hasReminderSentStmt = db.prepare('SELECT 1 FROM event_reminders_sent WHERE event_id = ? AND stage_minutes = ?');
  const getLastReminderSentAtStmt = db.prepare('SELECT MAX(sent_at) AS last FROM event_reminders_sent WHERE event_id = ?');
  const markReminderSentStmt = db.prepare(`
    INSERT OR IGNORE INTO event_reminders_sent (event_id, stage_minutes, sent_at) VALUES (?, ?, ?)
  `);

  const getLeaderboardStmt = db.prepare(`
    SELECT user_id, total_seconds FROM member_stats WHERE guild_id = ?
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
      FROM play_sessions WHERE guild_id = ?

      UNION ALL

      SELECT user_id, CAST(MAX(0, MIN(
        (? - started_at) - paused_seconds * 1000
          - (CASE WHEN paused_at IS NOT NULL THEN MAX(0, ? - paused_at) ELSE 0 END),
        ? - ?
      )) / 1000 AS INTEGER) AS seconds
      FROM active_sessions WHERE guild_id = ?
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

  function closeSession(guildId, userId, now = Date.now()) {
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
    const totalSeconds = Math.max(0, Math.floor(activeElapsedMs(session, now) / 1000));
    let completed = null;
    if (totalSeconds) {
      bumpGameSessionCount.run(guildId, userId, session.game_name);
      saveCompletedSession.run(guildId, userId, session.game_name, session.started_at, now, totalSeconds);
      completed = { gameName: session.game_name, startedAt: session.started_at, endedAt: now, durationSeconds: totalSeconds };
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

  const recoveredSessions = recoverStaleSessions();
  if (recoveredSessions) {
    console.log(`Recovered ${recoveredSessions} session(s) left open by a previous unclean shutdown.`);
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
          SELECT user_id, total_seconds FROM member_stats WHERE guild_id = ?
          UNION ALL
          SELECT user_id, CAST(MAX(0, (COALESCE(paused_at, ?) - last_checkpoint_at) / 1000) AS INTEGER)
          FROM active_sessions WHERE guild_id = ?
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
     */
    closeSessionsExceeding(maxActiveMs, now = Date.now()) {
      const closed = [];
      for (const row of db.prepare('SELECT guild_id, user_id FROM active_sessions').all()) {
        const session = getSession.get(row.guild_id, row.user_id);
        if (!session || activeElapsedMs(session, now) < maxActiveMs) continue;
        const completed = closeSession(row.guild_id, row.user_id, now);
        if (completed) closed.push({ guildId: row.guild_id, userId: row.user_id, completed });
      }
      return closed;
    },
    flushAll(now = Date.now()) {
      const sessions = db.prepare('SELECT guild_id, user_id FROM active_sessions').all();
      for (const session of sessions) closeSession(session.guild_id, session.user_id, now);
      return sessions;
    },
    close: () => db.close(),

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

    createEvent: (guildId, channelId, creatorId, title, description, gameName, startsAt, now = Date.now()) =>
      createEventStmt.run(guildId, channelId, creatorId, title, description, gameName, startsAt, now).lastInsertRowid,
    getEvent: (eventId) => getEventStmt.get(eventId) ?? null,
    setEventMessageId: (eventId, messageId) => setEventMessageIdStmt.run(messageId, eventId),
    updateEvent(eventId, title, description, gameName, startsAt) {
      const existing = getEventStmt.get(eventId);
      updateEventStmt.run(title, description, gameName, startsAt, eventId);
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
    hasReminderSent: (eventId, stageMinutes) => !!hasReminderSentStmt.get(eventId, stageMinutes),
    getLastReminderSentAt: (eventId) => getLastReminderSentAtStmt.get(eventId).last ?? null,
    markReminderSent: (eventId, stageMinutes, now = Date.now()) => markReminderSentStmt.run(eventId, stageMinutes, now),
  };
}
