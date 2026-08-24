import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, playSession, SECOND, HOUR, MINUTE, T0 } from './helpers.js';

// serverAchievements.js reads its thresholds from the environment at import time, so the
// overrides must be in place before the dynamic import below.
process.env.SERVER_PLAYER_THRESHOLDS = '2,4';
process.env.SERVER_GAME_THRESHOLDS = '3,6';
process.env.SERVER_PLAYTIME_HOURS = '5,10';
process.env.SERVER_DOMINANCE_HOURS = '4,8';
process.env.SERVER_DOMINANCE_PLAYERS = '3,5';
process.env.SERVER_MELTING_POT_THRESHOLD = '3';
process.env.SERVER_TOP_RANK_THRESHOLDS = '2';
process.env.SERVER_RUSH_HOUR_THRESHOLDS = '4';
process.env.SERVER_ALWAYS_ON_THRESHOLDS = '3';
process.env.SERVER_TROPHY_CASE_THRESHOLDS = '2,4';
process.env.SERVER_SQUAD_BONDS_THRESHOLDS = '2';

const {
  SERVER_ACHIEVEMENTS, serverAchievementById, getUnlockedServerAchievements,
  computeServerMetrics, evaluateServerAchievements,
} = await import('../src/serverAchievements.js');
const { RANK_HOURS } = await import('../src/ranks.js');

const GUILD = 'guild-1';

let db;
let cleanup;
beforeEach(() => { ({ db, cleanup } = tempDatabase()); });
afterEach(() => cleanup());

/** Runs the evaluator and returns the set of ids unlocked on that pass. */
function unlockedIds(now) {
  return new Set(evaluateServerAchievements(db, GUILD, now).unlocked.map((tier) => tier.id));
}

describe('server achievement catalogue', () => {
  test('every tier has the required fields', () => {
    for (const achievement of SERVER_ACHIEVEMENTS) {
      assert.ok(achievement.id);
      assert.ok(achievement.name, `${achievement.id} needs a name`);
      assert.ok(achievement.emoji, `${achievement.id} needs an emoji`);
      assert.ok(achievement.description, `${achievement.id} needs a description`);
    }
  });

  test('ids are unique', () => {
    const ids = SERVER_ACHIEVEMENTS.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('names are unique', () => {
    const names = SERVER_ACHIEVEMENTS.map((a) => a.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('lookup by id works', () => {
    assert.ok(serverAchievementById('welcome_to_the_club'));
    assert.equal(serverAchievementById('nope'), undefined);
  });

  test('unlocked list filters out retired ids', () => {
    db.unlockServerAchievement(GUILD, 'welcome_to_the_club', T0);
    db.unlockServerAchievement(GUILD, 'a_retired_tier', T0);
    const unlocked = getUnlockedServerAchievements(db, GUILD);
    assert.deepEqual(unlocked.map((r) => r.achievement_id), ['welcome_to_the_club']);
  });
});

describe('computeServerMetrics', () => {
  test('an empty guild produces zeroes, not errors', () => {
    const metrics = computeServerMetrics(db, GUILD, T0);
    assert.equal(metrics.trackedPlayers, 0);
    assert.equal(metrics.gamesTracked, 0);
    assert.equal(metrics.totalHours, 0);
    assert.equal(metrics.topGameHours, 0);
    assert.equal(metrics.topGameHoursName, null);
    assert.equal(metrics.concurrentGames, 0);
    assert.equal(metrics.qualifiedDuoPairs, 0);
  });

  test('aggregates players, games and combined hours', () => {
    playSession(db, GUILD, 'a', 'PEAK', T0, 2 * HOUR);
    playSession(db, GUILD, 'b', 'Other', T0, HOUR);
    const metrics = computeServerMetrics(db, GUILD, T0 + 5 * HOUR);
    assert.equal(metrics.trackedPlayers, 2);
    assert.equal(metrics.gamesTracked, 2);
    assert.equal(metrics.totalHours, 3);
  });

  test('identifies the dominant game by hours and by player count', () => {
    playSession(db, GUILD, 'a', 'Dominant', T0, 5 * HOUR);
    playSession(db, GUILD, 'b', 'Dominant', T0, HOUR);
    playSession(db, GUILD, 'c', 'Rare', T0, 30 * MINUTE);
    const metrics = computeServerMetrics(db, GUILD, T0 + 10 * HOUR);
    assert.equal(metrics.topGameHoursName, 'Dominant');
    assert.equal(metrics.topGamePlayerCountName, 'Dominant');
    assert.equal(metrics.topGamePlayerCount, 2);
  });

  test('counts games being played concurrently right now', () => {
    db.startSession(GUILD, 'a', 'One', T0);
    db.startSession(GUILD, 'b', 'Two', T0);
    db.startSession(GUILD, 'c', 'Three', T0);
    assert.equal(computeServerMetrics(db, GUILD, T0 + MINUTE).concurrentGames, 3);
  });

  test('counts combined personal achievement unlocks', () => {
    db.unlockAchievement(GUILD, 'a', 'first_steps', T0);
    db.unlockAchievement(GUILD, 'b', 'first_steps', T0);
    db.unlockAchievement(GUILD, 'b', 'collector', T0);
    assert.equal(computeServerMetrics(db, GUILD, T0).totalPersonalUnlocks, 3);
  });
});

describe('community growth and library tiers', () => {
  test('player tiers unlock as members join', () => {
    playSession(db, GUILD, 'a', 'G1', T0, 10 * MINUTE);
    playSession(db, GUILD, 'b', 'G2', T0, 10 * MINUTE);
    assert.ok(unlockedIds(T0 + HOUR).has('welcome_to_the_club'), 'fires at 2 players');

    playSession(db, GUILD, 'c', 'G3', T0, 10 * MINUTE);
    playSession(db, GUILD, 'd', 'G4', T0, 10 * MINUTE);
    assert.ok(unlockedIds(T0 + 2 * HOUR).has('growing_community'), 'fires at 4 players');
  });

  test('game library tiers unlock as new games appear', () => {
    for (const game of ['A', 'B', 'C']) playSession(db, GUILD, 'a', game, T0, HOUR);
    assert.ok(unlockedIds(T0 + 4 * HOUR).has('getting_started'));

    for (const game of ['D', 'E', 'F']) playSession(db, GUILD, 'a', game, T0, HOUR);
    assert.ok(unlockedIds(T0 + 8 * HOUR).has('game_library'));
  });

  test('briefly launched games do not pad the server library', () => {
    for (const game of ['A', 'B', 'C']) playSession(db, GUILD, 'a', game, T0, 5 * SECOND);
    assert.ok(!unlockedIds(T0 + HOUR).has('getting_started'), 'three glances is not a library');
  });

  test('a game counts once the server collectively reaches an hour in it', () => {
    for (const game of ['A', 'B']) playSession(db, GUILD, 'a', game, T0, HOUR);
    // Nobody clears an hour on Shared alone, but between them the server does.
    playSession(db, GUILD, 'a', 'Shared', T0, 40 * MINUTE);
    playSession(db, GUILD, 'b', 'Shared', T0, 40 * MINUTE);
    assert.ok(unlockedIds(T0 + 4 * HOUR).has('getting_started'));
  });

  test('combined playtime tiers unlock', () => {
    playSession(db, GUILD, 'a', 'A', T0, 5 * HOUR);
    assert.ok(unlockedIds(T0 + 10 * HOUR).has('getting_somewhere'));
    playSession(db, GUILD, 'b', 'B', T0 + 10 * HOUR, 5 * HOUR);
    assert.ok(unlockedIds(T0 + 20 * HOUR).has('getting_serious'));
  });
});

describe('game dominance', () => {
  test('dominance-by-hours tiers unlock for a single popular game', () => {
    playSession(db, GUILD, 'a', 'Favourite', T0, 4 * HOUR);
    assert.ok(unlockedIds(T0 + 10 * HOUR).has('server_favorite'));
  });

  test('dominance-by-players counts distinct members on one game', () => {
    for (const user of ['a', 'b', 'c']) playSession(db, GUILD, user, 'Shared', T0, HOUR);
    assert.ok(unlockedIds(T0 + 2 * HOUR).has('we_all_play_this'));
  });

  test('dominance-by-players ignores members who only glanced at the game', () => {
    for (const user of ['a', 'b']) playSession(db, GUILD, user, 'Shared', T0, HOUR);
    for (const user of ['c', 'd', 'e']) playSession(db, GUILD, user, 'Shared', T0, 10 * SECOND);
    assert.ok(!unlockedIds(T0 + 2 * HOUR).has('we_all_play_this'), 'only two members really play it');
  });

  test('celebration text reports live values, not the threshold', () => {
    for (const user of ['a', 'b', 'c', 'd', 'e']) playSession(db, GUILD, user, 'Shared', T0, HOUR);
    const { unlocked } = evaluateServerAchievements(db, GUILD, T0 + 2 * HOUR);
    const tier = unlocked.find((t) => t.id === 'we_all_play_this');
    assert.ok(tier.celebration.includes('5'), `expected the real count of 5 in: ${tier.celebration}`);
  });

  test('player-growth celebration reports the real player count', () => {
    for (const user of ['a', 'b', 'c', 'd']) playSession(db, GUILD, user, `G${user}`, T0, MINUTE);
    const { unlocked } = evaluateServerAchievements(db, GUILD, T0 + HOUR);
    const tier = unlocked.find((t) => t.id === 'welcome_to_the_club');
    assert.ok(tier.celebration.includes('4'), `expected 4 players in: ${tier.celebration}`);
  });
});

describe('melting pot, rush hour and always on', () => {
  test('melting_pot needs three games running at once', () => {
    db.startSession(GUILD, 'a', 'One', T0);
    db.startSession(GUILD, 'b', 'Two', T0);
    assert.ok(!unlockedIds(T0 + MINUTE).has('melting_pot'));
    db.startSession(GUILD, 'c', 'Three', T0);
    assert.ok(unlockedIds(T0 + 2 * MINUTE).has('melting_pot'));
  });

  test('rush_hour counts distinct games started across the server today', () => {
    const dayStart = Date.UTC(2026, 5, 15);
    for (const [i, game] of ['A', 'B', 'C', 'D'].entries()) {
      playSession(db, GUILD, `u${i}`, game, dayStart + HOUR + i * MINUTE, MINUTE);
    }
    assert.ok(unlockedIds(dayStart + 6 * HOUR).has('rush_hour'));
  });

  test('always_on tracks a server-wide streak where any member counts', () => {
    // Three consecutive days, a different member each day.
    playSession(db, GUILD, 'a', 'G', Date.parse('2026-06-13T10:00:00Z'), HOUR);
    playSession(db, GUILD, 'b', 'G', Date.parse('2026-06-14T10:00:00Z'), HOUR);
    playSession(db, GUILD, 'c', 'G', Date.parse('2026-06-15T10:00:00Z'), HOUR);
    assert.ok(unlockedIds(Date.parse('2026-06-15T20:00:00Z')).has('always_on'));
  });

  test('a gap prevents the always_on streak', () => {
    playSession(db, GUILD, 'a', 'G', Date.parse('2026-06-10T10:00:00Z'), HOUR);
    playSession(db, GUILD, 'b', 'G', Date.parse('2026-06-14T10:00:00Z'), HOUR);
    playSession(db, GUILD, 'c', 'G', Date.parse('2026-06-15T10:00:00Z'), HOUR);
    assert.ok(!unlockedIds(Date.parse('2026-06-15T20:00:00Z')).has('always_on'));
  });
});

describe('trophy case, full spectrum and squad bonds', () => {
  test('trophy_case counts combined personal unlocks', () => {
    db.unlockAchievement(GUILD, 'a', 'first_steps', T0);
    db.unlockAchievement(GUILD, 'b', 'first_steps', T0);
    assert.ok(unlockedIds(T0 + HOUR).has('trophy_case'));
  });

  test('full_spectrum needs every rank tier occupied at once', () => {
    // Give one member enough time to sit in each configured rank tier.
    RANK_HOURS.forEach((hours, index) => {
      playSession(db, GUILD, `tier${index}`, 'Grind', T0, hours * HOUR);
    });
    assert.ok(unlockedIds(T0 + 500 * HOUR).has('full_spectrum'));
  });

  test('full_spectrum stays locked while a tier is empty', () => {
    // Everyone sits in the lowest tier only.
    for (const user of ['a', 'b', 'c']) playSession(db, GUILD, user, 'Grind', T0, RANK_HOURS[0] * HOUR);
    assert.ok(!unlockedIds(T0 + 100 * HOUR).has('full_spectrum'));
  });

  test('squad_bonds counts distinct qualifying pairs', () => {
    for (let day = 0; day < 5; day++) {
      db.recordDuoDay(GUILD, 'a', 'b', `2026-06-0${day + 1}`);
      db.recordDuoDay(GUILD, 'c', 'd', `2026-06-0${day + 1}`);
    }
    assert.ok(unlockedIds(T0).has('squad_bonds'));
  });

  test('one qualifying pair is not enough', () => {
    for (let day = 0; day < 5; day++) db.recordDuoDay(GUILD, 'a', 'b', `2026-06-0${day + 1}`);
    assert.ok(!unlockedIds(T0).has('squad_bonds'));
  });
});

describe('unlock semantics', () => {
  test('a tier never unlocks twice', () => {
    playSession(db, GUILD, 'a', 'G1', T0, 10 * MINUTE);
    playSession(db, GUILD, 'b', 'G2', T0, 10 * MINUTE);
    assert.ok(unlockedIds(T0 + HOUR).has('welcome_to_the_club'));
    assert.equal(evaluateServerAchievements(db, GUILD, T0 + 2 * HOUR).unlocked.length, 0);
  });

  test('crossing several tiers at once unlocks each of them', () => {
    for (const user of ['a', 'b', 'c', 'd']) playSession(db, GUILD, user, `G${user}`, T0, MINUTE);
    const ids = unlockedIds(T0 + HOUR);
    assert.ok(ids.has('welcome_to_the_club'));
    assert.ok(ids.has('growing_community'));
  });

  test('guilds unlock independently', () => {
    playSession(db, GUILD, 'a', 'G1', T0, MINUTE);
    playSession(db, GUILD, 'b', 'G2', T0, MINUTE);
    unlockedIds(T0 + HOUR);
    const other = new Set(evaluateServerAchievements(db, 'guild-2', T0 + HOUR).unlocked.map((t) => t.id));
    assert.equal(other.size, 0, 'an empty second guild unlocks nothing');
  });
});
