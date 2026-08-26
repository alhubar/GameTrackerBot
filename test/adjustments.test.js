import test from 'node:test';
import assert from 'node:assert/strict';
import { ADJUSTMENT_KINDS, applyTimeAdjustment, voidSession } from '../src/adjustments.js';
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
