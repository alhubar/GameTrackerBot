/**
 * When the server actually plays: a 24-hour histogram of tracked playtime, and the same window
 * again by day of the week.
 *
 * Every other query in this bot reads how *long* a session ran (`duration_seconds`) or which
 * window it fell in (`ended_at`). This is the only one that reads the clock and calendar it
 * happened on, which answers a question none of the others can — "is anyone around at 21:00 on a
 * weeknight" — and that is the question `/event` exists to guess at. Both halves are needed for
 * that: an hour on its own cannot tell a server that plays every evening from one that only plays
 * weekends.
 *
 * Pure on purpose: no db, no Discord, no `Date.now()`. The caller supplies the session spans, the
 * window and the clock, the same shape `recap.js` and `socialBadges.js` use, so every rule below
 * is testable against a pinned instant.
 *
 * **A session counts for every hour and every day it covered, not just the ones it began in.**
 * Somebody who starts at 20:00 and plays until midnight was around at 23:00, and an evening that
 * runs past local midnight was two days of somebody being around. A start-time histogram would say
 * otherwise — which is exactly the wrong answer for "when will people show up". The cost is that
 * this walks each session hour by hour rather than being one `GROUP BY`; the window bounds that
 * walk, so it is at worst a few thousand iterations per session and normally a handful. Both
 * buckets come off that one walk: every slice already knows the local instant a weekday index is
 * derived from, so asking the second question costs nothing but the addition.
 *
 * **The buckets are wall-clock hours and days in a configured zone, not UTC ones.** Everything
 * else here is UTC and stays UTC — but "when do we play" is a question about people's evenings, and
 * a UTC histogram reads hours wrong for any server that does not live near it. `SERVER_TIMEZONE` is
 * the one place that choice is made; the rendered heading names the zone so nobody reads a peak in
 * the wrong one.
 *
 * Deliberately unfiltered for opted-out and departed members. It is a count of hours with no name
 * attached to any of them — the same reason server totals are not filtered — and opted-out members
 * stop producing session rows at the moment they opt out anyway.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const HOURS_IN_DAY = 24;
export const DAYS_IN_WEEK = 7;

/** How far back the histogram looks. Long enough that a quiet fortnight does not distort the
 *  shape, short enough that how the server played a year ago does not drown out how it plays now. */
export const ACTIVITY_WINDOW_DAYS = 90;
export const ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_DAYS * 24 * HOUR_MS;

/**
 * Blocks are ordered lightest to heaviest, and index 0 is reserved for a bucket with *nothing* in
 * it. A bucket with real but tiny play therefore starts at index 1, so "quiet" and "never" are
 * never drawn the same — the difference between an hour nobody has claimed yet and one somebody
 * occasionally plays is the whole point of looking at this.
 */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Monday first, because a week of gaming reads as five evenings and then a weekend. */
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * 1970-01-01 was a Thursday, so day 0 of the epoch is index 3 of a Monday-first week. Every other
 * day falls out of that one constant.
 */
const EPOCH_WEEKDAY_INDEX = 3;

/**
 * Each day is drawn three columns wide. One block per day is only seven characters against the
 * hour row's twenty-four, which reads as an afterthought and forces a single-letter axis where T
 * and S each mean two different days. Three columns puts the day row at 21 characters — near
 * enough the row above it — and lets the axis spell `Mon`, which cannot be misread.
 */
const WEEKDAY_COLUMNS = 3;

const wrap = (value, size) => ((value % size) + size) % size;

const formatters = new Map();
function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * How far `timeZone`'s wall clock is from UTC at the given instant, in ms.
 *
 * Asked per instant rather than once per zone, because it is not a constant: a 90-day window
 * always straddles a daylight-saving change somewhere, and half of it would land an hour out if
 * the offset were cached. Same trick `zonedTimeToUtc` in events.js uses, read in the other
 * direction. Zones offset by 30 or 45 minutes fall out of it correctly for free.
 */
function zoneOffsetMs(ms, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  // The parts carry no milliseconds, so compare against the instant truncated to the same second.
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Seconds of tracked play by wall-clock hour (24 entries, indexed 0–23) and by day of the week
 * (7 entries, Monday first), from a single pass.
 *
 * `sessions` are rows of `{ started_at, ended_at }` in UTC epoch ms; anything overlapping the
 * window is clamped to it, so a session that began before the window still contributes the part
 * that lands inside. Rows entirely outside contribute nothing and cost nothing.
 *
 * Every slice the walk produces sits inside one local hour and therefore inside one local day, so
 * both buckets are credited from the same slice and can never disagree about how much time the
 * window held.
 */
export function bucketPlayTime(sessions, { timeZone, windowStart, windowEnd }) {
  const hours = new Array(HOURS_IN_DAY).fill(0);
  const weekdays = new Array(DAYS_IN_WEEK).fill(0);
  for (const session of sessions) {
    let cursor = Math.max(session.started_at, windowStart);
    const end = Math.min(session.ended_at, windowEnd);
    while (cursor < end) {
      const offset = zoneOffsetMs(cursor, timeZone);
      const local = cursor + offset;
      const localHourIndex = Math.floor(local / HOUR_MS);
      // The next *local* hour boundary, not the next UTC one — which is the same instant in most
      // zones and deliberately is not in the ones offset by half an hour.
      const nextBoundary = (localHourIndex + 1) * HOUR_MS - offset;
      // A daylight-saving jump can put the computed boundary behind the cursor. Stepping a flat
      // hour instead keeps the walk moving; the alternative is an infinite loop twice a year.
      const sliceEnd = Math.min(end, nextBoundary > cursor ? nextBoundary : cursor + HOUR_MS);
      const seconds = (sliceEnd - cursor) / 1000;
      hours[wrap(localHourIndex, HOURS_IN_DAY)] += seconds;
      weekdays[wrap(Math.floor(local / DAY_MS) + EPOCH_WEEKDAY_INDEX, DAYS_IN_WEEK)] += seconds;
      cursor = sliceEnd;
    }
  }
  return { hours, weekdays };
}

/** The fullest bucket in a row, or null when the row holds nothing at all. */
export function busiestBucket(buckets) {
  const peak = Math.max(...buckets);
  return peak > 0 ? buckets.indexOf(peak) : null;
}

/**
 * One row of block characters, scaled against its own busiest bucket — never against the other
 * row, which holds the same seconds cut a different way and would flatten the shorter row to
 * nothing. `columnWidth` repeats each block, which is how the seven-day row reaches a width worth
 * looking at.
 */
export function renderSparkline(buckets, columnWidth = 1) {
  const peak = Math.max(...buckets);
  if (peak <= 0) return BLOCKS[0].repeat(buckets.length * columnWidth);
  return buckets
    .map((seconds) => (seconds > 0 ? BLOCKS[Math.min(BLOCKS.length - 1, 1 + Math.floor((seconds / peak) * (BLOCKS.length - 1)))] : BLOCKS[0]))
    .map((block) => block.repeat(columnWidth))
    .join('');
}

/**
 * The hour axis, built to the same 24 characters wide as the sparkline so the two line up when
 * Discord renders them as adjacent code spans. Anything wider than the row it labels would push
 * the last mark past the block it points at, so labels that would overrun are dropped.
 */
function renderHourAxis() {
  const axis = new Array(HOURS_IN_DAY).fill(' ');
  for (const hour of [0, 6, 12, 18]) {
    const label = `${hour}h`;
    if (hour + label.length > HOURS_IN_DAY) continue;
    for (let index = 0; index < label.length; index += 1) axis[hour + index] = label[index];
  }
  return axis.join('');
}

/** The day axis, exactly `WEEKDAY_COLUMNS` characters per day so each name sits under its own block. */
function renderWeekdayAxis() {
  return WEEKDAY_NAMES.map((name) => name.slice(0, WEEKDAY_COLUMNS)).join('');
}

const zoneLabel = (timeZone) => timeZone.split('/').pop().replace(/_/g, ' ');

/**
 * The `/server` section, or null when the window holds no play at all.
 *
 * Null rather than a placeholder for the same reason the records and Hall of Fame sections return
 * nothing when empty: a heading over an empty row of blocks reads as something broken, and the
 * caller drops the whole block including its blank line. One check covers both rows — they hold the
 * same seconds, so neither can have a peak the other lacks.
 *
 * Every row is wrapped in a code span, which is what makes it monospace — proportional block
 * characters would drift out of alignment with the axis beneath them within a few hours.
 *
 * Deliberately not on the `/stats` card's Server tab, day row included: a monospace row is a shape
 * rather than a value, and that tab holds values. The seven-block row is short enough to fit there,
 * which is exactly why the question was decided on purpose rather than by default — same call that
 * closed #13.
 */
export function buildActivityLines(sessions, { timeZone, now, windowMs = ACTIVITY_WINDOW_MS }) {
  const { hours, weekdays } = bucketPlayTime(sessions, { timeZone, windowStart: now - windowMs, windowEnd: now });
  const peakHour = busiestBucket(hours);
  if (peakHour === null) return null;
  const peakWeekday = busiestBucket(weekdays);
  const days = Math.round(windowMs / DAY_MS);
  return [
    `🕒 **When we play** — busiest around **${String(peakHour).padStart(2, '0')}:00**, mostly **${WEEKDAY_NAMES[peakWeekday]}s**`,
    `└ \`${renderSparkline(hours)}\``,
    `└ \`${renderHourAxis()}\` last ${days} days, ${zoneLabel(timeZone)} time`,
    `└ \`${renderSparkline(weekdays, WEEKDAY_COLUMNS)}\``,
    `└ \`${renderWeekdayAxis()}\``,
  ];
}
