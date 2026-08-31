import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketPlayHours, busiestHour, renderSparkline, buildActivityLines, ACTIVITY_WINDOW_MS, HOURS_IN_DAY } from '../src/activity.js';
import { tempDatabase, playSession, HOUR, MINUTE, DAY, T0 } from './helpers.js';

const span = (startedAt, durationMs) => ({ started_at: startedAt, ended_at: startedAt + durationMs });
const at = (iso) => Date.parse(iso);
const WIDE = { windowStart: 0, windowEnd: Number.MAX_SAFE_INTEGER };

test('a session lands in the hour it was played, in UTC', () => {
  const buckets = bucketPlayHours([span(at('2026-06-15T14:00:00Z'), HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(buckets[14], 3600);
  assert.equal(buckets.reduce((sum, value) => sum + value, 0), 3600);
});

test('a session spanning hours credits every hour it covered, not just its start', () => {
  // 20:30 to 23:00 — the point of the whole feature: whoever was around at 22:00 shows at 22:00.
  const buckets = bucketPlayHours([span(at('2026-06-15T20:30:00Z'), 2.5 * HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(buckets[20], 30 * 60);
  assert.equal(buckets[21], 3600);
  assert.equal(buckets[22], 3600);
  assert.equal(buckets[23], 0);
});

test('a session crossing midnight splits across the day boundary', () => {
  const buckets = bucketPlayHours([span(at('2026-06-15T23:30:00Z'), HOUR)], { timeZone: 'UTC', ...WIDE });
  assert.equal(buckets[23], 30 * 60);
  assert.equal(buckets[0], 30 * 60);
});

test('buckets are wall-clock hours in the configured zone, not UTC hours', () => {
  const sessions = [span(at('2026-06-15T19:00:00Z'), HOUR)];
  assert.equal(bucketPlayHours(sessions, { timeZone: 'UTC', ...WIDE })[19], 3600);
  // Madrid is UTC+2 in June, so the same instant is a 21:00 evening there.
  assert.equal(bucketPlayHours(sessions, { timeZone: 'Europe/Madrid', ...WIDE })[21], 3600);
  // Tokyo is UTC+9 year round, which pushes it past midnight into the next day.
  assert.equal(bucketPlayHours(sessions, { timeZone: 'Asia/Tokyo', ...WIDE })[4], 3600);
});

test('the offset is read per instant, so a window straddling a DST change stays aligned', () => {
  // Madrid is UTC+1 in January and UTC+2 in July. Both of these are 21:00 local.
  const sessions = [span(at('2026-01-15T20:00:00Z'), HOUR), span(at('2026-07-15T19:00:00Z'), HOUR)];
  const buckets = bucketPlayHours(sessions, { timeZone: 'Europe/Madrid', ...WIDE });
  assert.equal(buckets[21], 2 * 3600);
});

test('a zone offset by half an hour buckets on its own hour boundaries', () => {
  // Kolkata is UTC+5:30, so a UTC hour is split across two local hours.
  const buckets = bucketPlayHours([span(at('2026-06-15T12:00:00Z'), HOUR)], { timeZone: 'Asia/Kolkata', ...WIDE });
  assert.equal(buckets[17], 30 * 60);
  assert.equal(buckets[18], 30 * 60);
});

test('sessions are clamped to the window rather than dropped or counted whole', () => {
  const windowStart = at('2026-06-15T12:00:00Z');
  const windowEnd = at('2026-06-15T14:00:00Z');
  const sessions = [
    span(at('2026-06-15T11:00:00Z'), 2 * HOUR), // started before the window, ran into it
    span(at('2026-06-15T13:30:00Z'), 2 * HOUR), // started inside, ran out past the end
    span(at('2026-06-15T08:00:00Z'), HOUR), // entirely before the window
  ];
  const buckets = bucketPlayHours(sessions, { timeZone: 'UTC', windowStart, windowEnd });
  assert.equal(buckets[11], 0);
  assert.equal(buckets[12], 3600);
  assert.equal(buckets[13], 30 * 60);
  assert.equal(buckets[8], 0);
});

test('an empty window has no busiest hour', () => {
  assert.equal(busiestHour(new Array(HOURS_IN_DAY).fill(0)), null);
  assert.equal(buildActivityLines([], { timeZone: 'UTC', now: T0 }), null);
  assert.equal(buildActivityLines([span(T0 - 200 * DAY, HOUR)], { timeZone: 'UTC', now: T0 }), null);
});

test('an hour with nothing in it is drawn differently from an hour with a little', () => {
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

test('the rendered block names the peak hour and lines its axis up with the blocks', () => {
  const lines = buildActivityLines([span(at('2026-06-15T21:00:00Z'), HOUR)], { timeZone: 'UTC', now: T0 + 2 * DAY });
  assert.match(lines[0], /busiest around \*\*21:00\*\*/);
  const sparkline = lines[1].match(/`(.+)`/)[1];
  const axis = lines[2].match(/`(.+)`/)[1];
  assert.equal(sparkline.length, HOURS_IN_DAY);
  assert.equal(axis.length, HOURS_IN_DAY);
  assert.equal(sparkline[21], '█');
  assert.match(lines[2], /last 90 days, UTC time/);
});

test('the heading names the zone the histogram was actually drawn in', () => {
  const lines = buildActivityLines([span(at('2026-06-15T19:00:00Z'), HOUR)], { timeZone: 'Europe/Madrid', now: T0 + 2 * DAY });
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
