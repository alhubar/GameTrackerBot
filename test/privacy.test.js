import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecap } from '../src/recap.js';
import { COUNTS_AS_PLAYED_SECONDS } from '../src/achievements.js';
import { tempDatabase, playSession, HOUR, MINUTE, T0 } from './helpers.js';

const G = 'guild-1';
const QUIET = 'quiet-member';
const LOUD = 'loud-member';

let db;
let cleanup;
beforeEach(() => { ({ db, cleanup } = tempDatabase()); });
afterEach(() => cleanup());

const idsOf = (rows) => rows.map((row) => row.user_id);
// duo_days is keyed on the pair in sorted order — evaluateDuoDays sorts before both writing and
// reading, so a test that records them unsorted would store a pair nothing ever looks up.
const DUO = [QUIET, LOUD].sort();

describe('opting out and back in', () => {
  test('opting out is recorded and reversible', () => {
    assert.equal(db.isOptedOut(G, QUIET), false);
    db.optOut(G, QUIET, T0);
    assert.equal(db.isOptedOut(G, QUIET), true);
    assert.equal(db.getOptOutAt(G, QUIET), T0);
    assert.equal(db.optIn(G, QUIET), true);
    assert.equal(db.isOptedOut(G, QUIET), false);
  });

  test('opting in when already tracked reports that nothing changed', () => {
    assert.equal(db.optIn(G, QUIET), false);
  });

  test('opting out closes the session in flight so its minutes are never banked later', () => {
    db.startSession(G, QUIET, 'Elden Ring', T0);
    const closed = db.optOut(G, QUIET, T0 + HOUR);
    assert.equal(closed.gameName, 'Elden Ring');
    assert.equal(closed.durationSeconds, 3600);
    assert.equal(db.getActiveSessionCount(G), 0);
  });

  test('opting out is per guild', () => {
    db.optOut(G, QUIET, T0);
    assert.equal(db.isOptedOut('guild-2', QUIET), false);
  });
});

describe('rankings hide opted-out members', () => {
  beforeEach(() => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 10 * HOUR);
    playSession(db, G, LOUD, 'Hades', T0, 2 * HOUR);
  });

  test('the all-time leaderboard drops them', () => {
    assert.deepEqual(idsOf(db.getLeaderboard(G, 50)), [QUIET, LOUD]);
    db.optOut(G, QUIET, T0);
    assert.deepEqual(idsOf(db.getLeaderboard(G, 50)), [LOUD]);
  });

  test('the windowed leaderboard drops them', () => {
    const from = T0 - HOUR;
    const to = T0 + 24 * HOUR;
    assert.deepEqual(idsOf(db.getMonthlyLeaderboard(G, from, to, 50)), [QUIET, LOUD]);
    db.optOut(G, QUIET, T0);
    assert.deepEqual(idsOf(db.getMonthlyLeaderboard(G, from, to, 50)), [LOUD]);
  });

  test("the server card's most-active list drops them", () => {
    db.optOut(G, QUIET, T0);
    assert.deepEqual(idsOf(db.getServerProfile(G, T0 + 24 * HOUR, 25).topPlayers), [LOUD]);
  });

  test('opting back in restores their place', () => {
    db.optOut(G, QUIET, T0);
    db.optIn(G, QUIET);
    assert.deepEqual(idsOf(db.getLeaderboard(G, 50)), [QUIET, LOUD]);
  });

  test('a running session is hidden from the windowed board too, not just closed history', () => {
    db.startSession(G, 'third', 'Hades', T0);
    const to = T0 + 3 * HOUR;
    assert.ok(idsOf(db.getMonthlyLeaderboard(G, T0 - HOUR, to, 50)).includes('third'));
    // Written directly rather than via optOut, which would close the session first.
    db.optOut(G, 'third', T0);
    db.startSession(G, 'third', 'Hades', T0);
    assert.equal(idsOf(db.getMonthlyLeaderboard(G, T0 - HOUR, to, 50)).includes('third'), false);
  });
});

describe('server records hide opted-out members', () => {
  test('the longest session passes to the next holder', () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 9 * HOUR);
    playSession(db, G, LOUD, 'Hades', T0, 2 * HOUR);
    assert.equal(db.getServerRecords(G, COUNTS_AS_PLAYED_SECONDS).longestSession.user_id, QUIET);
    db.optOut(G, QUIET, T0);
    assert.equal(db.getServerRecords(G, COUNTS_AS_PLAYED_SECONDS).longestSession.user_id, LOUD);
  });

  test('the top collector passes to the next holder', () => {
    for (const game of ['A', 'B', 'C']) playSession(db, G, QUIET, game, T0, 2 * HOUR);
    playSession(db, G, LOUD, 'D', T0, 2 * HOUR);
    assert.equal(db.getServerRecords(G, COUNTS_AS_PLAYED_SECONDS).topCollector.user_id, QUIET);
    db.optOut(G, QUIET, T0);
    assert.equal(db.getServerRecords(G, COUNTS_AS_PLAYED_SECONDS).topCollector.user_id, LOUD);
  });

  test('they stop counting toward a game\'s player tally', () => {
    playSession(db, G, QUIET, 'Shared', T0, 2 * HOUR);
    playSession(db, G, LOUD, 'Shared', T0, 2 * HOUR);
    assert.equal(db.getTopGameByPlayerCount(G, COUNTS_AS_PLAYED_SECONDS).players, 2);
    db.optOut(G, QUIET, T0);
    assert.equal(db.getTopGameByPlayerCount(G, COUNTS_AS_PLAYED_SECONDS).players, 1);
  });
});

describe('the recap skips opted-out members', () => {
  // Tuesday; the week before it runs Mon 3 Aug to Sun 9 Aug.
  const TUESDAY = Date.parse('2026-08-11T09:00:00Z');
  const LAST_WEEK = Date.parse('2026-08-05T12:00:00Z');

  test('an opted-out leader does not take the title', () => {
    playSession(db, G, QUIET, 'Elden Ring', LAST_WEEK, 10 * HOUR);
    playSession(db, G, LOUD, 'Hades', LAST_WEEK, 2 * HOUR);
    assert.equal(buildRecap(db, G, TUESDAY, { period: 'week' }).winner.userId, QUIET);
    db.optOut(G, QUIET, TUESDAY);
    const recap = buildRecap(db, G, TUESDAY, { period: 'week' });
    assert.equal(recap.winner.userId, LOUD);
    assert.deepEqual(recap.podium.map((entry) => entry.userId), [LOUD]);
  });

  test('the title is left vacant when the only player opted out', () => {
    playSession(db, G, QUIET, 'Elden Ring', LAST_WEEK, 10 * HOUR);
    db.optOut(G, QUIET, TUESDAY);
    assert.equal(buildRecap(db, G, TUESDAY, { period: 'week' }).winner, null);
  });
});

describe('what opting out deliberately does not touch', () => {
  test('their own profile still shows them their own data', () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 3 * HOUR);
    db.optOut(G, QUIET, T0);
    const profile = db.getPlayerProfile(G, QUIET, T0 + 4 * HOUR);
    assert.equal(profile.totalSeconds, 3 * 3600);
    assert.equal(profile.gamesPlayed, 1);
  });

  test('the server total still counts them, because it is history not a roster', () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 3 * HOUR);
    const before = db.getServerProfile(G, T0 + 4 * HOUR).totalSeconds;
    db.optOut(G, QUIET, T0);
    assert.equal(db.getServerProfile(G, T0 + 4 * HOUR).totalSeconds, before);
  });

  test('nothing of theirs is deleted', () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 3 * HOUR);
    db.unlockAchievement(G, QUIET, 'first-steps', T0);
    db.optOut(G, QUIET, T0);
    assert.equal(db.getTotalSeconds(G, QUIET), 3 * 3600);
    assert.equal(db.hasAchievement(G, QUIET, 'first-steps'), true);
    assert.equal(db.getRecentSessions(G, QUIET).length, 1);
  });
});

describe('achievements stop treating them as present', () => {
  test('they are not offered as a co-op partner', () => {
    db.startSession(G, QUIET, 'Shared', T0);
    db.startSession(G, LOUD, 'Shared', T0);
    assert.equal(db.getActiveUsersForGame(G, 'Shared').length, 2);
    db.optOut(G, QUIET, T0);
    db.startSession(G, QUIET, 'Shared', T0);
    assert.deepEqual(idsOf(db.getActiveUsersForGame(G, 'Shared')), [LOUD]);
  });

  test('they are not swept up as an inactive player', () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, HOUR);
    const cutoff = T0 + 60 * 24 * HOUR;
    assert.equal(db.getInactivePlayers(G, cutoff).length, 1);
    db.optOut(G, QUIET, T0);
    assert.deepEqual(db.getInactivePlayers(G, cutoff), []);
  });
});

describe('the stored-data summary', () => {
  test('counts every kind of row the bot holds', () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 3 * HOUR);
    playSession(db, G, QUIET, 'Hades', T0 + 4 * HOUR, 30 * MINUTE);
    db.unlockAchievement(G, QUIET, 'first-steps', T0);
    db.recordDuoDay(G, DUO[0], DUO[1], '2026-06-15');

    const summary = db.getStoredDataSummary(G, QUIET);
    assert.equal(summary.totalSeconds, 3.5 * 3600);
    assert.equal(summary.games, 2);
    assert.equal(summary.sessions, 2);
    assert.equal(summary.achievements, 1);
    assert.equal(summary.duoPartners, 1);
    assert.equal(summary.activeSession, false);
  });

  test('a member with nothing on record reads as all zeroes', () => {
    const summary = db.getStoredDataSummary(G, 'stranger');
    assert.equal(summary.totalSeconds, 0);
    assert.equal(summary.sessions, 0);
    assert.equal(summary.duoPartners, 0);
    assert.equal(summary.social.days, 0);
    assert.equal(summary.inVoice, false);
  });

  test('social minutes are listed too — held data has to be declared', () => {
    db.recordTextMinute(G, QUIET, T0);
    db.recordTextMinute(G, QUIET, T0 + MINUTE);
    db.creditVoiceMinutes(G, QUIET, 75, 240, T0);
    db.creditVoiceMinutes(G, QUIET, 20, 240, T0 + 26 * HOUR);

    const summary = db.getStoredDataSummary(G, QUIET);
    assert.equal(summary.social.text_minutes, 2);
    assert.equal(summary.social.voice_minutes, 95);
    assert.equal(summary.social.days, 2, 'counted across every day on record, not just today');
  });

  test('being in voice right now is disclosed, like a session in flight', () => {
    db.setVoiceState(G, QUIET, 'room-1', true, T0);
    assert.equal(db.getStoredDataSummary(G, QUIET).inVoice, true);
  });

  test('the summary covers another guild separately', () => {
    db.recordTextMinute('guild-2', QUIET, T0);
    assert.equal(db.getStoredDataSummary(G, QUIET).social.days, 0);
    assert.equal(db.getStoredDataSummary('guild-2', QUIET).social.days, 1);
  });
});

describe('erasure', () => {
  const seed = () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 3 * HOUR);
    db.unlockAchievement(G, QUIET, 'first-steps', T0);
    db.recordDuoDay(G, DUO[0], DUO[1], '2026-06-15');
    db.startSession(G, QUIET, 'Hades', T0 + 5 * HOUR);
  };

  test('every trace of the member is removed', () => {
    seed();
    const removed = db.purgeMember(G, QUIET);
    assert.equal(removed.sessions, 1);
    assert.equal(removed.achievements, 1);
    assert.equal(removed.duoDays, 1);
    assert.equal(removed.activeSessions, 1);
    assert.equal(db.getTotalSeconds(G, QUIET), 0);
    assert.equal(db.hasAchievement(G, QUIET, 'first-steps'), false);
    assert.deepEqual(db.getRecentSessions(G, QUIET), []);
    assert.deepEqual(db.getMemberGameNames(G, QUIET), []);
    assert.equal(db.getDuoDayCount(G, DUO[0], DUO[1]), 0);
  });

  test('erasing one member lowers their partner\'s co-op count too, since duo days are pairs', () => {
    seed();
    assert.equal(db.getDuoDayCount(G, DUO[0], DUO[1]), 1);
    db.purgeMember(G, QUIET);
    assert.equal(db.getDuoDayCount(G, DUO[0], DUO[1]), 0);
  });

  test('other members are untouched', () => {
    seed();
    playSession(db, G, LOUD, 'Hades', T0, 2 * HOUR);
    db.purgeMember(G, QUIET);
    assert.equal(db.getTotalSeconds(G, LOUD), 2 * 3600);
  });

  test('another guild is untouched', () => {
    playSession(db, G, QUIET, 'Elden Ring', T0, 3 * HOUR);
    playSession(db, 'guild-2', QUIET, 'Elden Ring', T0, 3 * HOUR);
    db.purgeMember(G, QUIET);
    assert.equal(db.getTotalSeconds('guild-2', QUIET), 3 * 3600);
  });

  test('erasing does not silently switch tracking back on', () => {
    seed();
    db.optOut(G, QUIET, T0);
    db.purgeMember(G, QUIET);
    assert.equal(db.isOptedOut(G, QUIET), true);
  });

  test('a member who was being tracked stays tracked, starting from nothing', () => {
    seed();
    db.purgeMember(G, QUIET);
    assert.equal(db.isOptedOut(G, QUIET), false);
  });

  test('corrections about them go, and corrections they made are anonymised', () => {
    db.recordAdjustment({
      guildId: G, userId: QUIET, actorId: 'admin', kind: 'time', gameName: 'Hades', deltaSeconds: 60,
    }, T0);
    db.recordAdjustment({
      guildId: G, userId: LOUD, actorId: QUIET, kind: 'time', gameName: 'Hades', deltaSeconds: 60,
    }, T0);
    db.purgeMember(G, QUIET);
    assert.deepEqual(db.getAdjustments(G, QUIET), []);
    // The other member's correction survives — it documents a change to *their* total — but no
    // longer names the member who has been erased.
    const [surviving] = db.getAdjustments(G, LOUD);
    assert.equal(surviving.actor_id, '0');
  });
});
