import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, playSession, T0, MINUTE, HOUR, DAY } from './helpers.js';
import { socialDayKey, epochMinute, windowDays, eligibleForSilence } from '../src/social.js';

const GUILD = 'g1';
const A = 'alice';
const B = 'bob';

/** Midnight UTC on the day containing T0, so day-boundary cases are exact rather than nearly. */
const MIDNIGHT = Date.parse('2026-06-15T00:00:00Z');

// ---- Pure helpers ----------------------------------------------------------------------------

test('socialDayKey and epochMinute bucket by UTC', () => {
  assert.equal(socialDayKey(MIDNIGHT), '2026-06-15');
  assert.equal(socialDayKey(MIDNIGHT + DAY - 1), '2026-06-15');
  assert.equal(socialDayKey(MIDNIGHT + DAY), '2026-06-16');
  assert.equal(epochMinute(MIDNIGHT), epochMinute(MIDNIGHT + 59_999));
  assert.notEqual(epochMinute(MIDNIGHT), epochMinute(MIDNIGHT + MINUTE));
});

test('windowDays steps back off an exclusive end so a midnight boundary excludes the next day', () => {
  const { fromDay, toDay } = windowDays(MIDNIGHT, MIDNIGHT + 7 * DAY);
  assert.equal(fromDay, '2026-06-15');
  assert.equal(toDay, '2026-06-21', 'the 22nd is the exclusive end and must not be included');
});

test('windowDays keeps the partial day when the window ends mid-day', () => {
  // What the preview path asks for: the period in progress, ending at "now" rather than midnight.
  const { toDay } = windowDays(MIDNIGHT, MIDNIGHT + 3 * DAY + 11 * HOUR);
  assert.equal(toDay, '2026-06-18', 'today is partial but still counts');
});

test('windowDays never inverts on a zero-length window', () => {
  const { fromDay, toDay } = windowDays(MIDNIGHT, MIDNIGHT);
  assert.equal(fromDay, toDay);
});


test('a member can only be judged on a period they were present and tracked for', () => {
  const periodStart = T0;
  const base = {
    trackingStartedAt: periodStart - 30 * DAY,
    joinedAt: periodStart - 30 * DAY,
    periodStart,
    graceMs: 7 * DAY,
  };
  assert.equal(eligibleForSilence(base), true);
  assert.equal(eligibleForSilence({ ...base, joinedAt: periodStart - HOUR }), false,
    'joined an hour before the period began');
  assert.equal(eligibleForSilence({ ...base, trackingStartedAt: periodStart - HOUR }), false,
    'the bot itself had barely started recording');
  assert.equal(eligibleForSilence({ ...base, joinedAt: periodStart + DAY }), false,
    'joined part-way through the period');
});

test('the grace period is measured against the start of the period, not against now', () => {
  const periodStart = T0;
  const joined = periodStart - 3 * DAY;
  assert.equal(
    eligibleForSilence({ trackingStartedAt: 0, joinedAt: joined, periodStart, graceMs: 7 * DAY }),
    false,
    'three days before the period is inside a seven-day grace',
  );
  assert.equal(
    eligibleForSilence({ trackingStartedAt: 0, joinedAt: joined, periodStart, graceMs: 2 * DAY }),
    true,
  );
});

test('an unknown floor is answered no rather than guessed', () => {
  const base = { trackingStartedAt: T0 - 30 * DAY, joinedAt: T0 - 30 * DAY, periodStart: T0 };
  assert.equal(eligibleForSilence({ ...base, joinedAt: null }), false, 'Discord did not give a join date');
  assert.equal(eligibleForSilence({ ...base, trackingStartedAt: null }), false, 'tracking floor never recorded');
});

test('with no grace configured, being there before the period starts is enough', () => {
  assert.equal(
    eligibleForSilence({ trackingStartedAt: T0 - MINUTE, joinedAt: T0 - MINUTE, periodStart: T0 }),
    true,
  );
});

// ---- Text minutes ----------------------------------------------------------------------------

test('a second message in the same minute buys nothing', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(db.recordTextMinute(GUILD, A, T0), true);
    assert.equal(db.recordTextMinute(GUILD, A, T0 + 1), false);
    assert.equal(db.recordTextMinute(GUILD, A, T0 + 59_999), false);
    assert.equal(db.getSocialTotals(GUILD, A, T0, T0 + DAY).text_minutes, 1);
  } finally { cleanup(); }
});

test('a message in the next minute buys a minute', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.recordTextMinute(GUILD, A, T0);
    assert.equal(db.recordTextMinute(GUILD, A, T0 + MINUTE), true);
    assert.equal(db.getSocialTotals(GUILD, A, T0, T0 + DAY).text_minutes, 2);
  } finally { cleanup(); }
});

test('the minute dedupe does not leak across members', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(db.recordTextMinute(GUILD, A, T0), true);
    assert.equal(db.recordTextMinute(GUILD, B, T0), true);
  } finally { cleanup(); }
});

test('midnight splits the same wall-clock activity into two day rows', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const lastMinuteOfDay = MIDNIGHT + DAY - MINUTE;
    db.recordTextMinute(GUILD, A, lastMinuteOfDay);
    db.recordTextMinute(GUILD, A, MIDNIGHT + DAY);
    assert.equal(db.getSocialTotals(GUILD, A, MIDNIGHT, MIDNIGHT + DAY).text_minutes, 1);
    assert.equal(db.getSocialTotals(GUILD, A, MIDNIGHT, MIDNIGHT + 2 * DAY).text_minutes, 2);
  } finally { cleanup(); }
});

// ---- Voice minutes ---------------------------------------------------------------------------

test('voice minutes accumulate and report what actually landed', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(db.creditVoiceMinutes(GUILD, A, 30, 240, T0), 30);
    assert.equal(db.creditVoiceMinutes(GUILD, A, 15, 240, T0 + HOUR), 15);
    assert.equal(db.getSocialTotals(GUILD, A, T0, T0 + DAY).voice_minutes, 45);
  } finally { cleanup(); }
});

test('the daily cap clamps the running total, not the individual credit', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(db.creditVoiceMinutes(GUILD, A, 200, 240, T0), 200);
    assert.equal(db.creditVoiceMinutes(GUILD, A, 100, 240, T0 + HOUR), 40, 'only the headroom lands');
    assert.equal(db.creditVoiceMinutes(GUILD, A, 60, 240, T0 + 2 * HOUR), 0, 'capped out');
    assert.equal(db.getSocialTotals(GUILD, A, T0, T0 + DAY).voice_minutes, 240);
  } finally { cleanup(); }
});

test('the cap is per day, so tomorrow starts fresh', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 240, 240, MIDNIGHT + HOUR);
    assert.equal(db.creditVoiceMinutes(GUILD, A, 30, 240, MIDNIGHT + DAY + HOUR), 30);
    assert.equal(db.getSocialTotals(GUILD, A, MIDNIGHT, MIDNIGHT + 2 * DAY).voice_minutes, 270);
  } finally { cleanup(); }
});

test('zero and negative credits are refused rather than lowering a total', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 10, 240, T0);
    assert.equal(db.creditVoiceMinutes(GUILD, A, 0, 240, T0), 0);
    assert.equal(db.creditVoiceMinutes(GUILD, A, -5, 240, T0), 0);
    assert.equal(db.getSocialTotals(GUILD, A, T0, T0 + DAY).voice_minutes, 10);
  } finally { cleanup(); }
});

test('text and voice share a day row without disturbing each other', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 20, 240, T0);
    db.recordTextMinute(GUILD, A, T0);
    db.creditVoiceMinutes(GUILD, A, 5, 240, T0);
    const totals = db.getSocialTotals(GUILD, A, T0, T0 + DAY);
    assert.equal(totals.text_minutes, 1);
    assert.equal(totals.voice_minutes, 25);
  } finally { cleanup(); }
});

// ---- Ranking ---------------------------------------------------------------------------------

/** Gives `userId` exactly `count` text-active minutes inside the day containing `at`. */
function typeMinutes(db, userId, count, at = T0) {
  for (let i = 0; i < count; i += 1) db.recordTextMinute(GUILD, userId, at + i * MINUTE);
}

test('each board ranks on its own metric, so the two can disagree', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 100, 240, T0);
    typeMinutes(db, B, 60);
    assert.deepEqual(db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 10).map((r) => r.user_id), [A]);
    assert.deepEqual(db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'text', 10).map((r) => r.user_id), [B]);
  } finally { cleanup(); }
});

test('a board carries both columns, so the recap can show a split and spot a double winner', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 100, 240, T0);
    typeMinutes(db, A, 20);
    const [row] = db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 10);
    assert.equal(row.voice_minutes, 100);
    assert.equal(row.text_minutes, 20);
  } finally { cleanup(); }
});

test('a board excludes members with none of its own metric, however busy elsewhere', () => {
  const { db, cleanup } = tempDatabase();
  try {
    typeMinutes(db, A, 200);
    assert.deepEqual(db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 10), [], 'never in voice');
    assert.equal(db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'text', 10).length, 1);
  } finally { cleanup(); }
});

test('an unknown metric is refused rather than silently ranking on the wrong column', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.throws(() => db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'social', 10), /Unknown social metric/);
  } finally { cleanup(); }
});

test('candidates come back in full so the award pass has somewhere to pass down to', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 100, 240, T0);
    db.creditVoiceMinutes(GUILD, B, 50, 240, T0);
    db.creditVoiceMinutes(GUILD, 'carol', 1, 240, T0);
    const board = db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 10);
    assert.deepEqual(board.map((r) => r.user_id), [A, B, 'carol'], 'no minimum is applied here');
  } finally { cleanup(); }
});

test('the leaderboard sums across days inside the window and ignores days outside it', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 10, 240, MIDNIGHT - DAY);      // the day before
    db.creditVoiceMinutes(GUILD, A, 20, 240, MIDNIGHT + HOUR);
    db.creditVoiceMinutes(GUILD, A, 30, 240, MIDNIGHT + DAY + HOUR);
    db.creditVoiceMinutes(GUILD, A, 40, 240, MIDNIGHT + 2 * DAY);  // the exclusive end
    const [row] = db.getSocialLeaderboard(GUILD, MIDNIGHT, MIDNIGHT + 2 * DAY, 'voice', 10);
    assert.equal(row.voice_minutes, 50);
  } finally { cleanup(); }
});

test('opted-out members are hidden from the ranking but still see their own totals', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 100, 240, T0);
    db.creditVoiceMinutes(GUILD, B, 10, 240, T0);
    db.optOut(GUILD, A, T0);
    const board = db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 10);
    assert.deepEqual(board.map((row) => row.user_id), [B], 'the top talker opted out');
    assert.equal(db.getSocialTotals(GUILD, A, T0, T0 + DAY).voice_minutes, 100, 'their own record is unchanged');
  } finally { cleanup(); }
});

test('members with no minutes in the window are absent rather than listed as zeroes', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 10, 240, MIDNIGHT - DAY);
    assert.deepEqual(db.getSocialLeaderboard(GUILD, MIDNIGHT, MIDNIGHT + DAY, 'voice', 10), []);
  } finally { cleanup(); }
});

test('the ranking is scoped to one guild', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, A, 100, 240, T0);
    db.creditVoiceMinutes('g2', B, 500, 240, T0);
    const board = db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 10);
    assert.deepEqual(board.map((row) => row.user_id), [A]);
  } finally { cleanup(); }
});

// ---- The silence floor -----------------------------------------------------------------------

test('the first active day is the first day with any activity', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(db.getFirstSocialDay(GUILD, A), null);
    db.recordTextMinute(GUILD, A, MIDNIGHT + DAY);
    db.creditVoiceMinutes(GUILD, A, 5, 240, MIDNIGHT);
    assert.equal(db.getFirstSocialDay(GUILD, A), '2026-06-15');
  } finally { cleanup(); }
});

test('the tracking floor is set once and never moved', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(db.getSocialTrackingStartedAt(GUILD), null);
    assert.equal(db.markSocialTrackingStarted(GUILD, T0), T0);
    assert.equal(db.markSocialTrackingStarted(GUILD, T0 + 30 * DAY), T0, 'a restart must not reset it');
  } finally { cleanup(); }
});

test('recording the floor does not disturb other guild settings', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.setNotificationChannel(GUILD, 'chan-1');
    db.markSocialTrackingStarted(GUILD, T0);
    assert.equal(db.getNotificationChannel(GUILD), 'chan-1');
  } finally { cleanup(); }
});

// ---- Who turned up ---------------------------------------------------------------------------
// The complement of this set is what Cave Dweller is awarded from, so a false negative here hands
// somebody a badge saying they were absent when they were not.

test('typing, voice and playing all count as having turned up', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.recordTextMinute(GUILD, 'typer', T0);
    db.creditVoiceMinutes(GUILD, 'talker', 30, 240, T0);
    playSession(db, GUILD, 'player', 'Some Game', T0, HOUR);
    const active = db.getActiveMemberIds(GUILD, T0, T0 + DAY);
    assert.deepEqual([...active].sort(), ['player', 'talker', 'typer']);
  } finally { cleanup(); }
});

test('a member with a day row but no minutes has not turned up', () => {
  const { db, cleanup } = tempDatabase();
  try {
    // creditVoiceMinutes with nothing to credit must not create the appearance of activity.
    db.creditVoiceMinutes(GUILD, A, 0, 240, T0);
    assert.deepEqual(db.getActiveMemberIds(GUILD, T0, T0 + DAY), []);
  } finally { cleanup(); }
});

test('somebody mid-session right now counts, though no session has closed', () => {
  const { db, cleanup } = tempDatabase();
  try {
    // A member who never stopped playing all period has no play_sessions row to be found by.
    db.startSession(GUILD, A, 'Long Game', T0);
    assert.deepEqual(db.getActiveMemberIds(GUILD, T0, T0 + DAY), [A]);
  } finally { cleanup(); }
});

test('activity outside the window does not count as turning up inside it', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.recordTextMinute(GUILD, A, MIDNIGHT - DAY);
    playSession(db, GUILD, B, 'Some Game', MIDNIGHT - 2 * DAY, HOUR);
    assert.deepEqual(db.getActiveMemberIds(GUILD, MIDNIGHT, MIDNIGHT + DAY), []);
  } finally { cleanup(); }
});

test('turning up is scoped to the guild', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.recordTextMinute('g2', A, T0);
    assert.deepEqual(db.getActiveMemberIds(GUILD, T0, T0 + DAY), []);
  } finally { cleanup(); }
});

test('the same member active in two ways is listed once', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.recordTextMinute(GUILD, A, T0);
    db.creditVoiceMinutes(GUILD, A, 10, 240, T0);
    playSession(db, GUILD, A, 'Some Game', T0, HOUR);
    assert.deepEqual(db.getActiveMemberIds(GUILD, T0, T0 + DAY), [A]);
  } finally { cleanup(); }
});

// ---- Erasure ---------------------------------------------------------------------------------

test('purging a member removes their social days', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.recordTextMinute(GUILD, A, T0);
    db.creditVoiceMinutes(GUILD, A, 30, 240, T0);
    db.creditVoiceMinutes(GUILD, B, 30, 240, T0);
    const removed = db.purgeMember(GUILD, A);
    assert.equal(removed.socialDays, 1);
    assert.equal(db.getSocialTotals(GUILD, A, T0, T0 + DAY).text_minutes, 0);
    assert.equal(db.getSocialTotals(GUILD, B, T0, T0 + DAY).voice_minutes, 30, 'nobody else is touched');
  } finally { cleanup(); }
});
