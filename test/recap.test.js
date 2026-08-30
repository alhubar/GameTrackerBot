import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { previousPeriodRange, nextPeriodStart, buildRecap, isRecapDue, markRecapAnnounced, RECAP_PERIODS } from '../src/recap.js';
import { tempDatabase, playSession, HOUR, MINUTE } from './helpers.js';

const GUILD = 'guild-1';

let db;
let cleanup;
beforeEach(() => { ({ db, cleanup } = tempDatabase()); });
afterEach(() => cleanup());

// Mid-August, so "last month" is July.
const AUGUST = Date.parse('2026-08-10T12:00:00Z');
const JULY_START = Date.parse('2026-07-01T00:00:00Z');

describe('month boundaries', () => {
  test('previousMonthRange covers exactly the previous calendar month', () => {
    const range = previousPeriodRange(AUGUST, 'month');
    assert.equal(range.key, '2026-07');
    assert.equal(range.label, 'July 2026');
    assert.equal(new Date(range.start).toISOString(), '2026-07-01T00:00:00.000Z');
    assert.equal(new Date(range.end).toISOString(), '2026-08-01T00:00:00.000Z');
  });

  test('January rolls back into the previous year', () => {
    const range = previousPeriodRange(Date.parse('2026-01-20T00:00:00Z'), 'month');
    assert.equal(range.key, '2025-12');
    assert.equal(range.label, 'December 2025');
  });

  test('the range end is exclusive, so months never overlap', () => {
    assert.equal(previousPeriodRange(AUGUST, 'month').end, previousPeriodRange(Date.parse('2026-09-10T00:00:00Z'), 'month').start);
  });
});

describe('week boundaries', () => {
  // Tuesday 11 August 2026. The week before it runs Mon 3 Aug to Sun 9 Aug.
  const TUESDAY = Date.parse('2026-08-11T09:00:00Z');

  test('the previous week runs Monday to Sunday', () => {
    const range = previousPeriodRange(TUESDAY, 'week');
    assert.equal(new Date(range.start).toISOString(), '2026-08-03T00:00:00.000Z');
    assert.equal(new Date(range.end).toISOString(), '2026-08-10T00:00:00.000Z');
    assert.equal(range.label, '3–9 August 2026');
    assert.equal(range.title, 'Gamer of the Week');
  });

  test('a Monday belongs to the week it starts, not the one before', () => {
    const monday = previousPeriodRange(Date.parse('2026-08-10T00:00:00Z'), 'week');
    assert.equal(new Date(monday.start).toISOString(), '2026-08-03T00:00:00.000Z');
  });

  test('a Sunday still belongs to the week that began on Monday', () => {
    // Sunday 9 Aug is the last day of the 3–9 Aug week, so the previous week is 27 Jul – 2 Aug.
    const sunday = previousPeriodRange(Date.parse('2026-08-09T23:59:00Z'), 'week');
    assert.equal(new Date(sunday.start).toISOString(), '2026-07-27T00:00:00.000Z');
  });

  test('consecutive weeks meet exactly and never overlap', () => {
    const first = previousPeriodRange(TUESDAY, 'week');
    const second = previousPeriodRange(TUESDAY + 7 * 24 * 60 * 60_000, 'week');
    assert.equal(first.end, second.start);
    assert.equal(second.end - second.start, 7 * 24 * 60 * 60_000);
  });

  test('a week spanning two months reads both of them', () => {
    // Mon 28 Sep – Sun 4 Oct 2026.
    const range = previousPeriodRange(Date.parse('2026-10-06T00:00:00Z'), 'week');
    assert.equal(range.label, '28 September – 4 October 2026');
  });

  test('week keys are distinct week to week and stable within one', () => {
    const a = previousPeriodRange(TUESDAY, 'week');
    const b = previousPeriodRange(TUESDAY + 2 * 24 * 60 * 60_000, 'week'); // still the same week
    const c = previousPeriodRange(TUESDAY + 7 * 24 * 60 * 60_000, 'week');
    assert.equal(a.key, b.key);
    assert.notEqual(a.key, c.key);
    assert.match(a.key, /^\d{4}-W\d{2}$/);
  });

  test('week keys survive the turn of the year', () => {
    // 1 Jan 2027 is a Friday, so it sits in the week that began Mon 28 Dec 2026.
    const range = previousPeriodRange(Date.parse('2027-01-08T00:00:00Z'), 'week');
    assert.equal(new Date(range.start).toISOString(), '2026-12-28T00:00:00.000Z');
    assert.match(range.key, /^\d{4}-W\d{2}$/);
  });

  test('week is the default period', () => {
    assert.equal(previousPeriodRange(TUESDAY).period, 'week');
    assert.deepEqual(RECAP_PERIODS, ['week', 'month']);
  });

  test('nextPeriodStart makes the in-progress period the one being recapped', () => {
    // This is what the preview script relies on: standings for the week we are living in.
    const range = previousPeriodRange(nextPeriodStart(TUESDAY, 'week'), 'week');
    assert.equal(new Date(range.start).toISOString(), '2026-08-10T00:00:00.000Z', 'the week containing Tuesday');
    assert.ok(TUESDAY >= range.start && TUESDAY < range.end, 'and it actually contains it');
  });

  test('nextPeriodStart works the same way for months', () => {
    const range = previousPeriodRange(nextPeriodStart(AUGUST, 'month'), 'month');
    assert.equal(range.label, 'August 2026');
    assert.ok(AUGUST >= range.start && AUGUST < range.end);
  });

  test('nextPeriodStart rolls a December week and month into the new year', () => {
    const december = Date.parse('2026-12-30T12:00:00Z');
    assert.equal(new Date(nextPeriodStart(december, 'month')).toISOString(), '2027-01-01T00:00:00.000Z');
    assert.ok(nextPeriodStart(december, 'week') > december);
  });
});

describe('weekly recap contents', () => {
  const TUESDAY = Date.parse('2026-08-11T09:00:00Z');
  const LAST_WEEK = Date.parse('2026-08-04T18:00:00Z'); // inside 3–9 Aug

  test('only play inside the previous week counts', () => {
    playSession(db, GUILD, 'alice', 'PEAK', LAST_WEEK, 3 * HOUR);
    playSession(db, GUILD, 'bob', 'PEAK', Date.parse('2026-08-10T18:00:00Z'), 9 * HOUR); // this week
    const recap = buildRecap(db, GUILD, TUESDAY);
    assert.equal(recap.winner.userId, 'alice');
    assert.equal(recap.podium.length, 1, 'bob played in the current week, not the one being recapped');
  });

  test('the weekly recap is announced once per week', () => {
    assert.equal(isRecapDue(db, GUILD, TUESDAY), true);
    markRecapAnnounced(db, GUILD, TUESDAY);
    assert.equal(isRecapDue(db, GUILD, TUESDAY), false);
    assert.equal(isRecapDue(db, GUILD, TUESDAY + 7 * 24 * 60 * 60_000), true, 'next week is due again');
  });

  test('switching period changes what counts as already announced', () => {
    markRecapAnnounced(db, GUILD, TUESDAY, 'week');
    assert.equal(isRecapDue(db, GUILD, TUESDAY, 'month'), true,
      'a stored week key never matches a month key, so the first month recap still fires');
  });
});

describe('the minimum playtime bar', () => {
  const TUESDAY = Date.parse('2026-08-11T09:00:00Z');
  const LAST_WEEK = Date.parse('2026-08-04T18:00:00Z'); // inside 3–9 Aug
  const TWO_HOURS = 2 * 3600;

  test('a token few minutes does not crown anyone', () => {
    playSession(db, GUILD, 'alice', 'PEAK', LAST_WEEK, 20 * MINUTE);
    const recap = buildRecap(db, GUILD, TUESDAY, { minSeconds: TWO_HOURS });
    assert.equal(recap.winner, null);
    assert.equal(recap.podium[0].userId, 'alice', 'the near-miss is still reported');
    assert.equal(recap.minSeconds, TWO_HOURS);
  });

  test('exactly the threshold qualifies', () => {
    playSession(db, GUILD, 'alice', 'PEAK', LAST_WEEK, 2 * HOUR);
    const recap = buildRecap(db, GUILD, TUESDAY, { minSeconds: TWO_HOURS });
    assert.equal(recap.winner.userId, 'alice');
  });

  test('one second short does not', () => {
    playSession(db, GUILD, 'alice', 'PEAK', LAST_WEEK, 2 * HOUR - 1000);
    assert.equal(buildRecap(db, GUILD, TUESDAY, { minSeconds: TWO_HOURS }).winner, null);
  });

  test('the bar applies to the winner, not the field', () => {
    // Three members all below the bar must not add up to a winner between them.
    playSession(db, GUILD, 'alice', 'PEAK', LAST_WEEK, 50 * MINUTE);
    playSession(db, GUILD, 'bob', 'PEAK', LAST_WEEK, 45 * MINUTE);
    playSession(db, GUILD, 'carol', 'PEAK', LAST_WEEK, 40 * MINUTE);
    const recap = buildRecap(db, GUILD, TUESDAY, { minSeconds: TWO_HOURS });
    assert.equal(recap.winner, null);
    assert.equal(recap.podium.length, 3);
  });

  test('the bar only counts play inside the period', () => {
    // Plenty of hours, but spread either side of the week being recapped.
    playSession(db, GUILD, 'alice', 'PEAK', Date.parse('2026-08-01T10:00:00Z'), 5 * HOUR);
    playSession(db, GUILD, 'alice', 'PEAK', Date.parse('2026-08-10T10:00:00Z'), 5 * HOUR);
    playSession(db, GUILD, 'alice', 'PEAK', LAST_WEEK, 30 * MINUTE);
    assert.equal(buildRecap(db, GUILD, TUESDAY, { minSeconds: TWO_HOURS }).winner, null);
  });

  test('with no bar set, any tracked play wins', () => {
    playSession(db, GUILD, 'alice', 'PEAK', LAST_WEEK, MINUTE);
    assert.equal(buildRecap(db, GUILD, TUESDAY).winner.userId, 'alice');
  });
});

describe('recap contents', () => {
  test('there is no winner when nobody played', () => {
    const recap = buildRecap(db, GUILD, AUGUST, { period: 'month' });
    assert.equal(recap.winner, null);
    assert.deepEqual(recap.podium, []);
    assert.equal(recap.range.label, 'July 2026', 'the period is still reported so it can be announced');
  });

  test('the winner is whoever played most that month', () => {
    playSession(db, GUILD, 'alice', 'PEAK', JULY_START + HOUR, 5 * HOUR);
    playSession(db, GUILD, 'bob', 'PEAK', JULY_START + 2 * HOUR, 2 * HOUR);
    const recap = buildRecap(db, GUILD, AUGUST, { period: 'month' });
    assert.equal(recap.winner.userId, 'alice');
    assert.equal(recap.winner.totalSeconds, 5 * 3600);
    assert.equal(recap.range.label, 'July 2026');
  });

  test('play in other months is ignored', () => {
    playSession(db, GUILD, 'alice', 'PEAK', JULY_START + HOUR, 2 * HOUR);
    playSession(db, GUILD, 'bob', 'PEAK', Date.parse('2026-08-02T10:00:00Z'), 9 * HOUR);
    const recap = buildRecap(db, GUILD, AUGUST, { period: 'month' });
    assert.equal(recap.winner.userId, 'alice', 'bob only played in August');
    assert.equal(recap.podium.length, 1);
  });

  test('the top game and game count describe the winner', () => {
    playSession(db, GUILD, 'alice', 'Wordle', JULY_START + HOUR, 30 * MINUTE);
    playSession(db, GUILD, 'alice', 'PEAK', JULY_START + 3 * HOUR, 4 * HOUR);
    const recap = buildRecap(db, GUILD, AUGUST, { period: 'month' });
    assert.equal(recap.winner.topGame, 'PEAK');
    assert.equal(recap.winner.topGameSeconds, 4 * 3600);
    assert.equal(recap.winner.gamesPlayed, 2);
  });

  test('only achievements unlocked inside the month are counted', () => {
    playSession(db, GUILD, 'alice', 'PEAK', JULY_START + HOUR, 3 * HOUR);
    db.unlockAchievement(GUILD, 'alice', 'first_steps', JULY_START + 2 * HOUR);
    db.unlockAchievement(GUILD, 'alice', 'collector', JULY_START - 5 * HOUR); // June
    db.unlockAchievement(GUILD, 'alice', 'regular', Date.parse('2026-08-03T00:00:00Z')); // August
    const recap = buildRecap(db, GUILD, AUGUST, { period: 'month' });
    assert.deepEqual(recap.winner.achievements, ['first_steps']);
  });

  test('the podium is ordered and capped', () => {
    playSession(db, GUILD, 'alice', 'PEAK', JULY_START + HOUR, 5 * HOUR);
    playSession(db, GUILD, 'bob', 'PEAK', JULY_START + HOUR, 4 * HOUR);
    playSession(db, GUILD, 'carol', 'PEAK', JULY_START + HOUR, 3 * HOUR);
    playSession(db, GUILD, 'dave', 'PEAK', JULY_START + HOUR, 2 * HOUR);
    const recap = buildRecap(db, GUILD, AUGUST, { period: 'month' });
    assert.deepEqual(recap.podium.map((entry) => entry.userId), ['alice', 'bob', 'carol']);
  });

  test('a session straddling the month boundary only counts its July part', () => {
    // Starts 22:00 on 31 July, runs four hours into August.
    playSession(db, GUILD, 'alice', 'PEAK', Date.parse('2026-07-31T22:00:00Z'), 4 * HOUR);
    const recap = buildRecap(db, GUILD, AUGUST, { period: 'month' });
    assert.equal(recap.winner.totalSeconds, 2 * 3600, 'only the two hours before midnight count');
    assert.equal(recap.winner.topGameSeconds, 2 * 3600, 'and the top game agrees');
  });
});

describe('announcing once', () => {
  test('a recap is due until it is marked, then not again', () => {
    assert.equal(isRecapDue(db, GUILD, AUGUST, 'month'), true);
    markRecapAnnounced(db, GUILD, AUGUST, 'month');
    assert.equal(isRecapDue(db, GUILD, AUGUST, 'month'), false);
  });

  test('marking one month does not suppress the next', () => {
    markRecapAnnounced(db, GUILD, AUGUST, 'month');
    assert.equal(isRecapDue(db, GUILD, Date.parse('2026-09-01T00:30:00Z'), 'month'), true, 'August recap is now due');
  });

  test('the marker survives alongside other guild settings', () => {
    db.setNotificationChannel(GUILD, 'channel-1');
    markRecapAnnounced(db, GUILD, AUGUST, 'month');
    assert.equal(db.getNotificationChannel(GUILD), 'channel-1');
    assert.equal(db.getLastMonthlyRecap(GUILD), '2026-07');
  });

  test('guilds are tracked independently', () => {
    markRecapAnnounced(db, GUILD, AUGUST, 'month');
    assert.equal(isRecapDue(db, 'guild-2', AUGUST, 'month'), true);
  });
});

describe('the posting hour', () => {
  // Monday 00:00 UTC is the boundary; the week being recapped is the one that just ended.
  const MONDAY_MIDNIGHT = Date.parse('2026-08-17T00:00:00Z');
  const at = (iso) => Date.parse(iso);

  test('hour 0 posts the moment the period turns over, as it always did', () => {
    assert.equal(isRecapDue(db, GUILD, MONDAY_MIDNIGHT, 'week', 0), true);
  });

  test('a later hour holds the post back until it arrives', () => {
    assert.equal(isRecapDue(db, GUILD, MONDAY_MIDNIGHT, 'week', 18), false, 'midnight is too early');
    assert.equal(isRecapDue(db, GUILD, at('2026-08-17T17:59:00Z'), 'week', 18), false, 'a minute short');
    assert.equal(isRecapDue(db, GUILD, at('2026-08-17T18:00:00Z'), 'week', 18), true, 'on the hour');
    assert.equal(isRecapDue(db, GUILD, at('2026-08-17T18:04:00Z'), 'week', 18), true, 'just after');
  });

  test('each period is gated afresh from its own boundary', () => {
    // The week ending Monday the 17th, posted on time.
    markRecapAnnounced(db, GUILD, at('2026-08-17T18:00:00Z'), 'week');
    // The next one ends Monday the 24th and waits for 18:00 that day rather than inheriting
    // the fact that the previous week's hour has long gone.
    assert.equal(isRecapDue(db, GUILD, at('2026-08-24T09:00:00Z'), 'week', 18), false);
    assert.equal(isRecapDue(db, GUILD, at('2026-08-24T18:00:00Z'), 'week', 18), true);
  });

  test('a missed hour posts late rather than being skipped', () => {
    // The bot was down all Monday and comes back on Tuesday.
    assert.equal(isRecapDue(db, GUILD, at('2026-08-18T09:00:00Z'), 'week', 18), true);
  });

  test('holding the post back never posts it twice', () => {
    assert.equal(isRecapDue(db, GUILD, at('2026-08-17T18:00:00Z'), 'week', 18), true);
    markRecapAnnounced(db, GUILD, at('2026-08-17T18:00:00Z'), 'week');
    assert.equal(isRecapDue(db, GUILD, at('2026-08-17T18:05:00Z'), 'week', 18), false);
    assert.equal(isRecapDue(db, GUILD, at('2026-08-17T23:00:00Z'), 'week', 18), false);
  });

  test('the same gate applies to a monthly recap', () => {
    // September opens at 00:00 UTC on the 1st; August's recap waits for hour 18 that day.
    assert.equal(isRecapDue(db, GUILD, at('2026-09-01T06:00:00Z'), 'month', 18), false);
    assert.equal(isRecapDue(db, GUILD, at('2026-09-01T18:00:00Z'), 'month', 18), true);
  });
});
