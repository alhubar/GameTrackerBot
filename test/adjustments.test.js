import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADJUSTMENT_KINDS, SYSTEM_ACTOR_ID, applyTimeAdjustment, voidSession, mergeGames, clawBackSessionCap,
} from '../src/adjustments.js';
import { tempDatabase, playSession, HOUR, MINUTE, T0 } from './helpers.js';

const G = 'guild-1';
const U = 'user-1';
const ADMIN = 'admin-1';

const withDb = (body) => {
  const { db, cleanup } = tempDatabase();
  try { body(db); } finally { cleanup(); }
};

test('adding time raises both the member total and the game', () => {
  withDb((db) => {
    const result = applyTimeAdjustment(db, {
      guildId: G, userId: U, actorId: ADMIN, gameName: 'Elden Ring', deltaSeconds: 2 * 3600,
    }, T0);
    assert.equal(result.appliedSeconds, 7200);
    assert.equal(result.totalAfter, 7200);
    assert.equal(db.getTotalSeconds(G, U), 7200);
    assert.equal(db.getGameStatsTotal(G, U, 'Elden Ring'), 7200);
  });
});

test('removing time lowers both by the same amount', () => {
  withDb((db) => {
    playSession(db, G, U, 'Elden Ring', T0, 3 * HOUR);
    const result = applyTimeAdjustment(db, {
      guildId: G, userId: U, actorId: ADMIN, gameName: 'Elden Ring', deltaSeconds: -3600,
    }, T0);
    assert.equal(result.appliedSeconds, -3600);
    assert.equal(db.getTotalSeconds(G, U), 2 * 3600);
    assert.equal(db.getGameStatsTotal(G, U, 'Elden Ring'), 2 * 3600);
  });
});

test('a subtraction is capped at what the game actually holds', () => {
  withDb((db) => {
    playSession(db, G, U, 'Elden Ring', T0, 3 * HOUR);
    playSession(db, G, U, 'Hades', T0 + 4 * HOUR, 40 * MINUTE);
    // Asking to take two hours off a game holding forty minutes takes forty, not two hours: the
    // rest was Elden Ring's and must not be dragged out of the member total.
    const result = applyTimeAdjustment(db, {
      guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: -2 * 3600,
    }, T0);
    assert.equal(result.requestedSeconds, -7200);
    assert.equal(result.appliedSeconds, -2400);
    assert.equal(db.getGameStatsTotal(G, U, 'Hades'), 0);
    assert.equal(db.getTotalSeconds(G, U), 3 * 3600);
  });
});

test('no stat is ever driven negative', () => {
  withDb((db) => {
    playSession(db, G, U, 'Hades', T0, 10 * MINUTE);
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: -99 * 3600 }, T0);
    assert.equal(db.getTotalSeconds(G, U), 0);
    assert.equal(db.getGameStatsTotal(G, U, 'Hades'), 0);
  });
});

test('a game emptied of both time and sessions leaves the collection', () => {
  withDb((db) => {
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: 3600 }, T0);
    assert.deepEqual(db.getMemberGameNames(G, U), ['Hades']);
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: -3600 }, T0);
    assert.deepEqual(db.getMemberGameNames(G, U), []);
  });
});

test('a game still holding completed sessions keeps its row when emptied of time', () => {
  withDb((db) => {
    playSession(db, G, U, 'Hades', T0, HOUR);
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: -3600 }, T0);
    // The session row still exists, so the game is still part of the member's history.
    assert.deepEqual(db.getMemberGameNames(G, U), ['Hades']);
    assert.equal(db.getGameSessionCount(G, U, 'Hades'), 1);
  });
});

test('the member total is never used to cap an addition', () => {
  withDb((db) => {
    // member_stats can legitimately exceed the sum of game_stats on a database that predates
    // per-game recording, so an addition must not be bounded by either.
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'New Game', deltaSeconds: 5 * 3600 }, T0);
    assert.equal(db.getTotalSeconds(G, U), 5 * 3600);
    assert.equal(db.getGameStatsTotal(G, U, 'New Game'), 5 * 3600);
  });
});

test('every applied correction is audit-logged with actor, amount and reason', () => {
  withDb((db) => {
    applyTimeAdjustment(db, {
      guildId: G, userId: U, actorId: ADMIN, gameName: 'Elden Ring',
      deltaSeconds: 90 * 60, reason: 'lost to a crash',
    }, T0);
    const [row] = db.getAdjustments(G, U);
    assert.equal(row.actor_id, ADMIN);
    assert.equal(row.user_id, U);
    assert.equal(row.kind, ADJUSTMENT_KINDS.TIME);
    assert.equal(row.game_name, 'Elden Ring');
    assert.equal(row.delta_seconds, 5400);
    assert.equal(row.reason, 'lost to a crash');
    assert.equal(row.created_at, T0);
  });
});

test('the log records what was applied, not what was asked for', () => {
  withDb((db) => {
    playSession(db, G, U, 'Hades', T0, 10 * MINUTE);
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: -5 * 3600 }, T0);
    assert.equal(db.getAdjustments(G, U)[0].delta_seconds, -600);
  });
});

test('a correction that changes nothing is not logged', () => {
  withDb((db) => {
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Never Played', deltaSeconds: -3600 }, T0);
    assert.deepEqual(db.getAdjustments(G, U), []);
  });
});

test('voiding a session removes the row, its time and its place in the tally', () => {
  withDb((db) => {
    playSession(db, G, U, 'Elden Ring', T0, 3 * HOUR);
    playSession(db, G, U, 'Elden Ring', T0 + 5 * HOUR, HOUR);
    const [newest] = db.getRecentSessions(G, U);

    const result = voidSession(db, { guildId: G, sessionId: newest.id, actorId: ADMIN }, T0);
    assert.equal(result.appliedSeconds, -3600);
    assert.equal(db.getTotalSeconds(G, U), 3 * 3600);
    assert.equal(db.getGameStatsTotal(G, U, 'Elden Ring'), 3 * 3600);
    assert.equal(db.getGameSessionCount(G, U, 'Elden Ring'), 1);
    assert.equal(db.getPlaySession(newest.id), null);
  });
});

test('voiding a session from another guild is refused rather than applied', () => {
  withDb((db) => {
    playSession(db, G, U, 'Elden Ring', T0, HOUR);
    const [session] = db.getRecentSessions(G, U);
    // play_sessions ids are one global sequence, so the guild has to be checked against the row.
    assert.equal(voidSession(db, { guildId: 'guild-2', sessionId: session.id, actorId: ADMIN }, T0), null);
    assert.equal(db.getTotalSeconds(G, U), 3600);
    assert.notEqual(db.getPlaySession(session.id), null);
  });
});

test('voiding an id that does not exist returns null', () => {
  withDb((db) => {
    assert.equal(voidSession(db, { guildId: G, sessionId: 9999, actorId: ADMIN }, T0), null);
  });
});

test('voiding a session is logged against the member, not the admin', () => {
  withDb((db) => {
    playSession(db, G, U, 'Hades', T0, HOUR);
    const [session] = db.getRecentSessions(G, U);
    voidSession(db, { guildId: G, sessionId: session.id, actorId: ADMIN, reason: 'PS5 rest mode' }, T0);
    const [row] = db.getAdjustments(G, U);
    assert.equal(row.kind, ADJUSTMENT_KINDS.SESSION);
    assert.equal(row.user_id, U);
    assert.equal(row.actor_id, ADMIN);
    assert.equal(row.session_id, session.id);
    assert.equal(row.delta_seconds, -3600);
    assert.equal(row.reason, 'PS5 rest mode');
  });
});

test('unlocked achievements survive a correction that drops the member below the threshold', () => {
  withDb((db) => {
    playSession(db, G, U, 'Elden Ring', T0, 3 * HOUR);
    db.unlockAchievement(G, U, 'first-steps', T0);
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Elden Ring', deltaSeconds: -3 * 3600 }, T0);
    assert.equal(db.getTotalSeconds(G, U), 0);
    assert.equal(db.hasAchievement(G, U, 'first-steps'), true);
  });
});

test('the log can be read per member or for the whole guild', () => {
  withDb((db) => {
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: 600 }, T0);
    applyTimeAdjustment(db, { guildId: G, userId: 'user-2', actorId: ADMIN, gameName: 'Hades', deltaSeconds: 600 }, T0 + 1000);
    assert.equal(db.getAdjustments(G, U).length, 1);
    assert.equal(db.getAdjustments(G, null).length, 2);
    // Newest first.
    assert.equal(db.getAdjustments(G, null)[0].user_id, 'user-2');
  });
});

test('corrections in another guild are not visible', () => {
  withDb((db) => {
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'Hades', deltaSeconds: 600 }, T0);
    assert.deepEqual(db.getAdjustments('guild-2', null), []);
  });
});

test('the game picker offers a running session before it has banked any time', () => {
  withDb((db) => {
    db.startSession(G, U, 'Just Launched', T0);
    assert.deepEqual(db.getMemberGameNames(G, U), ['Just Launched']);
  });
});

/**
 * The session cap's automatic claw-back — issue #21. `closeSessionsExceeding` already writes the
 * play_sessions row at the cap; this is what reconciles game_stats/member_stats with it when the
 * checkpoint tick ran late enough that the excess had already been banked in full.
 */

test('claws back the excess and logs it against no one in particular', () => {
  withDb((db) => {
    // Simulate what continuous checkpointing would have banked before a late tick caught the cap:
    // 15h actually played, only 12h of which should count.
    playSession(db, G, U, 'PEAK', T0, 15 * HOUR);
    const result = clawBackSessionCap(db, {
      guildId: G, userId: U, gameName: 'PEAK', excessSeconds: 3 * 3600, capSeconds: 12 * 3600,
    }, T0);
    assert.equal(result.appliedSeconds, -3 * 3600);
    assert.equal(db.getTotalSeconds(G, U), 12 * 3600);
    assert.equal(db.getGameStatsTotal(G, U, 'PEAK'), 12 * 3600);

    const [row] = db.getAdjustments(G, U);
    assert.equal(row.kind, ADJUSTMENT_KINDS.CAP);
    assert.equal(row.actor_id, SYSTEM_ACTOR_ID);
    assert.equal(row.delta_seconds, -3 * 3600);
    assert.match(row.reason, /12h cap/);
  });
});

test('the ordinary case — no overrun — claws nothing back and logs nothing', () => {
  withDb((db) => {
    playSession(db, G, U, 'PEAK', T0, 12 * HOUR);
    const result = clawBackSessionCap(db, {
      guildId: G, userId: U, gameName: 'PEAK', excessSeconds: 0, capSeconds: 12 * 3600,
    }, T0);
    assert.equal(result, null);
    assert.deepEqual(db.getAdjustments(G, U), []);
    assert.equal(db.getTotalSeconds(G, U), 12 * 3600);
  });
});

/**
 * `/adjust merge` — one game recorded under two names.
 *
 * The property everything else rests on: a merge moves rows between game names and never touches
 * `member_stats`, so no total, rank or standing can move. What it does change is the *number* of
 * distinct games a member has, which several achievements count.
 */

const merge = (db, fromName, intoName, extra = {}, now = T0) =>
  mergeGames(db, { guildId: G, fromName, intoName, actorId: ADMIN, reason: null, ...extra }, now);

test('two names fold into one, carrying time and session count', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 3 * HOUR);
    playSession(db, G, U, 'CSGO', T0 + 4 * HOUR, 1 * HOUR);
    playSession(db, G, U, 'Counter-Strike 2', T0 + 6 * HOUR, 2 * HOUR);

    const result = merge(db, 'CSGO', 'Counter-Strike 2');

    assert.equal(db.getGameStatsTotal(G, U, 'Counter-Strike 2'), 6 * 3600);
    assert.equal(db.getGameSessionCount(G, U, 'Counter-Strike 2'), 3);
    assert.equal(db.getGameStatsTotal(G, U, 'CSGO'), 0);
    assert.deepEqual(db.getMemberGameNames(G, U), ['Counter-Strike 2']);
    assert.equal(result.intoExisted, true);
    assert.equal(result.intoTotalSeconds, 6 * 3600);
  });
});

test('a merge never moves a member total, so no rank can follow it', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 3 * HOUR);
    playSession(db, G, U, 'Counter-Strike 2', T0 + 4 * HOUR, 2 * HOUR);
    const before = db.getTotalSeconds(G, U);
    merge(db, 'CSGO', 'Counter-Strike 2');
    assert.equal(db.getTotalSeconds(G, U), before);
    assert.equal(before, 5 * 3600);
  });
});

test('the recorded history moves too, not just the totals', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 5 * HOUR);
    merge(db, 'CSGO', 'Counter-Strike 2');
    // The server record reads play_sessions, so a half-merge would still name the retired spelling.
    assert.equal(db.getServerRecords(G, 3600).longestSession.game_name, 'Counter-Strike 2');
    assert.deepEqual(db.getRecentSessions(G, U).map((row) => row.game_name), ['Counter-Strike 2']);
  });
});

test('a session running right now is moved, and banks onto the surviving name', () => {
  withDb((db) => {
    db.startSession(G, U, 'CSGO', T0);
    const result = merge(db, 'CSGO', 'Counter-Strike 2');
    assert.equal(result.activeMoved, 1);
    db.checkpointAll(T0 + HOUR);
    assert.equal(db.getGameStatsTotal(G, U, 'Counter-Strike 2'), 3600);
    assert.equal(db.getGameStatsTotal(G, U, 'CSGO'), 0);
  });
});

test('a member whose only trace is a running session is still counted and logged', () => {
  withDb((db) => {
    // No game_stats row exists until the first checkpoint, so this member is invisible to the
    // aggregates the merge otherwise works from.
    db.startSession(G, U, 'CSGO', T0);
    const result = merge(db, 'CSGO', 'Counter-Strike 2');
    assert.deepEqual(result.members, [{ userId: U, movedSeconds: 0, movedSessionCount: 0 }]);
    assert.equal(db.getAdjustments(G, U).length, 1);
  });
});

test('a name nobody else has is simply renamed', () => {
  withDb((db) => {
    playSession(db, G, U, 'Halo: CE', T0, 2 * HOUR);
    const result = merge(db, 'Halo: CE', 'Halo: Combat Evolved');
    assert.equal(result.intoExisted, false);
    assert.equal(db.getGameStatsTotal(G, U, 'Halo: Combat Evolved'), 2 * 3600);
  });
});

test('every member holding the old name is moved, not just the one who asked', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 2 * HOUR);
    playSession(db, G, 'user-2', 'CSGO', T0, 1 * HOUR);
    playSession(db, G, 'user-2', 'Counter-Strike 2', T0 + 3 * HOUR, 1 * HOUR);
    const result = merge(db, 'CSGO', 'Counter-Strike 2');
    assert.equal(result.members.length, 2);
    assert.equal(db.getGameStatsTotal(G, U, 'Counter-Strike 2'), 2 * 3600);
    assert.equal(db.getGameStatsTotal(G, 'user-2', 'Counter-Strike 2'), 2 * 3600);
    assert.equal(result.intoTotalSeconds, 4 * 3600);
  });
});

test('the same spelling in another guild is left alone', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 2 * HOUR);
    playSession(db, 'guild-2', U, 'CSGO', T0, 2 * HOUR);
    merge(db, 'CSGO', 'Counter-Strike 2');
    assert.equal(db.getGameStatsTotal('guild-2', U, 'CSGO'), 2 * 3600);
    assert.equal(db.getGameStatsTotal('guild-2', U, 'Counter-Strike 2'), 0);
  });
});

test('a name with nothing under it changes nothing and logs nothing', () => {
  withDb((db) => {
    playSession(db, G, U, 'Hades', T0, 1 * HOUR);
    assert.equal(merge(db, 'Hadez', 'Hades'), null);
    assert.deepEqual(db.getAdjustments(G, null), []);
    assert.equal(db.getGameStatsTotal(G, U, 'Hades'), 3600);
  });
});

test('merging a name into itself is refused rather than deleting it', () => {
  withDb((db) => {
    playSession(db, G, U, 'Hades', T0, 1 * HOUR);
    assert.equal(merge(db, 'Hades', 'Hades'), null);
    assert.equal(db.getGameStatsTotal(G, U, 'Hades'), 3600);
    assert.deepEqual(db.getAdjustments(G, null), []);
  });
});

test('one audit row per member, naming both games and moving no time', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 2 * HOUR);
    playSession(db, G, 'user-2', 'CSGO', T0, 1 * HOUR);
    merge(db, 'CSGO', 'Counter-Strike 2', { reason: 'Valve renamed it' });

    const rows = db.getAdjustments(G, null);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.kind, ADJUSTMENT_KINDS.MERGE);
      assert.equal(row.game_name, 'CSGO');
      assert.equal(row.merged_into, 'Counter-Strike 2');
      // Must stay zero: the column's contract is what was applied to the member's total, so that
      // replaying it reproduces the totals. A merge applies nothing.
      assert.equal(row.delta_seconds, 0);
      assert.equal(row.reason, 'Valve renamed it');
    }
    assert.equal(db.getAdjustments(G, U).length, 1);
  });
});

test('an earlier correction keeps the name it was made under', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 2 * HOUR);
    applyTimeAdjustment(db, { guildId: G, userId: U, actorId: ADMIN, gameName: 'CSGO', deltaSeconds: -600 }, T0);
    merge(db, 'CSGO', 'Counter-Strike 2', {}, T0 + 1000);
    // The audit log records what was done at the time and is never rewritten.
    const [, older] = db.getAdjustments(G, U);
    assert.equal(older.kind, ADJUSTMENT_KINDS.TIME);
    assert.equal(older.game_name, 'CSGO');
    assert.equal(older.merged_into, null);
  });
});

test('the distinct-game count drops, and unlocked achievements survive it', () => {
  withDb((db) => {
    playSession(db, G, U, 'CSGO', T0, 2 * HOUR);
    playSession(db, G, U, 'Counter-Strike 2', T0 + 3 * HOUR, 2 * HOUR);
    assert.equal(db.getSubstantialGameCount(G, U, 3600), 2);
    db.unlockAchievement(G, U, 'collector', T0);

    merge(db, 'CSGO', 'Counter-Strike 2');

    // One game, with the hours of both — which is the whole point, and also why the count falls.
    assert.equal(db.getSubstantialGameCount(G, U, 3600), 1);
    assert.equal(db.getGameStatsTotal(G, U, 'Counter-Strike 2'), 4 * 3600);
    assert.equal(db.hasAchievement(G, U, 'collector'), true);
  });
});

test('the guild picker lists every name on record, running sessions included', () => {
  withDb((db) => {
    playSession(db, G, U, 'Hades', T0, 2 * HOUR);
    playSession(db, G, 'user-2', 'Celeste', T0, 1 * HOUR);
    db.startSession(G, 'user-3', 'Just Launched', T0);
    playSession(db, 'guild-2', U, 'Elsewhere', T0, 1 * HOUR);
    assert.deepEqual(db.getGuildGameNames(G), ['Hades', 'Celeste', 'Just Launched']);
  });
});
