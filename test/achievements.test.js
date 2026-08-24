import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACHIEVEMENTS, achievementById, getUnlockedAchievements, currentStreak, DUO_DAYS_NEEDED,
  evaluateSessionStart, evaluateSessionEnd, evaluateOngoingSession, evaluateSocialTiers,
  evaluateDuoDays, evaluateTouchGrass,
} from '../src/achievements.js';
import { RANK_HOURS } from '../src/ranks.js';
import { tempDatabase, playSession, SECOND, HOUR, MINUTE, DAY, T0 } from './helpers.js';

const GUILD = 'guild-1';
const USER = 'user-1';
/** Just enough playtime to clear the first rank, whatever RANK_HOURS is configured to. */
const RANKED_MS = RANK_HOURS[0] * HOUR;

let db;
let cleanup;
beforeEach(() => { ({ db, cleanup } = tempDatabase()); });
afterEach(() => cleanup());

/** Plays a session and runs both the start and end evaluators, as the live bot does. */
function play(userId, gameName, startAt, durationMs) {
  const { previous } = db.startSession(GUILD, userId, gameName, startAt);
  if (previous) evaluateSessionEnd(db, GUILD, userId, previous, startAt);
  evaluateSessionStart(db, GUILD, userId, gameName, startAt);
  const endAt = startAt + durationMs;
  const completed = db.stopSession(GUILD, userId, endAt);
  return completed ? evaluateSessionEnd(db, GUILD, userId, completed, endAt) : [];
}

describe('achievement catalogue', () => {
  test('every achievement has the required fields', () => {
    for (const achievement of ACHIEVEMENTS) {
      assert.ok(achievement.id, 'id is required');
      assert.ok(achievement.name, `${achievement.id} needs a name`);
      assert.ok(achievement.emoji, `${achievement.id} needs an emoji`);
      assert.ok(achievement.description, `${achievement.id} needs a description`);
    }
  });

  test('ids are unique', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('names are unique, so announcements are never ambiguous', () => {
    const names = ACHIEVEMENTS.map((a) => a.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('lookup by id works and misses resolve to undefined', () => {
    assert.equal(achievementById('first_steps').name, 'First Steps');
    assert.equal(achievementById('nope'), undefined);
  });

  test('getUnlockedAchievements filters out retired ids', () => {
    db.unlockAchievement(GUILD, USER, 'first_steps', T0);
    db.unlockAchievement(GUILD, USER, 'a_retired_achievement', T0);
    const unlocked = getUnlockedAchievements(db, GUILD, USER);
    assert.deepEqual(unlocked.map((r) => r.achievement_id), ['first_steps']);
  });
});

describe('currentStreak', () => {
  test('empty history is a zero streak', () => {
    assert.equal(currentStreak([]), 0);
  });

  test('a single day is a streak of one', () => {
    assert.equal(currentStreak(['2026-06-15']), 1);
  });

  test('consecutive days accumulate', () => {
    assert.equal(currentStreak(['2026-06-15', '2026-06-14', '2026-06-13']), 3);
  });

  test('a gap ends the streak', () => {
    assert.equal(currentStreak(['2026-06-15', '2026-06-14', '2026-06-11']), 2);
  });

  test('streaks span month boundaries', () => {
    assert.equal(currentStreak(['2026-07-01', '2026-06-30', '2026-06-29']), 3);
  });
});

describe('first steps and collection tiers', () => {
  test('first_steps fires on a genuinely first session', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'PEAK', T0);
    assert.ok(unlocked.includes('first_steps'));
  });

  test('first_steps still fires for a player whose history predates achievements', () => {
    // playSession writes history without running the evaluators, which is exactly the state of a
    // member who was being tracked before achievements shipped: playtime, but no unlock rows.
    playSession(db, GUILD, USER, 'A', T0, HOUR);
    db.startSession(GUILD, USER, 'B', T0 + 2 * HOUR);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'B', T0 + 2 * HOUR);
    assert.ok(unlocked.includes('first_steps'));
  });

  const tiers = [[10, 'collector'], [25, 'game_hoarder'], [50, 'the_backlog'], [75, 'send_help']];
  test('collection tiers fire at exactly their thresholds', () => {
    let t = T0;
    const firedAt = new Map();
    for (let i = 1; i <= 75; i++) {
      for (const id of play(USER, `Game${i}`, t, HOUR)) if (!firedAt.has(id)) firedAt.set(id, i);
      t += HOUR;
    }
    for (const [threshold, id] of tiers) {
      assert.equal(firedAt.get(id), threshold, `${id} should fire at game ${threshold}`);
    }
  });

  test('games launched briefly do not count toward the collection tiers', () => {
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 20; i++) {
      for (const id of play(USER, `Game${i}`, t, 30 * SECOND)) fired.add(id);
      t += MINUTE;
    }
    assert.ok(!fired.has('collector'), 'twenty drive-by launches should not clear a ten-game tier');
  });

  test('a game reaching an hour across several short sessions does count', () => {
    let t = T0;
    for (let i = 1; i <= 9; i++) {
      play(USER, `Game${i}`, t, HOUR);
      t += HOUR;
    }
    const fired = new Set();
    // The tenth game gets there in four sittings rather than one.
    for (let i = 0; i < 4; i++) {
      for (const id of play(USER, 'Game10', t, 15 * MINUTE)) fired.add(id);
      t += 20 * MINUTE;
    }
    assert.ok(fired.has('collector'), 'cumulative time should count, not just one long session');
  });
});

describe('session length tiers', () => {
  const tiers = [[3, 'just_one_more_game'], [5, 'should_go_to_bed'], [8, 'sleep_is_optional'], [11, 'what_day_is_it']];

  for (const [hours, id] of tiers) {
    test(`${id} fires at ${hours}h but not just under`, () => {
      db.startSession(GUILD, USER, 'Marathon', T0);
      const justUnder = evaluateOngoingSession(db, GUILD, USER, 'Marathon', T0, T0 + hours * HOUR - MINUTE);
      assert.ok(!justUnder.includes(id), `${id} must not fire early`);
      const atThreshold = evaluateOngoingSession(db, GUILD, USER, 'Marathon', T0, T0 + hours * HOUR);
      assert.ok(atThreshold.includes(id), `${id} must fire at ${hours}h`);
    });
  }

  test('a long session also awards the tiers when it ends', () => {
    const unlocked = play(USER, 'Marathon', T0, 6 * HOUR);
    assert.ok(unlocked.includes('just_one_more_game'));
    assert.ok(unlocked.includes('should_go_to_bed'));
    assert.ok(!unlocked.includes('sleep_is_optional'));
  });

  test('wrong_game fires for a very short session', () => {
    const unlocked = play(USER, 'Oops', T0, 10 * 1000);
    assert.ok(unlocked.includes('wrong_game'));
  });

  test('wrong_game does not fire for a normal session', () => {
    const unlocked = play(USER, 'Normal', T0, HOUR);
    assert.ok(!unlocked.includes('wrong_game'));
  });
});

describe("I Can't Stop Playing (repeat 1h+ sessions)", () => {
  test('three 1h+ sessions of one game in a day unlock it', () => {
    let t = T0;
    for (let i = 0; i < 3; i++) {
      play(USER, 'PEAK', t, HOUR);
      t += HOUR + 10 * MINUTE;
    }
    assert.ok(db.hasAchievement(GUILD, USER, 'surely_not'));
  });

  test('short repeat sessions do not count', () => {
    let t = T0;
    for (let i = 0; i < 5; i++) {
      play(USER, 'PEAK', t, 3 * MINUTE);
      t += 10 * MINUTE;
    }
    assert.ok(!db.hasAchievement(GUILD, USER, 'surely_not'));
  });

  test('it unlocks mid-session once the third crosses an hour', () => {
    let t = T0;
    for (let i = 0; i < 2; i++) {
      play(USER, 'PEAK', t, HOUR + MINUTE);
      t += 2 * HOUR;
    }
    assert.ok(!db.hasAchievement(GUILD, USER, 'surely_not'));
    db.startSession(GUILD, USER, 'PEAK', t);
    const halfway = evaluateOngoingSession(db, GUILD, USER, 'PEAK', t, t + 30 * MINUTE);
    assert.ok(!halfway.includes('surely_not'));
    const atHour = evaluateOngoingSession(db, GUILD, USER, 'PEAK', t, t + HOUR);
    assert.ok(atHour.includes('surely_not'));
  });

  test('sessions from a previous day do not carry over', () => {
    play(USER, 'PEAK', Date.parse('2026-06-14T10:00:00Z'), HOUR);
    play(USER, 'PEAK', Date.parse('2026-06-14T14:00:00Z'), HOUR);
    play(USER, 'PEAK', Date.parse('2026-06-15T10:00:00Z'), HOUR);
    assert.ok(!db.hasAchievement(GUILD, USER, 'surely_not'));
  });

  test('sessions of different games do not combine', () => {
    let t = T0;
    for (const game of ['A', 'B', 'C']) {
      play(USER, game, t, HOUR + MINUTE);
      t += 2 * HOUR;
    }
    assert.ok(!db.hasAchievement(GUILD, USER, 'surely_not'));
  });
});

describe('variety and rapid switching', () => {
  test('variety_is_overrated at 3 games in a day, identity_crisis at 6', () => {
    // T0 is midday, so six back-to-back hours stay inside the same UTC day.
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 6; i++) {
      for (const id of play(USER, `G${i}`, t, HOUR)) fired.add(id);
      if (i === 2) assert.ok(!fired.has('variety_is_overrated'), 'two games is not enough');
      if (i === 5) assert.ok(!fired.has('identity_crisis'), 'five games is not enough');
      t += HOUR;
    }
    assert.ok(fired.has('variety_is_overrated'));
    assert.ok(fired.has('identity_crisis'));
  });

  test('three games barely touched do not unlock variety_is_overrated', () => {
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 3; i++) {
      for (const id of play(USER, `G${i}`, t, SECOND)) fired.add(id);
      t += MINUTE;
    }
    assert.ok(!fired.has('variety_is_overrated'), 'a second per game is not playing three games');
  });

  test('variety_is_overrated lands mid-session, without waiting for the third game to end', () => {
    const t = T0;
    play(USER, 'G1', t, HOUR);
    play(USER, 'G2', t + HOUR, HOUR);
    const startedAt = t + 2 * HOUR;
    db.startSession(GUILD, USER, 'G3', startedAt);
    const justShort = evaluateOngoingSession(db, GUILD, USER, 'G3', startedAt, startedAt + 59 * MINUTE);
    assert.ok(!justShort.includes('variety_is_overrated'), 'not yet an hour into the third game');
    const crossed = evaluateOngoingSession(db, GUILD, USER, 'G3', startedAt, startedAt + HOUR);
    assert.ok(crossed.includes('variety_is_overrated'));
  });

  test('idle time does not push a game over the bar', () => {
    const t = T0;
    play(USER, 'G1', t, HOUR);
    play(USER, 'G2', t + HOUR, HOUR);
    const startedAt = t + 2 * HOUR;
    db.startSession(GUILD, USER, 'G3', startedAt);
    // An hour on the clock, but half of it spent idle.
    const unlocked = evaluateOngoingSession(db, GUILD, USER, 'G3', startedAt, startedAt + HOUR, 30 * MINUTE);
    assert.ok(!unlocked.includes('variety_is_overrated'), 'AFK minutes should not count as played');
  });

  test('speedrunner needs 5 games of 10+ minutes inside three hours', () => {
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 5; i++) {
      for (const id of play(USER, `S${i}`, t, 12 * MINUTE)) fired.add(id);
      if (i === 4) assert.ok(!fired.has('speedrunner'), 'four games is not enough');
      t += 15 * MINUTE;
    }
    assert.ok(fired.has('speedrunner'));
  });

  test('speedrunner ignores games dropped inside ten minutes', () => {
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 5; i++) {
      for (const id of play(USER, `S${i}`, t, 4 * MINUTE)) fired.add(id);
      t += 5 * MINUTE;
    }
    assert.ok(!fired.has('speedrunner'), 'five quick bounces are not five games played');
  });

  test('speedrunner will not count games spread beyond the three-hour window', () => {
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 5; i++) {
      for (const id of play(USER, `S${i}`, t, 12 * MINUTE)) fired.add(id);
      t += 50 * MINUTE; // the first game has aged out by the time the fifth is done
    }
    assert.ok(!fired.has('speedrunner'));
  });

  test('speedrunner and speed_dating cannot describe the same game', () => {
    // 10 minutes exactly: at or above Speedrunner's bar, below The Speed Dating's ceiling.
    const boundary = 10 * MINUTE;
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 5; i++) {
      for (const id of play(USER, `B${i}`, t, boundary)) fired.add(id);
      t += 15 * MINUTE;
    }
    assert.ok(fired.has('speedrunner'), 'exactly ten minutes counts for speedrunner');
    assert.ok(!fired.has('speed_dating'), 'and is not short enough for speed dating');
  });

  test('technical_difficulties needs 5 starts of the SAME game inside ten minutes', () => {
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 5; i++) {
      db.startSession(GUILD, USER, 'Crashy', t);
      for (const id of evaluateSessionStart(db, GUILD, USER, 'Crashy', t, null)) fired.add(id);
      db.stopSession(GUILD, USER, t + 30_000);
      t += MINUTE;
    }
    assert.ok(fired.has('technical_difficulties'));
  });

  test('technical_difficulties ignores starts of other games', () => {
    let t = T0;
    const fired = new Set();
    for (let i = 1; i <= 8; i++) {
      const game = i % 2 === 0 ? 'Crashy' : `Other${i}`;
      db.startSession(GUILD, USER, game, t);
      for (const id of evaluateSessionStart(db, GUILD, USER, game, t, null)) fired.add(id);
      db.stopSession(GUILD, USER, t + 30_000);
      t += MINUTE;
    }
    assert.ok(!fired.has('technical_difficulties'), 'only 4 of the 8 starts were the same game');
  });

  test('the_betrayal fires when a game is abandoned within a minute', () => {
    db.startSession(GUILD, USER, 'Abandoned', T0);
    db.startSession(GUILD, USER, 'Replacement', T0 + 30 * SECOND);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'Replacement', T0 + 30 * SECOND);
    assert.ok(unlocked.includes('the_betrayal'));
  });

  test('the_betrayal does not fire when the abandoned game lasted over a minute', () => {
    db.startSession(GUILD, USER, 'Tolerated', T0);
    db.startSession(GUILD, USER, 'Replacement', T0 + 90 * SECOND);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'Replacement', T0 + 90 * SECOND);
    assert.ok(!unlocked.includes('the_betrayal'), '90 seconds is past the 1-minute cutoff');
  });

  test('the_betrayal fires when the first game is fully quit before the next one starts', () => {
    // Discord reports closing a game and opening another as two updates with a gap in between,
    // so the switch never arrives as a single event — this is the path real players hit.
    db.startSession(GUILD, USER, 'Abandoned', T0);
    db.stopSession(GUILD, USER, T0 + 30 * SECOND);
    const startAt = T0 + 30 * SECOND + 20_000;
    const { previous } = db.startSession(GUILD, USER, 'Replacement', startAt);
    assert.equal(previous, null, 'nothing was running, so there is no in-memory previous session');
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'Replacement', startAt);
    assert.ok(unlocked.includes('the_betrayal'));
  });

  test('the_betrayal does not fire after a long session', () => {
    db.startSession(GUILD, USER, 'Enjoyed', T0);
    db.startSession(GUILD, USER, 'Next', T0 + 2 * HOUR);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'Next', T0 + 2 * HOUR);
    assert.ok(!unlocked.includes('the_betrayal'));
  });

  test('the_betrayal does not fire when the next game comes much later', () => {
    // The abandoned session is short enough to qualify on duration, so the grace period is the
    // only thing that can be blocking this — otherwise the test would pass for the wrong reason.
    db.startSession(GUILD, USER, 'Abandoned', T0);
    db.stopSession(GUILD, USER, T0 + 30 * SECOND);
    const startAt = T0 + 3 * HOUR;
    db.startSession(GUILD, USER, 'Unrelated', startAt);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'Unrelated', startAt);
    assert.ok(!unlocked.includes('the_betrayal'), 'a short session hours ago is not a betrayal');
  });

  test('the_betrayal does not fire when relaunching the same game', () => {
    db.startSession(GUILD, USER, 'Crashy', T0);
    db.stopSession(GUILD, USER, T0 + 30 * SECOND);
    const startAt = T0 + 30 * SECOND + 20_000;
    db.startSession(GUILD, USER, 'Crashy', startAt);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'Crashy', startAt);
    assert.ok(!unlocked.includes('the_betrayal'));
  });

  test('speed_dating needs four short games in one day', () => {
    let t = T0;
    for (const game of ['A', 'B', 'C']) {
      play(USER, game, t, 5 * MINUTE);
      t += 30 * MINUTE;
    }
    assert.ok(!db.hasAchievement(GUILD, USER, 'speed_dating'), 'three is Variety Is Overrated territory');
    play(USER, 'D', t, 5 * MINUTE);
    assert.ok(db.hasAchievement(GUILD, USER, 'speed_dating'));
  });
});

describe('return-after-absence tiers', () => {
  const gaps = [[61, 'back_again'], [181, 'the_return'], [366, 'forgotten_game']];

  for (const [days, id] of gaps) {
    test(`${id} fires after a ${days}-day gap`, () => {
      play(USER, 'PEAK', T0, HOUR);
      const returnAt = T0 + days * DAY;
      db.startSession(GUILD, USER, 'PEAK', returnAt);
      const unlocked = evaluateSessionStart(db, GUILD, USER, 'PEAK', returnAt);
      assert.ok(unlocked.includes(id));
    });
  }

  test('a short gap awards nothing', () => {
    play(USER, 'PEAK', T0, HOUR);
    const returnAt = T0 + 5 * DAY;
    db.startSession(GUILD, USER, 'PEAK', returnAt);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'PEAK', returnAt);
    assert.ok(!unlocked.includes('back_again'));
  });

  test('welcome_back fires after a fortnight away from everything', () => {
    play(USER, 'A', T0, RANKED_MS);
    const returnAt = T0 + 20 * DAY;
    db.startSession(GUILD, USER, 'B', returnAt);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'B', returnAt);
    assert.ok(unlocked.includes('welcome_back'));
  });

  test('welcome_back skips anyone who never reached the first rank', () => {
    play(USER, 'A', T0, Math.max(MINUTE, RANKED_MS - MINUTE));
    const returnAt = T0 + 20 * DAY;
    db.startSession(GUILD, USER, 'B', returnAt);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'B', returnAt);
    assert.ok(!unlocked.includes('welcome_back'), 'they were never established enough to be missed');
  });

  test('the returning session itself does not count towards the rank gate', () => {
    // The comeback session has banked no time yet, so a long-awaited return by someone who never
    // ranked must not qualify just because this visit will eventually be a long one.
    play(USER, 'A', T0, Math.max(MINUTE, RANKED_MS - MINUTE));
    const returnAt = T0 + 20 * DAY;
    db.startSession(GUILD, USER, 'B', returnAt);
    const unlocked = evaluateSessionStart(db, GUILD, USER, 'B', returnAt, null);
    assert.ok(!unlocked.includes('welcome_back'));
  });
});

describe('loyalty, consistency and milestones', () => {
  test("can't_let_go at 45 days, one_true_game at 90, on the same game", () => {
    const fired = new Set();
    for (let day = 0; day < 90; day++) {
      const t = T0 + day * DAY;
      db.startSession(GUILD, USER, 'PEAK', t);
      for (const id of evaluateSessionStart(db, GUILD, USER, 'PEAK', t)) fired.add(id);
      db.stopSession(GUILD, USER, t + HOUR);
    }
    assert.ok(fired.has('cant_let_go'));
    assert.ok(fired.has('one_true_game'));
  });

  test('no two day-count awards can land on the same day', () => {
    // The mono-game player on an unbroken streak is the worst case: days-on-this-game, days-played
    // and streak-length are all the same number, so every day-based threshold is measured against
    // the same counter. If any two share a value they fire together and read as a duplicate.
    const DAY_BASED = ['regular', 'dedicated', 'legend', 'no_days_off', 'habit', 'cant_let_go', 'one_true_game'];
    const RUN_DAYS = 360;
    const dayFired = new Map();
    for (let day = 0; day < RUN_DAYS; day++) {
      const t = T0 + day * DAY;
      db.startSession(GUILD, USER, 'PEAK', t);
      for (const id of evaluateSessionStart(db, GUILD, USER, 'PEAK', t)) {
        if (DAY_BASED.includes(id)) dayFired.set(id, day + 1);
      }
      db.stopSession(GUILD, USER, t + HOUR);
    }
    for (const id of DAY_BASED) {
      assert.ok(dayFired.has(id), `${id} should unlock within ${RUN_DAYS} unbroken days`);
    }
    for (let i = 0; i < DAY_BASED.length; i++) {
      for (let j = i + 1; j < DAY_BASED.length; j++) {
        const [a, b] = [DAY_BASED[i], DAY_BASED[j]];
        assert.notEqual(dayFired.get(a), dayFired.get(b),
          `${a} and ${b} both landed on day ${dayFired.get(a)}`);
      }
    }
  });

  test('every day-count threshold is a distinct number', () => {
    // The cheap structural twin of the simulation above: catches a clashing threshold the moment
    // it is typed, without waiting on a 360-day replay.
    const DAY_BASED = ['regular', 'dedicated', 'legend', 'no_days_off', 'habit', 'cant_let_go', 'one_true_game'];
    const thresholds = DAY_BASED.map((id) => {
      const match = /(\d+)/.exec(achievementById(id).description);
      assert.ok(match, `${id} should state its day count in its description`);
      return Number(match[1]);
    });
    assert.equal(new Set(thresholds).size, thresholds.length,
      `two day-count awards share a threshold: ${thresholds.join(', ')}`);
  });

  test('regular/dedicated/legend track distinct days across any game', () => {
    const fired = new Set();
    for (let day = 0; day < 360; day++) {
      const t = T0 + day * DAY;
      db.startSession(GUILD, USER, `G${day % 3}`, t);
      for (const id of evaluateSessionStart(db, GUILD, USER, `G${day % 3}`, t)) fired.add(id);
      db.stopSession(GUILD, USER, t + HOUR);
    }
    assert.ok(fired.has('regular'));
    assert.ok(fired.has('dedicated'));
    assert.ok(fired.has('legend'));
  });

  test('consecutive-day streaks award no_days_off at 14 and habit at 30', () => {
    const fired = new Set();
    const playDay = (day) => {
      const t = T0 + day * DAY;
      db.startSession(GUILD, USER, 'PEAK', t);
      for (const id of evaluateSessionStart(db, GUILD, USER, 'PEAK', t)) fired.add(id);
      db.stopSession(GUILD, USER, t + HOUR);
    };
    for (let day = 0; day < 13; day++) playDay(day);
    assert.ok(!fired.has('no_days_off'), '13 days in a row is not enough');
    playDay(13);
    assert.ok(fired.has('no_days_off'));
    for (let day = 14; day < 29; day++) playDay(day);
    assert.ok(!fired.has('habit'), '29 days in a row is not enough');
    playDay(29);
    assert.ok(fired.has('habit'));
  });

  test('a broken streak does not award the streak tiers', () => {
    const fired = new Set();
    for (let day = 0; day < 70; day++) {
      if (day === 9) continue; // one missed day resets the run
      const t = T0 + day * DAY;
      db.startSession(GUILD, USER, 'PEAK', t);
      for (const id of evaluateSessionStart(db, GUILD, USER, 'PEAK', t)) fired.add(id);
      db.stopSession(GUILD, USER, t + HOUR);
    }
    assert.ok(fired.has('no_days_off'), 'the run after the gap is 60 days, well past 14');
    assert.ok(fired.has('regular'), '69 distinct days also clears attendance');

    const broken = tempDatabase();
    try {
      for (let day = 0; day < 70; day++) {
        if (day % 10 === 9) continue; // a gap every tenth day caps every run at 9
        const t = T0 + day * DAY;
        broken.db.startSession(GUILD, USER, 'PEAK', t);
        evaluateSessionStart(broken.db, GUILD, USER, 'PEAK', t);
        broken.db.stopSession(GUILD, USER, t + HOUR);
      }
      assert.ok(!broken.db.hasAchievement(GUILD, USER, 'no_days_off'), 'no run ever reaches 14');
      assert.ok(broken.db.hasAchievement(GUILD, USER, 'regular'), 'but 63 distinct days still counts');
    } finally {
      broken.cleanup();
    }
  });

  test('trailblazer goes to the first player of a game only', () => {
    db.startSession(GUILD, 'pioneer', 'BrandNew', T0);
    assert.ok(evaluateSessionStart(db, GUILD, 'pioneer', 'BrandNew', T0).includes('trailblazer'));
    db.startSession(GUILD, 'follower', 'BrandNew', T0 + HOUR);
    assert.ok(!evaluateSessionStart(db, GUILD, 'follower', 'BrandNew', T0 + HOUR).includes('trailblazer'));
  });

  // The live caller checkpoints before evaluating, so game_stats already holds the whole session
  // by the time this runs — mirror that order here or the test measures a fiction.
  test('the_whale needs 120 hours on one game', () => {
    db.startSession(GUILD, USER, 'Obsession', T0);
    db.checkpointAll(T0 + 119 * HOUR);
    const under = evaluateOngoingSession(db, GUILD, USER, 'Obsession', T0, T0 + 119 * HOUR);
    assert.ok(!under.includes('the_whale'));
    db.checkpointAll(T0 + 120 * HOUR);
    const over = evaluateOngoingSession(db, GUILD, USER, 'Obsession', T0, T0 + 120 * HOUR);
    assert.ok(over.includes('the_whale'));
  });

  test('the_whale does not fire early on the strength of a long session', () => {
    playSession(db, GUILD, USER, 'Obsession', T0 - 200 * HOUR, 115 * HOUR);
    db.startSession(GUILD, USER, 'Obsession', T0);
    db.checkpointAll(T0 + 4 * HOUR);
    const unlocked = evaluateOngoingSession(db, GUILD, USER, 'Obsession', T0, T0 + 4 * HOUR);
    assert.equal(db.getGameStatsTotal(GUILD, USER, 'Obsession'), 119 * 3600);
    assert.ok(!unlocked.includes('the_whale'));
  });

  test('an idle overnight session earns no marathon badge', () => {
    db.startSession(GUILD, USER, 'Marathon', T0);
    // Twelve hours of wall clock, eleven of them idle: worth two hours, not a long-session tier.
    const unlocked = evaluateOngoingSession(db, GUILD, USER, 'Marathon', T0, T0 + 12 * HOUR, 10 * HOUR);
    assert.deepEqual(unlocked, []);
  });

  test('active time still earns the tier once idle time is discounted', () => {
    db.startSession(GUILD, USER, 'Marathon', T0);
    const unlocked = evaluateOngoingSession(db, GUILD, USER, 'Marathon', T0, T0 + 12 * HOUR, 9 * HOUR);
    assert.ok(unlocked.includes('just_one_more_game'));
    assert.ok(!unlocked.includes('should_go_to_bed'));
  });

  test('touch_grass is awarded after a fortnight of silence', () => {
    play(USER, 'A', T0, RANKED_MS);
    assert.equal(evaluateTouchGrass(db, GUILD, T0 + 5 * DAY).length, 0);
    const results = evaluateTouchGrass(db, GUILD, T0 + 20 * DAY);
    assert.equal(results.length, 1);
    assert.ok(results[0].unlocked.includes('touch_grass'));
  });

  test('touch_grass skips anyone who never reached the first rank', () => {
    // A single short visit is not a player going quiet, it is someone who never arrived.
    play(USER, 'A', T0, Math.max(MINUTE, RANKED_MS - MINUTE));
    assert.equal(evaluateTouchGrass(db, GUILD, T0 + 20 * DAY).length, 0);
    assert.ok(!db.hasAchievement(GUILD, USER, 'touch_grass'));
  });

  test('touch_grass fires once the same member has earned a rank', () => {
    play(USER, 'A', T0, Math.max(MINUTE, RANKED_MS - MINUTE));
    assert.equal(evaluateTouchGrass(db, GUILD, T0 + 20 * DAY).length, 0);
    play(USER, 'A', T0 + 21 * DAY, RANKED_MS);
    const results = evaluateTouchGrass(db, GUILD, T0 + 40 * DAY);
    assert.equal(results.length, 1);
    assert.ok(results[0].unlocked.includes('touch_grass'));
  });
});

describe('social tiers', () => {
  const tiers = [[2, 'not_alone'], [5, 'party_time'], [8, 'squad_goals'], [12, 'the_pack']];

  test('each tier fires at its exact player count', () => {
    const firedAt = new Map();
    for (let count = 1; count <= 12; count++) {
      db.startSession(GUILD, `p${count}`, 'Lobby', T0 + count * 1000);
      for (const { userId, unlocked } of evaluateSocialTiers(db, GUILD, 'Lobby', T0 + count * 1000)) {
        if (userId !== 'p1') continue;
        for (const id of unlocked) if (!firedAt.has(id)) firedAt.set(id, count);
      }
    }
    for (const [count, id] of tiers) {
      assert.equal(firedAt.get(id), count, `${id} should fire at ${count} players`);
    }
  });

  test('everyone in the lobby is credited, not just the newest joiner', () => {
    db.startSession(GUILD, 'a', 'Lobby', T0);
    db.startSession(GUILD, 'b', 'Lobby', T0 + 1000);
    const results = evaluateSocialTiers(db, GUILD, 'Lobby', T0 + 1000);
    assert.deepEqual(results.map((r) => r.userId).sort(), ['a', 'b']);
  });

  test('herd_mentality needs three others starting within a minute', () => {
    db.startSession(GUILD, 'a', 'Trend', T0);
    db.startSession(GUILD, 'b', 'Trend', T0 + 10 * 1000);
    db.startSession(GUILD, 'c', 'Trend', T0 + 20 * 1000);
    const joinAt = T0 + 30 * 1000;
    db.startSession(GUILD, 'd', 'Trend', joinAt);
    assert.ok(evaluateSessionStart(db, GUILD, 'd', 'Trend', joinAt).includes('herd_mentality'));
  });

  test('herd_mentality ignores players who started too long ago', () => {
    db.startSession(GUILD, 'a', 'Trend', T0);
    db.startSession(GUILD, 'b', 'Trend', T0 + 1000);
    db.startSession(GUILD, 'c', 'Trend', T0 + 2000);
    const lateJoin = T0 + 5 * MINUTE;
    db.startSession(GUILD, 'd', 'Trend', lateJoin);
    assert.ok(!evaluateSessionStart(db, GUILD, 'd', 'Trend', lateJoin).includes('herd_mentality'));
  });
});

describe('duo', () => {
  test(`unlocks for both members after ${DUO_DAYS_NEEDED} shared days`, () => {
    for (let day = 0; day < DUO_DAYS_NEEDED; day++) {
      const t = T0 + day * DAY;
      db.startSession(GUILD, 'a', 'CoOp', t);
      db.startSession(GUILD, 'b', 'CoOp', t + 1000);
      evaluateDuoDays(db, GUILD, 'CoOp', t + 1000);
    }
    assert.ok(db.hasAchievement(GUILD, 'a', 'duo'));
    assert.ok(db.hasAchievement(GUILD, 'b', 'duo'));
  });

  test('a one-off pairing does not unlock it', () => {
    db.startSession(GUILD, 'a', 'CoOp', T0);
    db.startSession(GUILD, 'c', 'CoOp', T0 + 1000);
    evaluateDuoDays(db, GUILD, 'CoOp', T0 + 1000);
    assert.ok(!db.hasAchievement(GUILD, 'c', 'duo'));
  });

  test('playing together repeatedly in one day counts once', () => {
    for (let i = 0; i < DUO_DAYS_NEEDED; i++) {
      db.startSession(GUILD, 'a', `CoOp${i}`, T0 + i * HOUR);
      db.startSession(GUILD, 'b', `CoOp${i}`, T0 + i * HOUR + 1000);
      evaluateDuoDays(db, GUILD, `CoOp${i}`, T0 + i * HOUR + 1000);
    }
    assert.ok(!db.hasAchievement(GUILD, 'a', 'duo'), 'same-day repeats must not count as separate days');
  });
});

describe('idempotency', () => {
  test('re-running evaluators never re-awards an achievement', () => {
    db.startSession(GUILD, USER, 'PEAK', T0);
    const first = evaluateSessionStart(db, GUILD, USER, 'PEAK', T0);
    assert.ok(first.includes('first_steps'));
    const second = evaluateSessionStart(db, GUILD, USER, 'PEAK', T0);
    assert.equal(second.length, 0);
  });
});
