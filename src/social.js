/**
 * Social minutes: the arithmetic behind tracking members who turn up to talk rather than play.
 *
 * The unit is a *minute a member was socially active*, never a message count — a count rewards
 * spam, and minutes keep the bot a time tracker rather than growing a second, stranger unit.
 *
 * Kept free of Discord and of the database so the day/window rules can be tested against a fixed
 * clock. database.js owns the buckets; the presence of a row is not decided here.
 */

/**
 * The UTC day a moment falls in, as 'YYYY-MM-DD'.
 *
 * Same shape as `backupDay` in backup.js and the private `dayKey` in achievements.js. Deliberately
 * not shared with either: both are load-bearing for features with their own tests, and collapsing
 * three one-line functions into one import is not worth touching achievement behaviour for.
 */
export const socialDayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The epoch-minute a moment falls in. Used only to make the text write idempotent within a minute. */
export const epochMinute = (ms) => Math.floor(ms / 60_000);

/**
 * The inclusive day range covering a half-open [fromMs, toMs) window.
 *
 * `toMs` is exclusive, so the last day is the one containing the instant *before* it — the same
 * step-back `weekLabel` makes when rendering a period. That gets both callers right: a recap
 * window ends exactly at UTC midnight, where stepping back lands on the previous day and excludes
 * it correctly; a preview asking about the period in progress ends mid-day, where stepping back
 * stays on today and includes the partial day so far.
 *
 * The granularity is a whole day either way. A window that starts or ends mid-day counts those
 * days in full, which is why this must not be used for anything finer than a period boundary.
 */
export function windowDays(fromMs, toMs) {
  return { fromDay: socialDayKey(fromMs), toDay: socialDayKey(Math.max(fromMs, toMs - 1)) };
}

/**
 * The two rankings. Each badge is ranked on its own unit against itself, which is why there is no
 * weighting anywhere in this feature: a two-hour call is 120 voice minutes while typing in 120
 * distinct minutes is an enormous chat day, and any single number combining them has to answer for
 * an exchange rate nobody agrees on. Two crowns, two units, no arithmetic to argue with.
 */
export const SOCIAL_METRICS = ['text', 'voice'];

/**
 * Whether this member counts as never having spoken, rather than merely having no rows.
 *
 * Absence of data is not evidence of silence, so the question is only answerable from a floor:
 * tracking must have been running, and the member must have been in the guild, for at least
 * `graceMs` before now. Without it, someone who joined yesterday and someone who has been quiet
 * for a year are indistinguishable — and only one of them has earned the joke.
 *
 * `trackingStartedAt` or `joinedAt` of null means the floor is unknown, which is answered "no"
 * rather than guessed.
 */
export function isSilent({ firstActiveDay, trackingStartedAt, joinedAt, graceMs }, now) {
  if (firstActiveDay) return false;
  if (trackingStartedAt == null || joinedAt == null) return false;
  return now - Math.max(trackingStartedAt, joinedAt) >= graceMs;
}
