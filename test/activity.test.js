import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketPlayTime, busiestBucket, renderSparkline, buildActivityLines, ACTIVITY_WINDOW_MS, HOURS_IN_DAY, DAYS_IN_WEEK } from '../src/activity.js';
import { tempDatabase, playSession, HOUR, MINUTE, DAY, T0 } from './helpers.js';

const span = (startedAt, durationMs) => ({ started_at: startedAt, ended_at: startedAt + durationMs });
const at = (iso) => Date.parse(iso);
const WIDE = { windowStart: 0, windowEnd: Number.MAX_SAFE_INTEGER };
// 2026-06-15 is a Monday, which is weekday index 0 — every date below is relative to it.
const MONDAY = '2026-06-15';

test('a session lands in the hour it was played, in UTC', () => {
  const { hours } = bucketPlayTime([span(at(`${MONDAY}T14:00:00Z`), HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(hours[14], 3600);
  assert.equal(hours.reduce((sum, value) => sum + value, 0), 3600);
});

test('a session spanning hours credits every hour it covered, not just its start', () => {
  // 20:30 to 23:00 — the point of the whole feature: whoever was around at 22:00 shows at 22:00.
  const { hours } = bucketPlayTime([span(at(`${MONDAY}T20:30:00Z`), 2.5 * HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(hours[20], 30 * 60);
  assert.equal(hours[21], 3600);
  assert.equal(hours[22], 3600);
  assert.equal(hours[23], 0);
});

test('a session crossing midnight splits across the day boundary', () => {
  const { hours } = bucketPlayTime([span(at(`${MONDAY}T23:30:00Z`), HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(hours[23], 30 * 60);
  assert.equal(hours[0], 30 * 60);
});

test('buckets are wall-clock hours in the configured zone, not UTC hours', () => {
  const sessions = [span(at(`${MONDAY}T19:00:00Z`), HOUR)];
  assert.equal(bucketPlayTime(sessions, { timeZone: 'UTC', ...WIDE }).hours[19], 3600);
  // Madrid is UTC+2 in June, so the same instant is a 21:00 evening there.
  assert.equal(bucketPlayTime(sessions, { timeZone: 'Europe/Madrid', ...WIDE }).hours[21], 3600);
  // Tokyo is UTC+9 year round, which pushes it past midnight into the next day.
  assert.equal(bucketPlayTime(sessions, { timeZone: 'Asia/Tokyo', ...WIDE }).hours[4], 3600);
});

test('the offset is read per instant, so a window straddling a DST change stays aligned', () => {
  // Madrid is UTC+1 in January and UTC+2 in July. Both of these are 21:00 local.
  const sessions = [span(at('2026-01-15T20:00:00Z'), HOUR), span(at('2026-07-15T19:00:00Z'), HOUR)];
  const { hours } = bucketPlayTime(sessions, { timeZone: 'Europe/Madrid', ...WIDE });
  assert.equal(hours[21], 2 * 3600);
});

test('a zone offset by half an hour buckets on its own hour boundaries', () => {
  // Kolkata is UTC+5:30, so a UTC hour is split across two local hours.
  const { hours } = bucketPlayTime([span(at(`${MONDAY}T12:00:00Z`), HOUR)], { timeZone: 'Asia/Kolkata', ...WIDE });
  assert.equal(hours[17], 30 * 60);
  assert.equal(hours[18], 30 * 60);
});

test('sessions are clamped to the window rather than dropped or counted whole', () => {
  const windowStart = at(`${MONDAY}T12:00:00Z`);
  const windowEnd = at(`${MONDAY}T14:00:00Z`);
  const sessions = [
    span(at(`${MONDAY}T11:00:00Z`), 2 * HOUR), // started before the window, ran into it
    span(at(`${MONDAY}T13:30:00Z`), 2 * HOUR), // started inside, ran out past the end
    span(at(`${MONDAY}T08:00:00Z`), HOUR), // entirely before the window
  ];
  const { hours } = bucketPlayTime(sessions, { timeZone: 'UTC', windowStart, windowEnd });
  assert.equal(hours[11], 0);
  assert.equal(hours[12], 3600);
  assert.equal(hours[13], 30 * 60);
  assert.equal(hours[8], 0);
});

test('a session lands on the weekday it was played, Monday first', () => {
  const { weekdays } = bucketPlayTime([span(at(`${MONDAY}T14:00:00Z`), HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(weekdays.length, DAYS_IN_WEEK);
  assert.equal(weekdays[0], 3600);
  // Friday is index 4 and Sunday index 6 — the end of the week, not the start of it.
  assert.equal(bucketPlayTime([span(at('2026-06-19T14:00:00Z'), HOUR)], { timeZone: 'UTC', ...WIDE }).weekdays[4], 3600);
  assert.equal(bucketPlayTime([span(at('2026-06-21T14:00:00Z'), HOUR)], { timeZone: 'UTC', ...WIDE }).weekdays[6], 3600);
});

test('an evening running past midnight counts toward both days, not just the one it began on', () => {
  const { weekdays } = bucketPlayTime([span(at(`${MONDAY}T23:30:00Z`), HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(weekdays[0], 30 * 60);
  assert.equal(weekdays[1], 30 * 60);
});

test('a Sunday night rolling over lands on Monday, not off the end of the array', () => {
  const { weekdays } = bucketPlayTime([span(at('2026-06-21T23:00:00Z'), 2 * HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(weekdays[6], 3600);
  assert.equal(weekdays[0], 3600);
});

test('the weekday is the one on the configured zone calendar, not the UTC one', () => {
  const sessions = [span(at(`${MONDAY}T19:00:00Z`), HOUR)];
  assert.equal(bucketPlayTime(sessions, { timeZone: 'UTC', ...WIDE }).weekdays[0], 3600);
  // Tokyo is UTC+9, so a Monday evening in UTC is already Tuesday morning there.
  assert.equal(bucketPlayTime(sessions, { timeZone: 'Asia/Tokyo', ...WIDE }).weekdays[1], 3600);
});

test('both rows are cut from the same seconds, so their totals cannot disagree', () => {
  const sessions = [
    span(at(`${MONDAY}T20:30:00Z`), 5 * HOUR),
    span(at('2026-06-19T22:00:00Z'), 3.5 * HOUR),
    span(at('2026-06-21T09:15:00Z'), 90 * MINUTE),
  ];
  const { hours, weekdays } = bucketPlayTime(sessions, { timeZone: 'Europe/Madrid', ...WIDE });
  const total = (buckets) => buckets.reduce((sum, value) => sum + value, 0);
  assert.equal(total(hours), 10 * 3600);
  assert.equal(total(weekdays), total(hours));
});

test('an empty window has no busiest bucket', () => {
  assert.equal(busiestBucket(new Array(HOURS_IN_DAY).fill(0)), null);
  assert.equal(busiestBucket(new Array(DAYS_IN_WEEK).fill(0)), null);
  assert.equal(buildActivityLines([], { timeZone: 'UTC', now: T0 }), null);
  assert.equal(buildActivityLines([span(T0 - 200 * DAY, HOUR)], { timeZone: 'UTC', now: T0 }), null);
});

test('a bucket with nothing in it is drawn differently from one with a little', () => {
  const buckets = new Array(HOURS_IN_DAY).fill(0);
  buckets[3] = 1; // one second, but somebody was there
  buckets[20] = 36_000;
  const line = renderSparkline(buckets);
  assert.equal(line.length, HOURS_IN_DAY);
  assert.equal(line[20], '█');
  assert.notEqual(line[3], line[4]);
  assert.equal(line[4], '▁');
});

test('the sparkline scales against its own peak, so a quiet server still shows a shape', () => {
  const buckets = new Array(HOURS_IN_DAY).fill(0);
  buckets[9] = 60;
  buckets[21] = 600;
  const line = renderSparkline(buckets);
  assert.equal(line[21], '█');
  assert.ok(line[9] !== '█' && line[9] !== '▁');
});

test('a column width wider than one repeats each block rather than rescaling the row', () => {
  const buckets = new Array(DAYS_IN_WEEK).fill(0);
  buckets[4] = 3600;
  buckets[6] = 1;
  const wide = renderSparkline(buckets, 3);
  assert.equal(wide.length, DAYS_IN_WEEK * 3);
  assert.equal(wide.slice(12, 15), '███');
  // An empty day is still three columns of the reserved empty block, not blank space.
  assert.equal(wide.slice(0, 3), '▁▁▁');
  assert.notEqual(wide[18], '▁');
  // Same shape as the single-width row, just drawn three times as wide.
  assert.equal(wide, renderSparkline(buckets).split('').map((block) => block.repeat(3)).join(''));
});

test('the rendered block names both peaks and lines each axis up with its own row', () => {
  const evenings = [span(at('2026-06-19T21:00:00Z'), HOUR)]; // a Friday
  const lines = buildActivityLines(evenings, { timeZone: 'UTC', now: at('2026-06-22T00:00:00Z') });
  assert.equal(lines.length, 5);
  assert.match(lines[0], /busiest around \*\*21:00\*\*, mostly \*\*Fridays\*\*/);
  const [sparkline, hourAxis, dayRow, dayAxis] = lines.slice(1).map((line) => line.match(/`(.+)`/)[1]);
  assert.equal(sparkline.length, HOURS_IN_DAY);
  assert.equal(hourAxis.length, HOURS_IN_DAY);
  assert.equal(sparkline[21], '█');
  assert.match(lines[2], /last 90 days, UTC time/);
  // The day row and its axis are three characters per day, so `Fri` sits under the Friday block.
  assert.equal(dayRow.length, DAYS_IN_WEEK * 3);
  assert.equal(dayAxis, 'MonTueWedThuFriSatSun');
  assert.equal(dayRow.slice(12, 15), '███');
});

test('the heading names the zone the histogram was actually drawn in', () => {
  const lines = buildActivityLines([span(at(`${MONDAY}T19:00:00Z`), HOUR)], { timeZone: 'Europe/Madrid', now: T0 + 2 * DAY });
  assert.match(lines[0], /busiest around \*\*21:00\*\*/);
  assert.match(lines[2], /Madrid time/);
});

test('getSessionSpans returns what overlaps the window and skips what ended before it', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const old = T0 - 120 * DAY;
    playSession(db, 'g1', 'u1', 'Old Game', old, HOUR);
    playSession(db, 'g1', 'u1', 'Halo', T0 - 2 * DAY, 90 * MINUTE);
    playSession(db, 'g2', 'u2', 'Elsewhere', T0 - DAY, HOUR);

    const spans = db.getSessionSpans('g1', T0 - ACTIVITY_WINDOW_MS);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].started_at, T0 - 2 * DAY);
    assert.equal(spans[0].ended_at, T0 - 2 * DAY + 90 * MINUTE);

    // A session that began before the window but ran into it is kept, so the part inside counts.
    const straddling = db.getSessionSpans('g1', old + 30 * MINUTE);
    assert.equal(straddling.length, 2);
  } finally {
    cleanup();
  }
});
