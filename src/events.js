const DATE_TIME_PATTERN = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/;

/** Converts a wall-clock date/time in the given IANA zone to a UTC epoch ms instant. */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(guessUtc)).map((part) => [part.type, part.value]));
  const hour24 = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour24, Number(parts.minute), Number(parts.second));
  const offset = asIfUtc - guessUtc;
  return guessUtc - offset;
}

/** Parses "DD-MM-YYYY HH:mm" in the given IANA zone. Returns { utcMs } or { error }. */
export function parseEventTime(text, timeZone) {
  const match = DATE_TIME_PATTERN.exec(text.trim());
  if (!match) return { error: 'Use the format DD-MM-YYYY HH:mm, e.g. 22-08-2026 20:00.' };
  const [, dayStr, monthStr, yearStr, hourStr, minuteStr] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (month < 1 || month > 12) return { error: 'Month must be between 01 and 12.' };
  if (day < 1 || day > 31) return { error: 'Day must be between 01 and 31.' };
  if (hour > 23 || minute > 59) return { error: 'Time must be a valid 24-hour HH:mm.' };

  const utcMs = zonedTimeToUtc(year, month, day, hour, minute, timeZone);

  const check = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]),
  );
  if (Number(check.year) !== year || Number(check.month) !== month || Number(check.day) !== day) {
    return { error: 'That is not a valid calendar date.' };
  }
  return { utcMs };
}

/** Formats a UTC epoch ms instant back into "DD-MM-YYYY HH:mm" wall-clock time in the given zone. */
export function formatEventTime(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, hour12: false,
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]),
  );
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * Recurring events — "every Friday at 20:00", the actual game-night case.
 *
 * The whole design turns on one decision: an occurrence that has passed **advances the same row**
 * rather than deleting it and inserting a new one. That is what makes the feature safe next to the
 * two cleanup loops it sits beside, both of which are deliberately at-most-once (a reminder stage
 * is marked sent before delivery is attempted, and expiry drops the row whether or not the message
 * deletion succeeded). Recurrence is the same class of problem pointing the other way — getting it
 * wrong at-most-once silently drops somebody's game night, getting it wrong the other way spams the
 * channel — and advancing in place answers both ends at once:
 *
 * - It cannot double-create, because the row's `starts_at` *is* the state and the advance is a
 *   compare-and-swap against the value it read. A second attempt, a second process, or a retry
 *   after a crash finds the old value gone and does nothing.
 * - It cannot silently drop the series, because nothing deletes the row. Everything after the
 *   advance — deleting the old announcement, posting a new one — is best-effort decoration on a
 *   schedule that is already correct.
 * - It cannot spam a backlog. The next occurrence is derived from the calendar, not counted off,
 *   so a bot that was down for three weeks lands on the next future Friday and posts once.
 */
export const REPEAT_RULES = ['daily', 'weekly', 'fortnightly'];

const REPEAT_DAYS = { daily: 1, weekly: 7, fortnightly: 14 };
const REPEAT_LABELS = { daily: 'Every day', weekly: 'Every week', fortnightly: 'Every two weeks' };

// Deliberately no monthly rule. Monthly needs an anchor day the row cannot carry: the 31st clamped
// into February becomes the 28th, and the month after that is the 28th too, so the series quietly
// walks backwards through the calendar. Storing the anchor is a different feature; three rules
// cover the case this was built for.
const NEVER = new Set(['', 'no', 'none', 'never', 'once', 'off', 'one-off', 'one off']);

const REPEAT_ALIASES = new Map([
  ['daily', 'daily'], ['day', 'daily'], ['1 day', 'daily'],
  ['weekly', 'weekly'], ['week', 'weekly'], ['1 week', 'weekly'], ['7 days', 'weekly'],
  ['fortnightly', 'fortnightly'], ['fortnight', 'fortnightly'], ['biweekly', 'fortnightly'],
  ['2 weeks', 'fortnightly'], ['14 days', 'fortnightly'], ['other week', 'fortnightly'],
]);

/**
 * Parses the modal's free-text Repeat field. Returns `{ rule }` — null for a one-off — or
 * `{ error }`.
 *
 * Free text rather than a dropdown because a modal cannot contain one, and the timezone step
 * already shows what the alternative costs: a whole extra click before the form opens, paid by
 * every event whether or not it repeats. Parsed leniently for the same reason the date field is.
 */
export function parseRepeatRule(text) {
  const raw = (text ?? '').trim().toLowerCase();
  if (NEVER.has(raw)) return { rule: null };
  const rule = REPEAT_ALIASES.get(raw.replace(/^every\s+/, '').replace(/\s+/g, ' '));
  if (!rule) return { error: `Repeat must be one of ${REPEAT_RULES.join(', ')} — or leave it blank for a one-off.` };
  return { rule };
}

/** How a repeat rule is written on the announcement and in /event list. Null for a one-off. */
export function describeRepeat(rule) {
  return REPEAT_LABELS[rule] ?? null;
}

/** The wall-clock fields of an instant, as read in a given zone. */
function wallClockParts(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: parts.hour === '24' ? 0 : Number(parts.hour), minute: Number(parts.minute),
  };
}

/**
 * Adds whole days to an instant **in wall-clock terms**, keeping the time of day fixed.
 *
 * Not `instant + days * 86_400_000`. A week is only 168 hours in a zone that did not change its
 * offset in between: add fixed milliseconds across a daylight-saving boundary and a Friday 20:00
 * game night becomes a Friday 19:00 one, permanently, for everybody. This is the reason events
 * record the zone they were written in at all — a bare UTC instant has no time of day to preserve.
 *
 * Date.UTC does the calendar arithmetic, including month and year overflow, on the date alone.
 */
function addDaysInZone(instant, days, timeZone) {
  const { year, month, day, hour, minute } = wallClockParts(instant, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return zonedTimeToUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), hour, minute, timeZone);
}

// Roughly eleven years of daily occurrences. A bound rather than a limit: this loop is what catches
// a bot up after downtime, and an unbounded one paired with a rule that somehow fails to advance
// would hang the event tick forever.
const MAX_ADVANCES = 4000;

/**
 * The first occurrence of a repeating event strictly after `now`. Null for a rule this version does
 * not recognise, or one that fails to advance.
 */
export function nextOccurrence(startsAt, rule, timeZone, now) {
  const days = REPEAT_DAYS[rule];
  if (!days) return null;
  let next = startsAt;
  for (let advances = 0; next <= now && advances < MAX_ADVANCES; advances += 1) {
    const advanced = addDaysInZone(next, days, timeZone);
    // A zone whose data is missing, or a rule that lands on itself, would otherwise spin.
    if (advanced <= next) return null;
    next = advanced;
  }
  return next > now ? next : null;
}

/**
 * How long after an occurrence starts before the row is rolled on to the next one.
 *
 * Long enough that the announcement has served the evening it was posted for, short enough that a
 * *daily* event rolls well before its next occurrence comes round. Not the 24 hours the one-off
 * expiry sweep uses, which would let a daily event's next start time arrive before the roll.
 */
export const RECURRENCE_ROLL_DELAY_MS = 3 * 60 * 60_000;

/**
 * Advances every recurring event whose occurrence has passed, and reports what needs re-announcing.
 * Returns `[{ event, previousMessageId, nextStartsAt }]`, where `event` is the row **as it was**.
 *
 * Kept free of Discord calls like `collectDueReminders`, so the rules are testable directly. The
 * database work here is the part that must be exactly-once; posting the new announcement is the
 * caller's, and is allowed to fail.
 */
export function rollRecurringEvents(db, now, options = {}) {
  const { delayMs = RECURRENCE_ROLL_DELAY_MS } = options;
  const rolled = [];
  for (const event of db.getRecurringEventsDue(now - delayMs)) {
    // Events written before the zone was recorded, and any row hand-edited since, fall back to
    // UTC — the clock everything else in this bot keeps.
    const next = nextOccurrence(event.starts_at, event.repeat_rule, event.timezone || 'UTC', now);
    if (next === null) {
      // A rule this version cannot advance. Demoting it to a one-off is deliberate: the expiry
      // sweep skips recurring rows precisely so a series can never be deleted out from under its
      // members, which would otherwise leave this one stranded in the table forever.
      console.warn(`[EVENT] Event ${event.id} has an unusable repeat rule ${JSON.stringify(event.repeat_rule)} — treating it as a one-off.`);
      db.clearEventRepeat(event.id);
      continue;
    }
    // Compare-and-swap against the start time just read. Anything that already rolled this
    // occurrence — a duplicate process, a retry after a crash mid-tick — leaves nothing to do.
    if (!db.rollEventForward(event.id, event.starts_at, next)) continue;
    rolled.push({ event, previousMessageId: event.message_id, nextStartsAt: next });
  }
  return rolled;
}

export const MIN_EVENT_REMINDER_GAP_MS = 15 * 60_000;
export const STARTED_STAGE_STALE_MS = 10 * 60_000;
const EVENT_SCAN_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Decides which event reminders are due right now, marks them sent, and returns what to announce.
 * Kept free of any Discord calls so the staging rules can be tested directly.
 * Returns [{ event, going, text }].
 */
export function collectDueReminders(db, stagesMinutes, now, options = {}) {
  const {
    minGapMs = MIN_EVENT_REMINDER_GAP_MS,
    staleMs = STARTED_STAGE_STALE_MS,
    lookbackMs = EVENT_SCAN_LOOKBACK_MS,
  } = options;
  const announcements = [];
  // A stage of 0 only becomes due once the event has actually started, so events already past
  // their start time need to stay visible to this scan (not just strictly-upcoming ones).
  for (const event of db.getUpcomingEvents(now - lookbackMs)) {
    const dueStages = stagesMinutes.filter((stageMinutes) =>
      !db.hasReminderSent(event.id, stageMinutes) && event.starts_at - stageMinutes * 60_000 <= now);
    if (!dueStages.length) continue;
    // Don't burn a stage while nobody's signed up yet — leave it pending so whoever signs up
    // later still gets a reminder.
    const going = db.getEventSignups(event.id).filter((row) => row.status === 'going');
    if (!going.length) continue;
    // If the event's total lead time is short, two stages can cross their thresholds in quick
    // succession and read as a spammy near-duplicate pair. Skip if one went out very recently —
    // the stage stays pending and fires on a later tick once the cooldown clears.
    // The at-start announcement is exempt: it is not a near-duplicate of an earlier "starts in X"
    // message but a distinct one, and delaying it past the start time makes it worthless.
    const isStartAnnouncement = dueStages.includes(0);
    const lastSentAt = db.getLastReminderSentAt(event.id);
    if (!isStartAnnouncement && lastSentAt && now - lastSentAt < minGapMs) continue;
    for (const stageMinutes of dueStages) db.markReminderSent(event.id, stageMinutes, now);
    const minutesRemaining = Math.round((event.starts_at - now) / 60_000);
    // "Starting now" only makes sense if we caught it promptly — if a delayed signup meant this
    // fires long after the event began, say nothing rather than announce something false.
    if (minutesRemaining <= 0 && now - event.starts_at > staleMs) continue;
    // Deliberately just the phrase, not the emoji or title — index.js owns those so it can render
    // the title as an inline link back to the event rather than plain quoted text.
    const text = minutesRemaining <= 0
      ? 'is starting now!'
      : `event starts in ${formatReminderDuration(minutesRemaining)}.`;
    announcements.push({ event, going, text });
  }
  return announcements;
}

/** Turns a duration (in minutes) into a short, rounded human-readable phrase — "1 hour" rather
 *  than "61 minutes". Exact minutes are only shown once there's less than an hour left. */
export function formatReminderDuration(minutes) {
  const hours = Math.round(minutes / 60);
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
