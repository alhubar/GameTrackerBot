import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, playSession, SECOND, HOUR, MINUTE, DAY, T0 } from './helpers.js';

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';
const USER = 'user-1';

let db;
let cleanup;
beforeEach(() => { ({ db, cleanup } = tempDatabase()); });
afterEach(() => cleanup());

describe('session tracking', () => {
  test('a completed session accrues time to the member and the game', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, 90 * MINUTE);
    assert.equal(db.getTotalSeconds(GUILD, USER), 90 * 60);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'PEAK'), 90 * 60);
  });

  test('starting the same game again is a no-op, not a new session', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    const result = db.startSession(GUILD, USER, 'PEAK', T0 + MINUTE);
    assert.equal(result.changed, false);
    assert.equal(result.previous, null);
  });

  test('switching games closes the previous session and reports it', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    const { changed, previous } = db.startSession(GUILD, USER, 'OtherGame', T0 + 30 * MINUTE);
    assert.equal(changed, true);
    assert.equal(previous.gameName, 'PEAK');
    assert.equal(previous.durationSeconds, 30 * 60);
  });

  test('stopping with no active session returns null', () => {
    assert.equal(db.stopSession(GUILD, USER, T0), null);
  });

  test('repeat sessions of one game accumulate and count separately', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, HOUR);
    playSession(db, GUILD, USER, 'PEAK', T0 + 2 * HOUR, HOUR);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'PEAK'), 2 * 3600);
    assert.equal(db.getQualifyingSessionCountToday(GUILD, USER, 'PEAK', T0 - DAY, 3600), 2);
  });

  test('guilds are fully isolated from one another', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, HOUR);
    assert.equal(db.getTotalSeconds(OTHER_GUILD, USER), 0);
    assert.equal(db.getGameStatsTotal(OTHER_GUILD, USER, 'PEAK'), 0);
  });

  test('checkpointAll banks elapsed time without ending the session', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    const rows = db.checkpointAll(T0 + 10 * MINUTE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].elapsed_seconds, 10 * 60);
    assert.equal(rows[0].game_name, 'PEAK');
    assert.equal(db.getTotalSeconds(GUILD, USER), 10 * 60);
  });

  test('checkpointing twice does not double-count the same span', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 10 * MINUTE);
    db.checkpointAll(T0 + 20 * MINUTE);
    assert.equal(db.getTotalSeconds(GUILD, USER), 20 * 60);
  });

  test('flushAll closes every open session', () => {
    db.startSession(GUILD, 'a', 'PEAK', T0);
    db.startSession(GUILD, 'b', 'PEAK', T0);
    db.flushAll(T0 + HOUR);
    assert.equal(db.getConcurrentGameCount(GUILD), 0);
    assert.equal(db.getTotalSeconds(GUILD, 'a'), 3600);
  });
});

describe('per-game attribution', () => {
  test('a checkpoint attributes time to the game, not just the member total', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 10 * MINUTE);
    // Before this was fixed the member total moved but the game total stayed at zero until the
    // session closed, so an interrupted session lost its attribution entirely.
    assert.equal(db.getTotalSeconds(GUILD, USER), 10 * 60);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'PEAK'), 10 * 60);
  });

  test('checkpointing then closing does not double-count the game total', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 10 * MINUTE);
    db.checkpointAll(T0 + 20 * MINUTE);
    db.stopSession(GUILD, USER, T0 + 30 * MINUTE);
    assert.equal(db.getTotalSeconds(GUILD, USER), 30 * 60);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'PEAK'), 30 * 60);
  });

  test('the member total and the sum of game totals always agree', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 15 * MINUTE);
    db.startSession(GUILD, USER, 'Wordle', T0 + 40 * MINUTE);
    db.checkpointAll(T0 + 50 * MINUTE);
    db.stopSession(GUILD, USER, T0 + 70 * MINUTE);
    const perGame = db.getGameStatsTotal(GUILD, USER, 'PEAK') + db.getGameStatsTotal(GUILD, USER, 'Wordle');
    assert.equal(perGame, db.getTotalSeconds(GUILD, USER));
    assert.equal(perGame, 70 * 60);
  });

  test('checkpoints do not inflate the session tally', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 10 * MINUTE);
    db.checkpointAll(T0 + 20 * MINUTE);
    db.checkpointAll(T0 + 30 * MINUTE);
    db.stopSession(GUILD, USER, T0 + 40 * MINUTE);
    assert.equal(db.getGameSessionCount(GUILD, USER, 'PEAK'), 1, 'three checkpoints are still one session');
  });

  test('the session tally matches the number of recorded sessions', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, HOUR);
    playSession(db, GUILD, USER, 'PEAK', T0 + 2 * HOUR, HOUR);
    assert.equal(db.getGameSessionCount(GUILD, USER, 'PEAK'), 2);
  });
});

describe('recovery from an unclean shutdown', () => {
  test('a session left open is closed as of its last checkpoint, not the restart', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 10 * MINUTE);
    // Simulate the process being killed here, then restarted eight hours later. The member may or
    // may not have kept playing; the bot cannot know, so the gap must not be billed as playtime.
    assert.equal(db.recoverStaleSessions(), 1);
    assert.equal(db.getTotalSeconds(GUILD, USER), 10 * 60);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'PEAK'), 10 * 60);
    assert.equal(db.getConcurrentGameCount(GUILD), 0, 'the stale session is gone');
  });

  test('the recovered session is recorded with its real length', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 25 * MINUTE);
    db.recoverStaleSessions();
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 9 * HOUR);
    assert.equal(profile.longestSeconds, 25 * 60);
  });

  test('recovery is a no-op when nothing was left open', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, HOUR);
    assert.equal(db.recoverStaleSessions(), 0);
    assert.equal(db.getTotalSeconds(GUILD, USER), 3600);
  });
});

describe('player profile', () => {
  test('counts distinct games and the longest session', () => {
    playSession(db, GUILD, USER, 'A', T0, 30 * MINUTE);
    playSession(db, GUILD, USER, 'B', T0 + HOUR, 2 * HOUR);
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 5 * HOUR);
    assert.equal(profile.gamesPlayed, 2);
    assert.equal(profile.longestSeconds, 2 * 3600);
    assert.equal(profile.totalSeconds, 150 * 60);
  });

  test('top games are ordered by time and limited', () => {
    playSession(db, GUILD, USER, 'Small', T0, 10 * MINUTE);
    playSession(db, GUILD, USER, 'Big', T0 + HOUR, 3 * HOUR);
    playSession(db, GUILD, USER, 'Medium', T0 + 5 * HOUR, HOUR);
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 10 * HOUR);
    assert.deepEqual(profile.topGames.map((g) => g.game_name), ['Big', 'Medium', 'Small']);
  });

  test('topGamesLimit caps the list', () => {
    for (let i = 0; i < 6; i++) playSession(db, GUILD, USER, `G${i}`, T0 + i * HOUR, 30 * MINUTE);
    assert.equal(db.getPlayerProfile(GUILD, USER, T0 + 10 * HOUR, 3).topGames.length, 3);
    assert.equal(db.getPlayerProfile(GUILD, USER, T0 + 10 * HOUR, 10).topGames.length, 6);
  });

  test('an in-progress session counts toward the running total', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 45 * MINUTE);
    assert.equal(profile.totalSeconds, 45 * 60);
  });

  test('monthSeconds only credits the portion inside the current month', () => {
    const janEnd = Date.parse('2026-01-31T23:00:00Z');
    playSession(db, GUILD, USER, 'CrossBoundary', janEnd, 2 * HOUR); // 1h in Jan, 1h in Feb
    playSession(db, GUILD, USER, 'FebOnly', Date.parse('2026-02-05T00:00:00Z'), 2 * HOUR);
    const profile = db.getPlayerProfile(GUILD, USER, Date.parse('2026-02-06T00:00:00Z'));
    assert.equal(profile.monthSeconds, 3 * 3600, 'only February time should count');
  });
});

describe('leaderboards', () => {
  test('all-time leaderboard ranks by total time', () => {
    playSession(db, GUILD, 'low', 'A', T0, 10 * MINUTE);
    playSession(db, GUILD, 'high', 'A', T0, 3 * HOUR);
    playSession(db, GUILD, 'mid', 'A', T0, HOUR);
    assert.deepEqual(db.getLeaderboard(GUILD).map((r) => r.user_id), ['high', 'mid', 'low']);
  });

  test('leaderboard honours its limit', () => {
    for (let i = 0; i < 5; i++) playSession(db, GUILD, `u${i}`, 'A', T0, (i + 1) * HOUR);
    assert.equal(db.getLeaderboard(GUILD, 2).length, 2);
  });

  test('monthly leaderboard excludes prior months and agrees with the profile', () => {
    const monthStart = Date.UTC(2026, 1, 1);
    playSession(db, GUILD, USER, 'Jan', Date.parse('2026-01-10T00:00:00Z'), 5 * HOUR);
    playSession(db, GUILD, USER, 'Feb', Date.parse('2026-02-05T00:00:00Z'), 2 * HOUR);
    const now = Date.parse('2026-02-06T00:00:00Z');
    const [row] = db.getMonthlyLeaderboard(GUILD, monthStart, now);
    assert.equal(row.total_seconds, 2 * 3600);
    assert.equal(row.total_seconds, db.getPlayerProfile(GUILD, USER, now).monthSeconds);
  });

  test('monthly leaderboard omits players with no time this month', () => {
    playSession(db, GUILD, USER, 'Jan', Date.parse('2026-01-10T00:00:00Z'), 5 * HOUR);
    assert.equal(db.getMonthlyLeaderboard(GUILD, Date.UTC(2026, 1, 1), Date.parse('2026-02-06T00:00:00Z')).length, 0);
  });
});

describe('server profile', () => {
  test('aggregates players, games and total time', () => {
    playSession(db, GUILD, 'a', 'PEAK', T0, HOUR);
    playSession(db, GUILD, 'b', 'Other', T0, 2 * HOUR);
    const profile = db.getServerProfile(GUILD, T0 + 5 * HOUR);
    assert.equal(profile.trackedPlayers, 2);
    assert.equal(profile.gamesTracked, 2);
    assert.equal(profile.totalSeconds, 3 * 3600);
  });

  test('returns the top three players in order', () => {
    playSession(db, GUILD, 'first', 'A', T0, 5 * HOUR);
    playSession(db, GUILD, 'second', 'A', T0, 3 * HOUR);
    playSession(db, GUILD, 'third', 'A', T0, 2 * HOUR);
    playSession(db, GUILD, 'fourth', 'A', T0, HOUR);
    const { topPlayers } = db.getServerProfile(GUILD, T0 + 10 * HOUR);
    assert.deepEqual(topPlayers.map((p) => p.user_id), ['first', 'second', 'third']);
  });

  test('identifies the most-played game and its player count', () => {
    playSession(db, GUILD, 'a', 'Popular', T0, 3 * HOUR);
    playSession(db, GUILD, 'b', 'Popular', T0, 2 * HOUR);
    playSession(db, GUILD, 'c', 'Niche', T0, HOUR);
    assert.equal(db.getTopGameByHours(GUILD, T0 + 10 * HOUR).game_name, 'Popular');
    assert.equal(db.getTopGameByPlayerCount(GUILD, HOUR / 1000).players, 2);
  });

  test('player count ignores members who barely touched the game', () => {
    playSession(db, GUILD, 'a', 'Popular', T0, 3 * HOUR);
    playSession(db, GUILD, 'b', 'Popular', T0, 2 * HOUR);
    for (const drive_by of ['c', 'd', 'e']) playSession(db, GUILD, drive_by, 'Popular', T0, 5 * SECOND);
    assert.equal(db.getTopGameByPlayerCount(GUILD, HOUR / 1000).players, 2);
  });

  test('guild game count only counts games with an hour of combined time', () => {
    playSession(db, GUILD, 'a', 'Real', T0, 2 * HOUR);
    // Neither member reaches an hour alone, but together the game does.
    playSession(db, GUILD, 'a', 'Shared', T0, 40 * MINUTE);
    playSession(db, GUILD, 'b', 'Shared', T0, 40 * MINUTE);
    playSession(db, GUILD, 'c', 'Glanced At', T0, 10 * SECOND);
    assert.equal(db.getGuildGameCount(GUILD, HOUR / 1000), 2);
  });

  test('empty guild reports zeroes rather than throwing', () => {
    const profile = db.getServerProfile(GUILD, T0);
    assert.equal(profile.trackedPlayers, 0);
    assert.equal(profile.totalSeconds, 0);
    assert.deepEqual(profile.topGames, []);
    assert.equal(db.getTopGameByHours(GUILD, T0), null);
  });
});

describe('achievement storage', () => {
  test('unlocking is idempotent', () => {
    assert.equal(db.unlockAchievement(GUILD, USER, 'first_steps', T0), true);
    assert.equal(db.unlockAchievement(GUILD, USER, 'first_steps', T0 + HOUR), false);
    assert.equal(db.getPlayerAchievements(GUILD, USER).length, 1);
  });

  test('unlock counts are per guild', () => {
    db.unlockAchievement(GUILD, 'a', 'first_steps', T0);
    db.unlockAchievement(GUILD, 'b', 'first_steps', T0);
    db.unlockAchievement(OTHER_GUILD, 'c', 'first_steps', T0);
    assert.equal(db.getAchievementUnlockCount(GUILD, 'first_steps'), 2);
    assert.equal(db.getAchievementUnlockCount(OTHER_GUILD, 'first_steps'), 1);
  });

  test('server achievements unlock once per guild', () => {
    assert.equal(db.unlockServerAchievement(GUILD, 'welcome_to_the_club', T0), true);
    assert.equal(db.unlockServerAchievement(GUILD, 'welcome_to_the_club', T0), false);
    assert.equal(db.unlockServerAchievement(OTHER_GUILD, 'welcome_to_the_club', T0), true);
  });
});

describe('streak and history queries', () => {
  test('play dates are distinct and newest first', () => {
    playSession(db, GUILD, USER, 'A', Date.parse('2026-06-01T10:00:00Z'), HOUR);
    playSession(db, GUILD, USER, 'A', Date.parse('2026-06-01T15:00:00Z'), HOUR);
    playSession(db, GUILD, USER, 'A', Date.parse('2026-06-03T10:00:00Z'), HOUR);
    assert.deepEqual(db.getPlayDates(GUILD, USER), ['2026-06-03', '2026-06-01']);
  });

  test('distinct day counts are per game and overall', () => {
    playSession(db, GUILD, USER, 'A', Date.parse('2026-06-01T10:00:00Z'), HOUR);
    playSession(db, GUILD, USER, 'B', Date.parse('2026-06-02T10:00:00Z'), HOUR);
    assert.equal(db.getDistinctDaysForGame(GUILD, USER, 'A'), 1);
    assert.equal(db.getDistinctDaysAnyGame(GUILD, USER), 2);
  });

  test('qualifying session counts respect the duration floor', () => {
    const dayStart = Date.UTC(2026, 5, 15);
    playSession(db, GUILD, USER, 'A', dayStart + HOUR, HOUR);
    playSession(db, GUILD, USER, 'A', dayStart + 4 * HOUR, 20 * MINUTE);
    assert.equal(db.getQualifyingSessionCountToday(GUILD, USER, 'A', dayStart, 3600), 1);
    assert.equal(db.getQualifyingSessionCountToday(GUILD, USER, 'A', dayStart, 600), 2);
  });

  test('inactive players are found past the cutoff', () => {
    playSession(db, GUILD, USER, 'A', T0, HOUR);
    assert.equal(db.getInactivePlayers(GUILD, T0 + 5 * HOUR).length, 1);
    assert.equal(db.getInactivePlayers(GUILD, T0).length, 0);
  });

  test('a player with an active session is never counted as inactive', () => {
    playSession(db, GUILD, USER, 'A', T0, HOUR);
    db.startSession(GUILD, USER, 'B', T0 + 30 * DAY);
    assert.equal(db.getInactivePlayers(GUILD, T0 + 40 * DAY).length, 0);
  });

  test('a game the server has never seen has no history', () => {
    assert.equal(db.hasGameBeenPlayedBefore(GUILD, 'Brand New', 'alice'), false);
  });

  test("a game counts as seen even when only the asking player has played it", () => {
    playSession(db, GUILD, 'alice', 'Unique', T0, HOUR);
    // Alice has been playing this for a while, so picking it up again is not a discovery.
    assert.equal(db.hasGameBeenPlayedBefore(GUILD, 'Unique', 'alice'), true);
    assert.equal(db.hasGameBeenPlayedBefore(GUILD, 'Unique', 'bob'), true);
  });

  test("the asking player's own in-flight session does not count as history", () => {
    db.startSession(GUILD, 'alice', 'Fresh', T0);
    assert.equal(db.hasGameBeenPlayedBefore(GUILD, 'Fresh', 'alice'), false);
    assert.equal(db.hasGameBeenPlayedBefore(GUILD, 'Fresh', 'bob'), true, 'but it counts for everyone else');
  });

  test('duo days are recorded once per pair per day', () => {
    db.recordDuoDay(GUILD, 'a', 'b', '2026-06-15');
    db.recordDuoDay(GUILD, 'a', 'b', '2026-06-15');
    db.recordDuoDay(GUILD, 'a', 'b', '2026-06-16');
    assert.equal(db.getDuoDayCount(GUILD, 'a', 'b'), 2);
  });

  test('qualified duo pairs respect the day threshold', () => {
    for (let i = 1; i <= 5; i++) db.recordDuoDay(GUILD, 'a', 'b', `2026-06-0${i}`);
    for (let i = 1; i <= 2; i++) db.recordDuoDay(GUILD, 'c', 'd', `2026-06-0${i}`);
    assert.equal(db.getQualifiedDuoPairCount(GUILD, 5), 1);
    assert.equal(db.getQualifiedDuoPairCount(GUILD, 2), 2);
  });
});

describe('events', () => {
  test('creating an event stores it and returns an id', () => {
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Night', 'desc', 'PEAK', T0 + DAY, T0);
    const event = db.getEvent(id);
    assert.equal(event.title, 'Night');
    assert.equal(event.game_name, 'PEAK');
    assert.equal(event.message_id, null);
  });

  test('missing events resolve to null', () => {
    assert.equal(db.getEvent(9999), null);
  });

  test('signups upsert instead of duplicating', () => {
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Night', null, null, T0 + DAY, T0);
    db.upsertEventSignup(id, 'alice', 'going');
    db.upsertEventSignup(id, 'alice', 'declined');
    const signups = db.getEventSignups(id);
    assert.equal(signups.length, 1);
    assert.equal(signups[0].status, 'declined');
  });

  test('deleting cascades to signups and reminder history', () => {
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Night', null, null, T0 + DAY, T0);
    db.upsertEventSignup(id, 'alice', 'going');
    db.markReminderSent(id, 60, T0);
    db.deleteEvent(id);
    assert.equal(db.getEvent(id), null);
    assert.equal(db.getEventSignups(id).length, 0);
    assert.equal(db.hasReminderSent(id, 60), false);
  });

  test('upcoming events are ordered soonest first and scoped to the guild', () => {
    db.createEvent(GUILD, 'chan', 'creator', 'Later', null, null, T0 + 5 * DAY, T0);
    db.createEvent(GUILD, 'chan', 'creator', 'Sooner', null, null, T0 + DAY, T0);
    db.createEvent(OTHER_GUILD, 'chan', 'creator', 'Elsewhere', null, null, T0 + DAY, T0);
    const upcoming = db.getUpcomingEventsForGuild(GUILD, T0, 10);
    assert.deepEqual(upcoming.map((e) => e.title), ['Sooner', 'Later']);
  });

  test('stale events are those already past the cutoff', () => {
    const old = db.createEvent(GUILD, 'chan', 'creator', 'Old', null, null, T0 - 2 * DAY, T0 - 3 * DAY);
    const future = db.createEvent(GUILD, 'chan', 'creator', 'Future', null, null, T0 + DAY, T0);
    const stale = db.getStaleEvents(T0 - DAY);
    assert.ok(stale.some((event) => event.id === old));
    assert.ok(!stale.some((event) => event.id === future));
    // The row carries what expiry needs to delete the announcement message, not just the id.
    const staleRow = stale.find((event) => event.id === old);
    assert.equal(staleRow.guild_id, GUILD);
    assert.equal(staleRow.channel_id, 'chan');
    assert.equal(staleRow.message_id, null);
  });

  test('an expiring event still carries its message id for cleanup', () => {
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Old', null, null, T0 - 2 * DAY, T0 - 3 * DAY);
    db.setEventMessageId(id, '987654321');
    const staleRow = db.getStaleEvents(T0 - DAY).find((event) => event.id === id);
    assert.equal(staleRow.message_id, '987654321');
  });

  test('message ids round-trip for jump links', () => {
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Night', null, null, T0 + DAY, T0);
    db.setEventMessageId(id, '123456789');
    assert.equal(db.getEvent(id).message_id, '123456789');
  });

  test('last reminder timestamp reflects the most recent stage', () => {
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Night', null, null, T0 + DAY, T0);
    assert.equal(db.getLastReminderSentAt(id), null);
    db.markReminderSent(id, 720, T0);
    db.markReminderSent(id, 60, T0 + HOUR);
    assert.equal(db.getLastReminderSentAt(id), T0 + HOUR);
  });
});

describe('players who already played a game (event invite prefill)', () => {
  // getPlayersForGame's threshold is total_seconds (it mirrors COUNTS_AS_PLAYED_SECONDS), unlike
  // the HOUR/MINUTE helpers above which are millisecond durations — 3600 here, not HOUR.
  test('only players meeting the minimum are returned', () => {
    playSession(db, GUILD, 'alice', 'PEAK', T0, HOUR);
    playSession(db, GUILD, 'bob', 'PEAK', T0, 10 * MINUTE);
    assert.deepEqual(db.getPlayersForGame(GUILD, 'PEAK', 3600), ['alice']);
  });

  test('matches the game name case-insensitively', () => {
    playSession(db, GUILD, 'alice', 'PEAK', T0, HOUR);
    assert.deepEqual(db.getPlayersForGame(GUILD, 'peak', 3600), ['alice']);
  });

  test('is scoped to the guild', () => {
    playSession(db, GUILD, 'alice', 'PEAK', T0, HOUR);
    playSession(db, OTHER_GUILD, 'bob', 'PEAK', T0, HOUR);
    assert.deepEqual(db.getPlayersForGame(GUILD, 'PEAK', 3600), ['alice']);
  });

  test('orders by total time, most invested first', () => {
    playSession(db, GUILD, 'alice', 'PEAK', T0, HOUR);
    playSession(db, GUILD, 'bob', 'PEAK', T0, 3 * HOUR);
    assert.deepEqual(db.getPlayersForGame(GUILD, 'PEAK', 3600), ['bob', 'alice']);
  });
});

// Per-game totals are banked into game_stats at every checkpoint, so any query that unions
// game_stats with the live session must add only the *unbanked* slice (now - last_checkpoint_at).
// Adding the whole session (now - started_at) counts the checkpointed part twice, which is
// visible as top-games summing above the server total while somebody is mid-session.
describe('mid-session reporting does not double-count', () => {
  test('player top games match the member total during a checkpointed session', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 3 * HOUR);
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 3 * HOUR);
    assert.equal(profile.totalSeconds, 3 * 3600);
    assert.equal(profile.topGames[0].total_seconds, 3 * 3600);
  });

  test('time since the last checkpoint still counts toward the game', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.checkpointAll(T0 + 3 * HOUR);
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 3 * HOUR + 30 * MINUTE);
    assert.equal(profile.totalSeconds, 3.5 * 3600);
    assert.equal(profile.topGames[0].total_seconds, 3.5 * 3600);
  });

  test('an uncheckpointed session is credited in full', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 90 * MINUTE);
    assert.equal(profile.topGames[0].total_seconds, 90 * 60);
  });

  test('server top games never exceed the server total', () => {
    db.startSession(GUILD, 'a', 'PEAK', T0);
    db.startSession(GUILD, 'b', 'PEAK', T0);
    db.checkpointAll(T0 + 2 * HOUR);
    const profile = db.getServerProfile(GUILD, T0 + 2 * HOUR);
    const topGamesTotal = profile.topGames.reduce((sum, row) => sum + row.total_seconds, 0);
    assert.equal(profile.totalSeconds, 4 * 3600);
    assert.equal(topGamesTotal, 4 * 3600);
    assert.ok(topGamesTotal <= profile.totalSeconds);
  });

  test('getTopGameByHours reports banked hours, not doubled ones', () => {
    db.startSession(GUILD, USER, 'Obsession', T0);
    db.checkpointAll(T0 + 10 * HOUR);
    assert.equal(db.getTopGameByHours(GUILD, T0 + 10 * HOUR).total_seconds, 10 * 3600);
  });

  test('a mid-session game does not overtake a genuinely bigger one', () => {
    playSession(db, GUILD, 'a', 'Established', T0, 9 * HOUR);
    db.startSession(GUILD, 'b', 'Upstart', T0 + 10 * HOUR);
    db.checkpointAll(T0 + 15 * HOUR);
    assert.equal(db.getTopGameByHours(GUILD, T0 + 15 * HOUR).game_name, 'Established');
  });
});

// Discord flips a member to "idle" after roughly ten minutes without input but keeps naming the
// game, so an unattended launcher would otherwise bank a full night. Paused time is banked up to
// the moment it stops and never credited again until the member is actually back.
describe('idle sessions stop accruing', () => {
  test('pausing banks what is owed and nothing after it', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.pauseSession(GUILD, USER, T0 + 30 * MINUTE);
    assert.equal(db.getTotalSeconds(GUILD, USER), 30 * 60);
    db.checkpointAll(T0 + 8 * HOUR);
    assert.equal(db.getTotalSeconds(GUILD, USER), 30 * 60);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'PEAK'), 30 * 60);
  });

  test('an overnight idle gap is never credited once the member returns', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.pauseSession(GUILD, USER, T0 + HOUR);
    db.resumeSession(GUILD, USER, T0 + 9 * HOUR);
    db.checkpointAll(T0 + 10 * HOUR);
    assert.equal(db.getTotalSeconds(GUILD, USER), 2 * 3600);
  });

  test('the completed session records active time, not wall clock', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.pauseSession(GUILD, USER, T0 + HOUR);
    db.resumeSession(GUILD, USER, T0 + 9 * HOUR);
    const completed = db.stopSession(GUILD, USER, T0 + 10 * HOUR);
    assert.equal(completed.durationSeconds, 2 * 3600);
    assert.equal(completed.startedAt, T0, 'started_at stays truthful for day grouping');
  });

  test('profiles and totals ignore time spent idle', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.pauseSession(GUILD, USER, T0 + HOUR);
    const profile = db.getPlayerProfile(GUILD, USER, T0 + 9 * HOUR);
    assert.equal(profile.totalSeconds, 3600);
    assert.equal(profile.topGames[0].total_seconds, 3600);
    assert.equal(profile.longestSeconds, 3600);
    assert.equal(db.getServerProfile(GUILD, T0 + 9 * HOUR).totalSeconds, 3600);
  });

  test('pausing twice or resuming an active session changes nothing', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    assert.equal(db.resumeSession(GUILD, USER, T0 + MINUTE), false);
    assert.equal(db.pauseSession(GUILD, USER, T0 + HOUR), true);
    assert.equal(db.pauseSession(GUILD, USER, T0 + 2 * HOUR), false);
    assert.equal(db.isSessionPaused(GUILD, USER), true);
    assert.equal(db.resumeSession(GUILD, USER, T0 + 3 * HOUR), true);
    assert.equal(db.isSessionPaused(GUILD, USER), false);
    db.checkpointAll(T0 + 4 * HOUR);
    assert.equal(db.getTotalSeconds(GUILD, USER), 2 * 3600);
  });

  test('switching games clears the pause carried by the old session', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.pauseSession(GUILD, USER, T0 + HOUR);
    db.startSession(GUILD, USER, 'Other', T0 + 5 * HOUR);
    assert.equal(db.isSessionPaused(GUILD, USER), false);
    db.checkpointAll(T0 + 6 * HOUR);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'Other'), 3600);
  });
});

describe('the session cap', () => {
  test('closes a session past the limit and leaves shorter ones alone', () => {
    db.startSession(GUILD, 'marathon', 'PEAK', T0);
    db.startSession(GUILD, 'casual', 'PEAK', T0 + 11 * HOUR);
    const closed = db.closeSessionsExceeding(12 * HOUR, T0 + 12 * HOUR);
    assert.deepEqual(closed.map((row) => row.userId), ['marathon']);
    assert.equal(closed[0].completed.durationSeconds, 12 * 3600);
    assert.equal(db.getTotalSeconds(GUILD, 'casual'), 0);
  });

  test('idle time does not count toward the cap', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    db.pauseSession(GUILD, USER, T0 + HOUR);
    db.resumeSession(GUILD, USER, T0 + 20 * HOUR);
    assert.deepEqual(db.closeSessionsExceeding(12 * HOUR, T0 + 21 * HOUR), []);
  });
});

describe('monthly leaderboard counts live sessions', () => {
  test('an in-flight session appears on the board and matches the card', () => {
    const monthStart = Date.UTC(2026, 5, 1);
    const start = Date.parse('2026-06-10T00:00:00Z');
    const now = start + 6 * HOUR;
    db.startSession(GUILD, USER, 'PEAK', start);
    const [row] = db.getMonthlyLeaderboard(GUILD, monthStart, now);
    assert.equal(row.total_seconds, 6 * 3600);
    assert.equal(row.total_seconds, db.getPlayerProfile(GUILD, USER, now).monthSeconds);
  });

  test('idle time is excluded from the board too', () => {
    const monthStart = Date.UTC(2026, 5, 1);
    const start = Date.parse('2026-06-10T00:00:00Z');
    db.startSession(GUILD, USER, 'PEAK', start);
    db.pauseSession(GUILD, USER, start + 2 * HOUR);
    const [row] = db.getMonthlyLeaderboard(GUILD, monthStart, start + 10 * HOUR);
    assert.equal(row.total_seconds, 2 * 3600);
  });
});

// The live database predates the pause columns, so opening it must add them in place rather than
// failing or dropping the session somebody is in the middle of.
describe('upgrading a database written before idle tracking', () => {
  test('adds the pause columns and idles correctly afterwards', async () => {
    const { default: Database } = await import('better-sqlite3');
    const { openDatabase } = await import('../src/database.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'tracker-upgrade-'));
    const file = join(dir, 'old.sqlite');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE active_sessions (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        game_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_checkpoint_at INTEGER,
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    old.prepare('INSERT INTO active_sessions VALUES (?, ?, ?, ?, ?)').run(GUILD, USER, 'PEAK', T0, T0);
    old.close();

    const upgraded = openDatabase(file);
    try {
      // openDatabase recovers stale sessions as of their last checkpoint, so the row above is
      // closed on open rather than resumed — that is the documented unclean-restart behaviour.
      // What matters here is that the upgraded schema then works end to end.
      const inspector = new Database(file, { readonly: true });
      const columns = new Set(inspector.prepare('PRAGMA table_info(active_sessions)').all().map((c) => c.name));
      inspector.close();
      assert.ok(columns.has('paused_at'));
      assert.ok(columns.has('paused_seconds'));

      upgraded.startSession(GUILD, USER, 'PEAK', T0);
      upgraded.checkpointAll(T0 + HOUR);
      assert.equal(upgraded.getTotalSeconds(GUILD, USER), 3600);
      assert.equal(upgraded.pauseSession(GUILD, USER, T0 + 2 * HOUR), true);
      upgraded.checkpointAll(T0 + 12 * HOUR);
      assert.equal(upgraded.getTotalSeconds(GUILD, USER), 2 * 3600);
    } finally {
      upgraded.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('server records', () => {
  const HOUR_SECONDS = 60 * 60;

  test('a fresh server has no records at all', () => {
    const records = db.getServerRecords(GUILD, HOUR_SECONDS);
    assert.equal(records.longestSession, null);
    assert.equal(records.topGameByPlayers, null);
    assert.equal(records.topCollector, null);
  });

  test('the longest session wins on duration, not on recency', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, 5 * HOUR);
    playSession(db, GUILD, 'user-2', 'OtherGame', T0 + DAY, 2 * HOUR);
    const { longestSession } = db.getServerRecords(GUILD, HOUR_SECONDS);
    assert.equal(longestSession.user_id, USER);
    assert.equal(longestSession.game_name, 'PEAK');
    assert.equal(longestSession.duration_seconds, 5 * HOUR_SECONDS);
  });

  test('the group record counts only players past the one-hour bar', () => {
    // Three members touch the same game, but only two put a real hour into it.
    playSession(db, GUILD, USER, 'PEAK', T0, 2 * HOUR);
    playSession(db, GUILD, 'user-2', 'PEAK', T0, 90 * MINUTE);
    playSession(db, GUILD, 'user-3', 'PEAK', T0, 5 * MINUTE);
    const { topGameByPlayers } = db.getServerRecords(GUILD, HOUR_SECONDS);
    assert.equal(topGameByPlayers.game_name, 'PEAK');
    assert.equal(topGameByPlayers.players, 2);
  });

  test('the collector record counts distinct games past the bar, not launches', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, 2 * HOUR);
    playSession(db, GUILD, USER, 'OtherGame', T0 + DAY, 2 * HOUR);
    // Three more games barely touched: they must not inflate the count.
    for (const game of ['Brief1', 'Brief2', 'Brief3']) {
      playSession(db, GUILD, USER, game, T0 + 2 * DAY, 5 * MINUTE);
    }
    const { topCollector } = db.getServerRecords(GUILD, HOUR_SECONDS);
    assert.equal(topCollector.user_id, USER);
    assert.equal(topCollector.games, 2);
  });

  test('repeat sittings add up to clear the bar, matching the collection ladder', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, 40 * MINUTE);
    playSession(db, GUILD, USER, 'PEAK', T0 + DAY, 25 * MINUTE);
    const { topCollector } = db.getServerRecords(GUILD, HOUR_SECONDS);
    assert.equal(topCollector.games, 1);
    assert.equal(db.getSubstantialGameCount(GUILD, USER, HOUR_SECONDS), 1);
  });

  test('records are scoped to their own guild', () => {
    playSession(db, GUILD, USER, 'PEAK', T0, 5 * HOUR);
    playSession(db, OTHER_GUILD, 'user-9', 'OtherGame', T0, 9 * HOUR);
    const { longestSession } = db.getServerRecords(GUILD, HOUR_SECONDS);
    assert.equal(longestSession.user_id, USER);
    assert.equal(longestSession.duration_seconds, 5 * HOUR_SECONDS);
  });
});
