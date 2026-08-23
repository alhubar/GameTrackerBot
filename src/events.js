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
