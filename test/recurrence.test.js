import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepeatRule, describeRepeat, nextOccurrence, rollRecurringEvents, RECURRENCE_ROLL_DELAY_MS,
} from '../src/events.js';
import { tempDatabase, HOUR, DAY } from './helpers.js';

const GUILD = 'guild-1';

/** Friday 23 October 2026, 20:00 in Berlin — two days before the EU clocks go back. */
const FRIDAY_2000_BERLIN = Date.UTC(2026, 9, 23, 18, 0);

describe('parseRepeatRule', () => {
  const accepted = [
    ['weekly', 'weekly'],
    ['Weekly', 'weekly'],
    ['  weekly  ', 'weekly'],
    ['every week', 'weekly'],
    ['week', 'weekly'],
    ['7 days', 'weekly'],
    ['daily', 'daily'],
    ['every day', 'daily'],
    ['fortnightly', 'fortnightly'],
    ['biweekly', 'fortnightly'],
    ['every other week', 'fortnightly'],
    ['2 weeks', 'fortnightly'],
  ];

  for (const [input, rule] of accepted) {
    test(`"${input}" means ${rule}`, () => {
      assert.deepEqual(parseRepeatRule(input), { rule });
    });
  }

  const oneOffs = ['', '   ', 'no', 'none', 'never', 'once', 'one-off'];
  for (const input of oneOffs) {
    test(`"${input}" is a one-off, not an error`, () => {
      assert.deepEqual(parseRepeatRule(input), { rule: null });
    });
  }

  test('a blank field left untouched is a one-off', () => {
    assert.deepEqual(parseRepeatRule(undefined), { rule: null });
  });

  // Monthly is deliberately absent: it needs an anchor day the row cannot carry, so a series
  // starting on the 31st would walk backwards through the calendar via February.
  const rejected = ['monthly', 'every month', 'yearly', 'yes', 'fridays', 'every 3 days'];
  for (const input of rejected) {
    test(`"${input}" is rejected with a message naming the rules`, () => {
      const { rule, error } = parseRepeatRule(input);
      assert.equal(rule, undefined);
      assert.match(error, /daily, weekly, fortnightly/);
    });
  }
});

describe('describeRepeat', () => {
  test('names each rule for the card', () => {
    assert.equal(describeRepeat('daily'), 'Every day');
    assert.equal(describeRepeat('weekly'), 'Every week');
    assert.equal(describeRepeat('fortnightly'), 'Every two weeks');
  });

  test('a one-off has nothing to say', () => {
    assert.equal(describeRepeat(null), null);
    assert.equal(describeRepeat(undefined), null);
  });
});

describe('nextOccurrence', () => {
  test('weekly advances seven days', () => {
    const next = nextOccurrence(FRIDAY_2000_BERLIN, 'weekly', 'UTC', FRIDAY_2000_BERLIN + 1);
    assert.equal(next, FRIDAY_2000_BERLIN + 7 * DAY);
  });

  test('daily advances one day, fortnightly fourteen', () => {
    const from = Date.UTC(2026, 5, 15, 18, 0);
    assert.equal(nextOccurrence(from, 'daily', 'UTC', from + 1), from + DAY);
    assert.equal(nextOccurrence(from, 'fortnightly', 'UTC', from + 1), from + 14 * DAY);
  });

  // The reason events record a timezone at all. Adding a fixed 168 hours across the autumn change
  // would move a 20:00 game night to 19:00 permanently, for everybody.
  test('keeps the wall-clock time across a daylight-saving change', () => {
    const next = nextOccurrence(FRIDAY_2000_BERLIN, 'weekly', 'Europe/Berlin', FRIDAY_2000_BERLIN + 1);
    assert.equal(next, Date.UTC(2026, 9, 30, 19, 0), 'still 20:00 in Berlin, now an hour later in UTC');
    assert.notEqual(next, FRIDAY_2000_BERLIN + 7 * DAY, 'a fixed-millisecond week would land an hour early');
  });

  test('the same event in UTC has no change to absorb', () => {
    const next = nextOccurrence(FRIDAY_2000_BERLIN, 'weekly', 'UTC', FRIDAY_2000_BERLIN + 1);
    assert.equal(next, FRIDAY_2000_BERLIN + 7 * DAY);
  });

  test('crosses a month and a year boundary', () => {
    const newYearsEve = Date.UTC(2026, 11, 31, 20, 0);
    assert.equal(nextOccurrence(newYearsEve, 'daily', 'UTC', newYearsEve + 1), Date.UTC(2027, 0, 1, 20, 0));
  });

  // Three weeks of downtime must produce one occurrence, not three weeks of backlog.
  test('catches up to the first future occurrence in one step', () => {
    const now = FRIDAY_2000_BERLIN + 21 * DAY;
    const next = nextOccurrence(FRIDAY_2000_BERLIN, 'weekly', 'Europe/Berlin', now);
    assert.ok(next > now, 'the answer is always in the future');
    assert.equal(next, Date.UTC(2026, 10, 13, 19, 0), 'the next Friday at 20:00 Berlin, not the first one missed');
  });

  test('an occurrence still ahead of us is its own answer', () => {
    const next = nextOccurrence(FRIDAY_2000_BERLIN, 'weekly', 'UTC', FRIDAY_2000_BERLIN - DAY);
    assert.equal(next, FRIDAY_2000_BERLIN);
  });

  test('an unrecognised rule has no next occurrence', () => {
    assert.equal(nextOccurrence(FRIDAY_2000_BERLIN, 'monthly', 'UTC', FRIDAY_2000_BERLIN + 1), null);
    assert.equal(nextOccurrence(FRIDAY_2000_BERLIN, null, 'UTC', FRIDAY_2000_BERLIN + 1), null);
    assert.equal(nextOccurrence(FRIDAY_2000_BERLIN, '', 'UTC', FRIDAY_2000_BERLIN + 1), null);
  });
});

/** A guild with one event, recurring unless told otherwise. */
function setup({ repeat = 'weekly', zone = 'UTC', startsAt = FRIDAY_2000_BERLIN } = {}) {
  const { db, cleanup } = tempDatabase();
  const eventId = db.createEvent(GUILD, 'channel-1', 'alice', 'Game night', null, 'Deep Rock Galactic', startsAt, startsAt - DAY, repeat, zone);
  db.setEventMessageId(eventId, 'message-1');
  return { db, cleanup, eventId, startsAt };
}

describe('events table — recurrence columns', () => {
  test('a repeat rule and its zone survive a round trip', () => {
    const { db, cleanup, eventId } = setup({ repeat: 'fortnightly', zone: 'Europe/Berlin' });
    const event = db.getEvent(eventId);
    assert.equal(event.repeat_rule, 'fortnightly');
    assert.equal(event.timezone, 'Europe/Berlin');
    cleanup();
  });

  test('an event created without them is a one-off', () => {
    const { db, cleanup } = tempDatabase();
    const eventId = db.createEvent(GUILD, 'channel-1', 'alice', 'One-off', null, null, FRIDAY_2000_BERLIN);
    assert.equal(db.getEvent(eventId).repeat_rule, null);
    assert.equal(db.getEvent(eventId).timezone, null);
    cleanup();
  });

  test('an edit can start a series, and clearing the field ends one', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.updateEvent(eventId, 'Game night', null, 'Deep Rock Galactic', startsAt, null, 'UTC');
    assert.equal(db.getEvent(eventId).repeat_rule, null, 'a cleared Repeat field turns a series back into a one-off');
    db.updateEvent(eventId, 'Game night', null, 'Deep Rock Galactic', startsAt, 'daily', 'UTC');
    assert.equal(db.getEvent(eventId).repeat_rule, 'daily');
    cleanup();
  });
});

describe('rollRecurringEvents', () => {
  test('advances an occurrence that has passed, and reports it for re-announcing', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    const rolled = rollRecurringEvents(db, startsAt + RECURRENCE_ROLL_DELAY_MS + HOUR);
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0].event.id, eventId);
    assert.equal(rolled[0].previousMessageId, 'message-1', 'the caller needs the old message to delete it');
    assert.equal(rolled[0].nextStartsAt, startsAt + 7 * DAY);
    assert.equal(db.getEvent(eventId).starts_at, startsAt + 7 * DAY);
    cleanup();
  });

  test('leaves the announcement pointer empty until the caller posts one', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    rollRecurringEvents(db, startsAt + 4 * HOUR);
    assert.equal(db.getEvent(eventId).message_id, null, 'the old message belongs to the occurrence that ended');
    cleanup();
  });

  test('does nothing until the roll delay has passed', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    assert.equal(rollRecurringEvents(db, startsAt + HOUR).length, 0, 'the evening is still going');
    assert.equal(db.getEvent(eventId).starts_at, startsAt);
    cleanup();
  });

  test('does nothing before the occurrence has even started', () => {
    const { db, cleanup, startsAt } = setup();
    assert.equal(rollRecurringEvents(db, startsAt - HOUR).length, 0);
    cleanup();
  });

  test('never touches a one-off', () => {
    const { db, cleanup, eventId, startsAt } = setup({ repeat: null });
    assert.equal(rollRecurringEvents(db, startsAt + 7 * DAY).length, 0);
    assert.equal(db.getEvent(eventId).starts_at, startsAt);
    cleanup();
  });

  // The property the whole design exists for: a second pass, a retry after a crash, or a second bot
  // on the same token cannot post the same occurrence twice.
  test('a second pass in the same tick rolls nothing', () => {
    const { db, cleanup, startsAt } = setup();
    const now = startsAt + 4 * HOUR;
    assert.equal(rollRecurringEvents(db, now).length, 1);
    assert.equal(rollRecurringEvents(db, now).length, 0);
    cleanup();
  });

  test('a stale start time loses the compare-and-swap', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    assert.equal(db.rollEventForward(eventId, startsAt, startsAt + 7 * DAY), true);
    assert.equal(db.rollEventForward(eventId, startsAt, startsAt + 14 * DAY), false, 'the row had already moved');
    assert.equal(db.getEvent(eventId).starts_at, startsAt + 7 * DAY);
    cleanup();
  });

  test('three weeks of downtime produces one occurrence, in the future', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    const now = startsAt + 21 * DAY + 4 * HOUR;
    const rolled = rollRecurringEvents(db, now);
    assert.equal(rolled.length, 1, 'one roll, not one per missed week');
    assert.ok(db.getEvent(eventId).starts_at > now, 'and it lands ahead of us');
    cleanup();
  });

  test('clears the RSVPs and fired reminders of the occurrence that ended', () => {
    const { db, cleanup, eventId, startsAt } = setup();
    db.upsertEventSignup(eventId, 'alice', 'going');
    db.upsertEventSignup(eventId, 'bob', 'declined');
    db.markReminderSent(eventId, 720, startsAt - 12 * HOUR);
    rollRecurringEvents(db, startsAt + 4 * HOUR);
    assert.deepEqual(db.getEventSignups(eventId), [], 'last week’s "I’m in" is not an answer about next week');
    assert.equal(db.hasReminderSent(eventId, 720), false, 'or the next occurrence would be reminded about silently');
    cleanup();
  });

  test('an unusable rule is demoted to a one-off rather than retried forever', () => {
    const { db, cleanup, eventId, startsAt } = setup({ repeat: 'monthly' });
    const rolled = rollRecurringEvents(db, startsAt + 4 * HOUR);
    assert.equal(rolled.length, 0);
    assert.equal(db.getEvent(eventId).repeat_rule, null);
    assert.equal(db.getEvent(eventId).starts_at, startsAt, 'and its time is left exactly as it was');
    cleanup();
  });

  test('a series written before zones were recorded falls back to UTC', () => {
    const { db, cleanup, eventId, startsAt } = setup({ zone: null });
    rollRecurringEvents(db, startsAt + 4 * HOUR);
    assert.equal(db.getEvent(eventId).starts_at, startsAt + 7 * DAY);
    cleanup();
  });
});

describe('the expiry sweep and recurring events', () => {
  // Deleting the row would cancel a standing game night permanently. Skipping it leaves something
  // an admin can still see and delete by hand.
  test('a recurring row is never collected as stale', () => {
    const { db, cleanup, startsAt } = setup();
    assert.deepEqual(db.getStaleEvents(startsAt + 30 * DAY), []);
    cleanup();
  });

  test('a one-off still is', () => {
    const { db, cleanup, eventId, startsAt } = setup({ repeat: null });
    const stale = db.getStaleEvents(startsAt + 2 * DAY);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, eventId);
    cleanup();
  });

  test('a demoted series becomes collectable, so nothing is stranded', () => {
    const { db, cleanup, startsAt } = setup({ repeat: 'monthly' });
    rollRecurringEvents(db, startsAt + 4 * HOUR);
    assert.equal(db.getStaleEvents(startsAt + 2 * DAY).length, 1);
    cleanup();
  });
});
