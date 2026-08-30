/**
 * The end-of-period recap: who played the most last week (or month), and what they played.
 *
 * Weekly is the default because the winner's badge is meant to circulate — on a small server a
 * monthly title parks on one person for four weeks, while a weekly one keeps moving.
 *
 * Kept free of Discord calls so the "is it due / who won / what did they do" rules can be tested
 * directly. index.js handles posting and the winner's role.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK_MS = 7 * 24 * 60 * 60_000;

export const RECAP_PERIODS = ['week', 'month'];

/**
 * The badges the recap keeps a permanent record of, in the order they are displayed.
 *
 * `name` is the fallback only. Every one of these is a *configurable* role name, and what members
 * actually see on somebody is whatever the server called it — so the render sites substitute the
 * configured name and fall back to these when a badge has been switched off. History outliving the
 * setting that made it is the point: turning Bard off should stop new ones being awarded, not erase
 * the three somebody already won.
 *
 * Cave Dweller is absent on purpose and the database comment explains why — it is not a thing
 * anybody won, and nothing should be counting it.
 */
export const RECAP_BADGES = [
  { key: 'champion', emoji: '🏆', name: 'Champion' },
  { key: 'bard', emoji: '🎵', name: 'Bard' },
  { key: 'scribe', emoji: '✍️', name: 'Scribe' },
];

/** Midnight UTC on the Monday of the week containing `ms`. */
function startOfWeek(ms) {
  const date = new Date(ms);
  const mondayOffset = (date.getUTCDay() + 6) % 7; // Sunday is 0, so shift it to the end
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayOffset);
}

/** ISO-8601 week key, e.g. "2026-W33". Handles the turn of the year, where the week can belong
 *  to the neighbouring year. */
function isoWeekKey(ms) {
  const target = new Date(startOfWeek(ms) + 3 * 24 * 60 * 60_000); // the Thursday decides the year
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstWeekThursday = new Date(startOfWeek(firstThursday.getTime()) + 3 * 24 * 60 * 60_000);
  const week = 1 + Math.round((target.getTime() - firstWeekThursday.getTime()) / WEEK_MS);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** "11–17 August 2026", collapsing the repeated month or year where it reads better. */
function weekLabel(start, end) {
  const from = new Date(start);
  const to = new Date(end - 1); // end is exclusive, so step back into the final day
  const fromMonth = MONTH_NAMES[from.getUTCMonth()];
  const toMonth = MONTH_NAMES[to.getUTCMonth()];
  if (from.getUTCFullYear() !== to.getUTCFullYear()) {
    return `${from.getUTCDate()} ${fromMonth} ${from.getUTCFullYear()} – ${to.getUTCDate()} ${toMonth} ${to.getUTCFullYear()}`;
  }
  if (fromMonth !== toMonth) {
    return `${from.getUTCDate()} ${fromMonth} – ${to.getUTCDate()} ${toMonth} ${to.getUTCFullYear()}`;
  }
  return `${from.getUTCDate()}–${to.getUTCDate()} ${fromMonth} ${from.getUTCFullYear()}`;
}

/**
 * The completed period before the one containing `now`, as
 * { start, end, key, label, period, periodNoun, title }. `end` is exclusive, so consecutive
 * periods meet exactly and never double-count a session.
 */
export function previousPeriodRange(now, period = 'week') {
  if (period === 'month') {
    const date = new Date(now);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const start = Date.UTC(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1, 1);
    const end = Date.UTC(year, month, 1);
    const startDate = new Date(start);
    return {
      start,
      end,
      key: `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`,
      label: `${MONTH_NAMES[startDate.getUTCMonth()]} ${startDate.getUTCFullYear()}`,
      period: 'month',
      periodNoun: 'month',
      title: 'Gamer of the Month',
    };
  }
  const end = startOfWeek(now);
  const start = end - WEEK_MS;
  return {
    start,
    end,
    key: isoWeekKey(start),
    label: weekLabel(start, end),
    period: 'week',
    periodNoun: 'week',
    title: 'Gamer of the Week',
  };
}

/**
 * The instant the period containing `now` gives way to the next one. Evaluating a recap at this
 * moment makes the period currently in progress the one being recapped, which is what the preview
 * script needs to show standings before the period has actually finished.
 */
export function nextPeriodStart(now, period = 'week') {
  if (period === 'month') {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return startOfWeek(now) + WEEK_MS;
}

/**
 * Builds the last completed period's recap.
 *
 * Always returns { range, podium, winner, minSeconds }. `winner` is null when nobody cleared
 * `minSeconds` — a token few minutes should not crown anyone, and on a quiet week the title is
 * better left vacant than handed to whoever happened to open a launcher. Callers announce that
 * case rather than staying silent, so the badge visibly changes hands (or visibly does not).
 */
export function buildRecap(db, guildId, now, { period = 'week', podiumSize = 3, minSeconds = 0 } = {}) {
  const range = previousPeriodRange(now, period);
  const leaderboard = db.getMonthlyLeaderboard(guildId, range.start, range.end, podiumSize);
  const podium = leaderboard.map((row) => ({ userId: row.user_id, totalSeconds: row.total_seconds }));
  const top = podium[0];

  if (!top || top.totalSeconds < minSeconds) {
    return { range, podium, winner: null, minSeconds };
  }

  const topGame = db.getMonthlyTopGame(guildId, top.userId, range.start, range.end);
  return {
    range,
    podium,
    minSeconds,
    winner: {
      ...top,
      topGame: topGame?.game_name ?? null,
      topGameSeconds: topGame?.total_seconds ?? 0,
      gamesPlayed: db.getMonthlyGameCount(guildId, top.userId, range.start, range.end),
      achievements: db.getAchievementsUnlockedBetween(guildId, top.userId, range.start, range.end),
    },
  };
}

/**
 * True when the last completed period has not been posted yet for this guild.
 * The stored key is the last period announced, so a restart part-way through can't repost it.
 */
export function isRecapDue(db, guildId, now, period = 'week') {
  return db.getLastMonthlyRecap(guildId) !== previousPeriodRange(now, period).key;
}

/** Records the last completed period as announced, whether or not there was anything to post. */
export function markRecapAnnounced(db, guildId, now, period = 'week') {
  db.setLastMonthlyRecap(guildId, previousPeriodRange(now, period).key);
}
