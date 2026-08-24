import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventTime, formatEventTime, formatReminderDuration, zonedTimeToUtc, collectDueReminders } from '../src/events.js';
import { tempDatabase, HOUR, MINUTE } from './helpers.js';

describe('parseEventTime — timezone conversion', () => {
  test('UTC input matches Date.UTC exactly', () => {
    const { utcMs, error } = parseEventTime('22-08-2026 20:00', 'UTC');
    assert.equal(error, undefined);
    assert.equal(utcMs, Date.UTC(2026, 7, 22, 20, 0));
  });

  test('applies a positive offset (Europe/Berlin, CEST = UTC+2 in August)', () => {
    const { utcMs } = parseEventTime('22-08-2026 20:00', 'Europe/Berlin');
    assert.equal(utcMs, Date.UTC(2026, 7, 22, 18, 0));
  });

  test('applies a negative offset, rolling to the next UTC day', () => {
    const { utcMs } = parseEventTime('22-08-2026 20:00', 'America/New_York');
    assert.equal(utcMs, Date.UTC(2026, 7, 23, 0, 0));
  });

  test('respects daylight saving: same zone, same clock time, different offsets', () => {
    const summer = parseEventTime('22-08-2026 20:00', 'Europe/Lisbon');
    const winter = parseEventTime('22-01-2026 20:00', 'Europe/Lisbon');
    assert.equal(summer.utcMs, Date.UTC(2026, 7, 22, 19, 0), 'summer time is UTC+1');
    assert.equal(winter.utcMs, Date.UTC(2026, 0, 22, 20, 0), 'winter time is UTC+0');
  });

  test('handles a zone that never observes DST', () => {
    // America/Regina stays at UTC-6 all year.
    const summer = parseEventTime('22-08-2026 20:00', 'America/Regina');
    const winter = parseEventTime('22-01-2026 20:00', 'America/Regina');
    assert.equal(summer.utcMs, Date.UTC(2026, 7, 23, 2, 0));
    assert.equal(winter.utcMs, Date.UTC(2026, 0, 23, 2, 0));
  });
});

describe('parseEventTime — validation', () => {
  const cases = [
    ['free-form text', 'tomorrow at 8pm'],
    ['wrong separator', '22/08/2026 20:00'],
    ['missing time', '22-08-2026'],
    ['month 00', '22-00-2026 20:00'],
    ['month 13', '22-13-2026 20:00'],
    ['day 00', '00-08-2026 20:00'],
    ['day 32', '32-08-2026 20:00'],
    ['hour 24', '22-08-2026 24:00'],
    ['minute 60', '22-08-2026 20:60'],
    ['February 30th', '30-02-2026 20:00'],
    ['February 29th on a non-leap year', '29-02-2026 20:00'],
    ['April 31st', '31-04-2026 20:00'],
  ];

  for (const [label, input] of cases) {
    test(`rejects ${label}`, () => {
      const { error, utcMs } = parseEventTime(input, 'UTC');
      assert.ok(error, `"${input}" should be rejected`);
      assert.equal(utcMs, undefined);
    });
  }

  test('accepts a real leap day', () => {
    const { error } = parseEventTime('29-02-2028 20:00', 'UTC');
    assert.equal(error, undefined);
  });

  test('tolerates surrounding whitespace', () => {
    const { error, utcMs } = parseEventTime('  22-08-2026 20:00  ', 'UTC');
    assert.equal(error, undefined);
    assert.equal(utcMs, Date.UTC(2026, 7, 22, 20, 0));
  });
});

describe('formatEventTime — round trips', () => {
  for (const zone of ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney']) {
    test(`round-trips through ${zone}`, () => {
      const input = '22-08-2026 20:00';
      const { utcMs } = parseEventTime(input, zone);
      assert.equal(formatEventTime(utcMs, zone), input);
    });
  }

  test('round-trips across a winter date too', () => {
    const input = '05-01-2027 07:30';
    const { utcMs } = parseEventTime(input, 'Europe/Berlin');
    assert.equal(formatEventTime(utcMs, 'Europe/Berlin'), input);
  });
});

describe('zonedTimeToUtc', () => {
  test('is the identity for UTC', () => {
    assert.equal(zonedTimeToUtc(2026, 8, 22, 20, 0, 'UTC'), Date.UTC(2026, 7, 22, 20, 0));
  });
});

describe('formatReminderDuration', () => {
  test('rounds to whole hours rather than reporting exact minutes', () => {
    assert.equal(formatReminderDuration(61), '1 hour');
    assert.equal(formatReminderDuration(718), '12 hours');
  });

  test('exact values render cleanly', () => {
    assert.equal(formatReminderDuration(60), '1 hour');
    assert.equal(formatReminderDuration(720), '12 hours');
  });

  test('under an hour keeps minute precision', () => {
    assert.equal(formatReminderDuration(1), '1 minute');
    assert.equal(formatReminderDuration(25), '25 minutes');
  });

  test('rounds up near the hour boundary', () => {
    assert.equal(formatReminderDuration(58), '1 hour');
  });

  test('collapses to days past 24 hours', () => {
    assert.equal(formatReminderDuration(1440), '1 day');
    assert.equal(formatReminderDuration(2900), '2 days');
  });
});

describe('collectDueReminders — staging rules', () => {
  const STAGES = [720, 60, 0];
  const GUILD = 'g1';

  function setup() {
    const { db, cleanup } = tempDatabase();
    const startsAt = Date.parse('2026-06-16T20:00:00Z');
    const eventId = db.createEvent(GUILD, 'chan', 'creator', 'Game Night', null, 'PEAK', startsAt, startsAt - 48 * HOUR);
    return { db, cleanup, eventId, startsAt };
  }

  test('nothing fires before the earliest stage is reached', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    assert.equal(collectDueReminders(db, STAGES, startsAt - 13 * HOUR).length, 0);
    cleanup();
  });

  test('the 12h stage fires at its threshold and does not repeat', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    const first = collectDueReminders(db, STAGES, startsAt - 12 * HOUR);
    assert.equal(first.length, 1);
    assert.match(first[0].text, /12 hours/);
    assert.equal(collectDueReminders(db, STAGES, startsAt - 12 * HOUR + MINUTE).length, 0);
    cleanup();
  });

  test('each stage fires once, in order, when well separated', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    const twelve = collectDueReminders(db, STAGES, startsAt - 12 * HOUR);
    const one = collectDueReminders(db, STAGES, startsAt - HOUR);
    const atStart = collectDueReminders(db, STAGES, startsAt);
    assert.match(twelve[0].text, /12 hours/);
    assert.match(one[0].text, /1 hour/);
    assert.match(atStart[0].text, /is starting now/);
    assert.equal(collectDueReminders(db, STAGES, startsAt + MINUTE).length, 0);
    cleanup();
  });

  test('a stage stays pending while nobody has signed up', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    assert.equal(collectDueReminders(db, STAGES, startsAt - 12 * HOUR).length, 0);
    assert.equal(db.hasReminderSent(eventId, 720), false, 'stage must not be burned with no attendees');
    cleanup();
  });

  test('a late signup gets a reminder worded from the real remaining time', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    // Both the 12h and 1h stages pass with nobody going.
    collectDueReminders(db, STAGES, startsAt - 12 * HOUR);
    collectDueReminders(db, STAGES, startsAt - 2 * HOUR);
    db.upsertEventSignup(eventId, 'alice', 'going');
    const fired = collectDueReminders(db, STAGES, startsAt - 10 * MINUTE);
    assert.equal(fired.length, 1);
    assert.match(fired[0].text, /10 minutes/, 'must report actual time left, not the stage label');
    assert.doesNotMatch(fired[0].text, /12 hours/);
    cleanup();
  });

  test('cooldown suppresses a second reminder fired moments after the first', () => {
    const { db, cleanup } = tempDatabase();
    const startsAt = Date.parse('2026-06-16T20:00:00Z');
    // Only ~62 minutes of lead time, so 12h and 1h both come due almost together.
    const shortId = db.createEvent(GUILD, 'chan', 'creator', 'Short Notice', null, null, startsAt, startsAt - 62 * MINUTE);
    db.upsertEventSignup(shortId, 'alice', 'going');

    const first = collectDueReminders(db, STAGES, startsAt - 61 * MINUTE);
    assert.equal(first.length, 1);
    const immediatelyAfter = collectDueReminders(db, STAGES, startsAt - 60 * MINUTE);
    assert.equal(immediatelyAfter.length, 0, 'second stage must be held back by the cooldown');
    cleanup();
  });

  test('a stage held back by the cooldown still fires once it clears', () => {
    const { db, cleanup } = tempDatabase();
    const startsAt = Date.parse('2026-06-16T20:00:00Z');
    const shortId = db.createEvent(GUILD, 'chan', 'creator', 'Short Notice', null, null, startsAt, startsAt - 62 * MINUTE);
    db.upsertEventSignup(shortId, 'alice', 'going');
    collectDueReminders(db, STAGES, startsAt - 61 * MINUTE);
    const later = collectDueReminders(db, STAGES, startsAt - 20 * MINUTE);
    assert.equal(later.length, 1);
    assert.match(later[0].text, /20 minutes/);
    cleanup();
  });

  test('a short-notice event still gets its "starting now" despite the cooldown', () => {
    // Regression: a 3-minute-lead event fires 12h and 1h together on signup, which used to start
    // the anti-spam cooldown and swallow the at-start announcement entirely.
    const { db, cleanup } = tempDatabase();
    const startsAt = Date.parse('2026-06-16T20:00:00Z');
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Short Notice', null, null, startsAt, startsAt - 3 * MINUTE);
    db.upsertEventSignup(id, 'alice', 'going');

    const onSignup = collectDueReminders(db, STAGES, startsAt - 2 * MINUTE);
    assert.equal(onSignup.length, 1);
    assert.match(onSignup[0].text, /2 minutes/);

    const atStart = collectDueReminders(db, STAGES, startsAt);
    assert.equal(atStart.length, 1, 'the at-start announcement must not be blocked by the cooldown');
    assert.match(atStart[0].text, /is starting now/);
    cleanup();
  });

  test('the cooldown still suppresses near-duplicate pre-start reminders', () => {
    // The exemption above must not defeat the original anti-spam behaviour.
    const { db, cleanup } = tempDatabase();
    const startsAt = Date.parse('2026-06-16T20:00:00Z');
    const id = db.createEvent(GUILD, 'chan', 'creator', 'Short Notice', null, null, startsAt, startsAt - 62 * MINUTE);
    db.upsertEventSignup(id, 'alice', 'going');
    assert.equal(collectDueReminders(db, [720, 60], startsAt - 61 * MINUTE).length, 1);
    assert.equal(collectDueReminders(db, [720, 60], startsAt - 60 * MINUTE).length, 0);
    cleanup();
  });

  test('"starting now" is suppressed when it would arrive far too late', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    const fired = collectDueReminders(db, STAGES, startsAt + 45 * MINUTE);
    assert.equal(fired.length, 0, 'stale "starting now" must not be announced');
    assert.equal(db.hasReminderSent(eventId, 0), true, 'but the stage is marked so it stops retrying');
    cleanup();
  });

  test('only members marked going are included, not maybe or declined', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    db.upsertEventSignup(eventId, 'bob', 'maybe');
    db.upsertEventSignup(eventId, 'carol', 'declined');
    const [reminder] = collectDueReminders(db, STAGES, startsAt - 12 * HOUR);
    assert.deepEqual(reminder.going.map((row) => row.user_id), ['alice']);
    cleanup();
  });

  test('separate events fire independently', () => {
    const { db, cleanup } = tempDatabase();
    const startsAt = Date.parse('2026-06-16T20:00:00Z');
    const a = db.createEvent(GUILD, 'chan', 'creator', 'Event A', null, null, startsAt, startsAt - 48 * HOUR);
    const b = db.createEvent(GUILD, 'chan', 'creator', 'Event B', null, null, startsAt + 6 * HOUR, startsAt - 48 * HOUR);
    db.upsertEventSignup(a, 'alice', 'going');
    db.upsertEventSignup(b, 'bob', 'going');
    const fired = collectDueReminders(db, STAGES, startsAt - HOUR);
    const titles = fired.map((entry) => entry.event.title).sort();
    assert.deepEqual(titles, ['Event A', 'Event B']);
    cleanup();
  });

  test('editing the start time lets stages fire again against the new time', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    collectDueReminders(db, STAGES, startsAt - 12 * HOUR);
    assert.equal(db.hasReminderSent(eventId, 720), true);

    const newStart = startsAt + 5 * 24 * HOUR;
    db.updateEvent(eventId, 'Game Night', null, 'PEAK', newStart);
    assert.equal(db.hasReminderSent(eventId, 720), false, 'moving the time resets stage tracking');
    const fired = collectDueReminders(db, STAGES, newStart - 12 * HOUR);
    assert.equal(fired.length, 1);
    cleanup();
  });

  test('editing only the title leaves fired stages alone', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    collectDueReminders(db, STAGES, startsAt - 12 * HOUR);
    db.updateEvent(eventId, 'Renamed Night', 'new description', 'PEAK', startsAt);
    assert.equal(db.hasReminderSent(eventId, 720), true, 'a non-time edit must not resend reminders');
    cleanup();
  });

  test('omitting stage 0 means no notification once the event starts', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    const early = collectDueReminders(db, [60], startsAt - 30 * MINUTE);
    assert.equal(early.length, 1, 'the 60-minute stage still fires beforehand');
    assert.equal(collectDueReminders(db, [60], startsAt).length, 0, 'but nothing fires at start time');
    cleanup();
  });

  test('a stage that fires after the start says "starting now" rather than a negative time', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    const fired = collectDueReminders(db, [60], startsAt + MINUTE);
    assert.equal(fired.length, 1);
    assert.match(fired[0].text, /is starting now/);
    cleanup();
  });
});
