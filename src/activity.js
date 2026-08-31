/**
 * When the server actually plays: a 24-hour histogram of tracked playtime.
 *
 * Every other query in this bot reads how *long* a session ran (`duration_seconds`) or which
 * window it fell in (`ended_at`). This is the only one that reads the clock it happened on, which
 * answers a question none of the others can — "is anyone around at 21:00 on a weeknight" — and
 * that is the question `/event` exists to guess at.
 *
 * Pure on purpose: no db, no Discord, no `Date.now()`. The caller supplies the session spans, the
 * window and the clock, the same shape `recap.js` and `socialBadges.js` use, so every rule below
 * is testable against a pinned instant.
 *
 * **A session counts for every hour it covered, not just the hour it began.** Somebody who starts
 * at 20:00 and plays until midnight was around at 23:00, and a start-time histogram would say
 * otherwise — which is exactly the wrong answer for "when will people show up". The cost is that
 * this walks each session hour by hour rather than being one `GROUP BY`; the window bounds that
 * walk, so it is at worst a few thousand iterations per session and normally a handful.
 *
 * **The buckets are wall-clock hours in a configured zone, not UTC hours.** Everything else here
 * is UTC and stays UTC — but "when do we play" is a question about people's evenings, and a UTC
 * histogram reads hours wrong for any server that does not live near it. `SERVER_TIMEZONE` is the
 * one place that choice is made; the rendered heading names the zone so nobody reads a peak in the
 * wrong one.
 *
 * Deliberately unfiltered for opted-out and departed members. It is a count of hours with no name
 * attached to any of them — the same reason server totals are not filtered — and opted-out members
 * stop producing session rows at the moment they opt out anyway.
 */

const HOUR_MS = 60 * 60 * 1000;
export const HOURS_IN_DAY = 24;

/** How far back the histogram looks. Long enough that a quiet fortnight does not distort the
 *  shape, short enough that how the server played a year ago does not drown out how it plays now. */
export const ACTIVITY_WINDOW_DAYS = 90;
export const ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_DAYS * 24 * HOUR_MS;

/**
 * Blocks are ordered lightest to heaviest, and index 0 is reserved for an hour with *nothing* in
 * it. A bucket with real but tiny play therefore starts at index 1, so "quiet" and "never" are
 * never drawn the same — the difference between an hour nobody has claimed yet and one somebody
 * occasionally plays is the whole point of looking at this.
 */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

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
 * Seconds of tracked play falling in each wall-clock hour, as a 24-entry array indexed 0–23.
 *
 * `sessions` are rows of `{ started_at, ended_at }` in UTC epoch ms; anything overlapping the
 * window is clamped to it, so a session that began before the window still contributes the part
 * that lands inside. Rows entirely outside contribute nothing and cost nothing.
 */
export function bucketPlayHours(sessions, { timeZone, windowStart, windowEnd }) {
  const buckets = new Array(HOURS_IN_DAY).fill(0);
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
      buckets[((localHourIndex % HOURS_IN_DAY) + HOURS_IN_DAY) % HOURS_IN_DAY] += (sliceEnd - cursor) / 1000;
      cursor = sliceEnd;
    }
  }
  return buckets;
}

/** The hour with the most tracked play, or null when the window holds nothing at all. */
export function busiestHour(buckets) {
  const peak = Math.max(...buckets);
  return peak > 0 ? buckets.indexOf(peak) : null;
}

/** The histogram as one row of 24 block characters, scaled against its own busiest hour. */
export function renderSparkline(buckets) {
  const peak = Math.max(...buckets);
  if (peak <= 0) return BLOCKS[0].repeat(HOURS_IN_DAY);
  return buckets
    .map((seconds) => (seconds > 0 ? BLOCKS[Math.min(BLOCKS.length - 1, 1 + Math.floor((seconds / peak) * (BLOCKS.length - 1)))] : BLOCKS[0]))
    .join('');
}

/**
 * The hour axis, built to the same 24 characters wide as the sparkline so the two line up when
 * Discord renders them as adjacent code spans. Anything wider than the row it labels would push
 * the last mark past the block it points at, so labels that would overrun are dropped.
 */
function renderAxis() {
  const axis = new Array(HOURS_IN_DAY).fill(' ');
  for (const hour of [0, 6, 12, 18]) {
    const label = `${hour}h`;
    if (hour + label.length > HOURS_IN_DAY) continue;
    for (let index = 0; index < label.length; index += 1) axis[hour + index] = label[index];
  }
  return axis.join('');
}

const zoneLabel = (timeZone) => timeZone.split('/').pop().replace(/_/g, ' ');

/**
 * The `/server` section, or null when the window holds no play at all.
 *
 * Null rather than a placeholder for the same reason the records and Hall of Fame sections return
 * nothing when empty: a heading over an empty row of blocks reads as something broken, and the
 * caller drops the whole block including its blank line.
 *
 * Both rows are wrapped in code spans, which is what makes them monospace — proportional block
 * characters would drift out of alignment with the axis beneath them within a few hours.
 */
export function buildActivityLines(sessions, { timeZone, now, windowMs = ACTIVITY_WINDOW_MS }) {
  const buckets = bucketPlayHours(sessions, { timeZone, windowStart: now - windowMs, windowEnd: now });
  const peakHour = busiestHour(buckets);
  if (peakHour === null) return null;
  const days = Math.round(windowMs / (24 * HOUR_MS));
  return [
    `🕒 **When we play** — busiest around **${String(peakHour).padStart(2, '0')}:00**`,
    `└ \`${renderSparkline(buckets)}\``,
    `└ \`${renderAxis()}\` last ${days} days, ${zoneLabel(timeZone)} time`,
  ];
}
