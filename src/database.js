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
  `);
  const activeSessionColumns = db.prepare('PRAGMA table_info(active_sessions)').all();
  if (!activeSessionColumns.some((column) => column.name === 'last_checkpoint_at')) {
    db.exec('ALTER TABLE active_sessions ADD COLUMN last_checkpoint_at INTEGER');
  }
  const guildSettingsColumns = db.prepare('PRAGMA table_info(guild_settings)').all();
  if (!guildSettingsColumns.some((column) => column.name === 'last_announced_release_id')) {
    db.exec('ALTER TABLE guild_settings ADD COLUMN last_announced_release_id TEXT');
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
    ON CONFLICT(guild_id, user_id) DO UPDATE SET game_name = excluded.game_name, started_at = excluded.started_at, last_checkpoint_at = excluded.last_checkpoint_at
  `);
  const resetSessionCheckpoint = db.prepare('UPDATE active_sessions SET last_checkpoint_at = ? WHERE guild_id = ? AND user_id = ?');
  const removeSession = db.prepare('DELETE FROM active_sessions WHERE guild_id = ? AND user_id = ?');
  const addGameTime = db.prepare(`
    INSERT INTO game_stats (guild_id, user_id, game_name, total_seconds, session_count) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(guild_id, user_id, game_name) DO UPDATE SET
      total_seconds = total_seconds + excluded.total_seconds,
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
  const getRankRoles = db.prepare('SELECT rank_index, role_id FROM rank_roles WHERE guild_id = ? ORDER BY rank_index');
  const saveRankRole = db.prepare(`
    INSERT INTO rank_roles (guild_id, rank_index, role_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, rank_index) DO UPDATE SET role_id = excluded.role_id
  `);

  function closeSession(guildId, userId, now = Date.now()) {
    const session = getSession.get(guildId, userId);
    if (!session) return 0;
    const unrecordedSeconds = Math.max(0, Math.floor((now - session.last_checkpoint_at) / 1000));
    if (unrecordedSeconds) addTime.run(guildId, userId, unrecordedSeconds);
    const totalSeconds = Math.max(0, Math.floor((now - session.started_at) / 1000));
    if (totalSeconds) {
      addGameTime.run(guildId, userId, session.game_name, totalSeconds);
      saveCompletedSession.run(guildId, userId, session.game_name, session.started_at, now, totalSeconds);
    }
    removeSession.run(guildId, userId);
    return unrecordedSeconds;
  }

  return {
    getTotalSeconds: (guildId, userId) => getStats.get(guildId, userId)?.total_seconds ?? 0,
    getPlayerProfile(guildId, userId, now = Date.now()) {
      const active = getSession.get(guildId, userId);
      const activeSeconds = active ? Math.max(0, Math.floor((now - active.last_checkpoint_at) / 1000)) : 0;
      const totalSeconds = (getStats.get(guildId, userId)?.total_seconds ?? 0) + activeSeconds;
      const nowDate = new Date(now);
      const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
      const monthSeconds = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN ended_at > ? THEN
          CAST((MIN(ended_at, ?) - MAX(started_at, ?)) / 1000 AS INTEGER)
          ELSE 0 END), 0) AS total_seconds
        FROM play_sessions WHERE guild_id = ? AND user_id = ?
      `).get(monthStart, now, monthStart, guildId, userId).total_seconds
        + (active ? Math.max(0, Math.floor((now - Math.max(active.started_at, monthStart)) / 1000)) : 0);
      const topGames = db.prepare(`
		SELECT game_name, SUM(total_seconds) AS total_seconds
		FROM (
			SELECT game_name, total_seconds
			FROM game_stats
			WHERE guild_id = ? AND user_id = ?

		UNION ALL

			SELECT game_name,
			CAST(MAX(0, (? - started_at) / 1000) AS INTEGER)
			FROM active_sessions
			WHERE guild_id = ? AND user_id = ?
			)
		GROUP BY game_name
		ORDER BY total_seconds DESC
		LIMIT 3
`).all(guildId, userId, now, guildId, userId);
      const longest = db.prepare(`
        SELECT MAX(duration_seconds) AS duration_seconds FROM play_sessions WHERE guild_id = ? AND user_id = ?
      `).get(guildId, userId).duration_seconds ?? 0;
      const activeDuration = active ? Math.max(0, Math.floor((now - active.started_at) / 1000)) : 0;
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
    getServerProfile(guildId, now = Date.now()) {
      const activeSeconds = db.prepare(`
        SELECT COALESCE(SUM(CAST(MAX(0, (? - last_checkpoint_at) / 1000) AS INTEGER)), 0) AS total_seconds
        FROM active_sessions WHERE guild_id = ?
      `).get(now, guildId).total_seconds;
      const totalSeconds = (db.prepare(`
        SELECT COALESCE(SUM(total_seconds), 0) AS total_seconds FROM member_stats WHERE guild_id = ?
      `).get(guildId).total_seconds) + activeSeconds;
      const trackedPlayers = db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS count FROM (
          SELECT user_id FROM member_stats WHERE guild_id = ?
          UNION SELECT user_id FROM active_sessions WHERE guild_id = ?
        )
      `).get(guildId, guildId).count;
      const topGames = db.prepare(`
		SELECT game_name, SUM(total_seconds) AS total_seconds
		FROM (
			SELECT game_name, total_seconds
			FROM game_stats
			WHERE guild_id = ?

			UNION ALL

			SELECT game_name,
				CAST(MAX(0, (? - started_at) / 1000) AS INTEGER)
			FROM active_sessions
			WHERE guild_id = ?
		)
		GROUP BY game_name
		ORDER BY total_seconds DESC
		LIMIT 3
		`).all(guildId, now, guildId);
      const mostActivePlayer = db.prepare(`
        SELECT user_id, SUM(total_seconds) AS total_seconds FROM (
          SELECT user_id, total_seconds FROM member_stats WHERE guild_id = ?
          UNION ALL
          SELECT user_id, CAST(MAX(0, (? - last_checkpoint_at) / 1000) AS INTEGER)
          FROM active_sessions WHERE guild_id = ?
        ) GROUP BY user_id ORDER BY total_seconds DESC LIMIT 1
      `).get(guildId, now, guildId) ?? null;
      const gamesTracked = db.prepare(`
        SELECT COUNT(DISTINCT game_name) AS count FROM (
          SELECT game_name FROM game_stats WHERE guild_id = ?
          UNION SELECT game_name FROM active_sessions WHERE guild_id = ?
        )
      `).get(guildId, guildId).count;
      return { trackedPlayers, totalSeconds, topGames, mostActivePlayer, gamesTracked };
    },
    getNotificationChannel: (guildId) => getNotificationChannel.get(guildId)?.notification_channel_id ?? null,
    setNotificationChannel: (guildId, channelId) => setNotificationChannel.run(guildId, channelId),
    getLastAnnouncedRelease: (guildId) => getLastAnnouncedRelease.get(guildId)?.last_announced_release_id ?? null,
    setLastAnnouncedRelease: (guildId, releaseId) => setLastAnnouncedRelease.run(guildId, String(releaseId)),
    getRankRoles: (guildId) => getRankRoles.all(guildId),
    saveRankRole: (guildId, rankIndex, roleId) => saveRankRole.run(guildId, rankIndex, roleId),
    getLeaderboard: (guildId, limit = 10) => db.prepare(`
      SELECT user_id, total_seconds FROM member_stats WHERE guild_id = ?
      ORDER BY total_seconds DESC LIMIT ?
    `).all(guildId, limit),
    startSession(guildId, userId, gameName, now = Date.now()) {
      const existing = getSession.get(guildId, userId);
      if (existing?.game_name === gameName) return false;
      closeSession(guildId, userId, now);
      createSession.run(guildId, userId, gameName, now, now);
      return true;
    },
    stopSession: closeSession,
    checkpointAll(now = Date.now()) {
      const sessions = db.prepare('SELECT guild_id, user_id FROM active_sessions').all();
      for (const session of sessions) {
        const active = getSession.get(session.guild_id, session.user_id);
        const seconds = Math.max(0, Math.floor((now - active.last_checkpoint_at) / 1000));
        if (seconds) addTime.run(session.guild_id, session.user_id, seconds);
        resetSessionCheckpoint.run(now, session.guild_id, session.user_id);
        session.elapsed_seconds = seconds;
      }
      return sessions;
    },
    flushAll(now = Date.now()) {
      const sessions = db.prepare('SELECT guild_id, user_id FROM active_sessions').all();
      for (const session of sessions) closeSession(session.guild_id, session.user_id, now);
      return sessions;
    },
    close: () => db.close(),
  };
}
