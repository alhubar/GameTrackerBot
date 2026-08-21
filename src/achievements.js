import { rankForSeconds } from './ranks.js';

/**
 * Grouped by category, and within each category ordered from easiest to hardest.
 *
 * Day-count thresholds are picked so that no two can be satisfied on the same day, which matters
 * most for a member who only ever plays one game — for them "days on this game" and "days played"
 * are the same number, so any shared threshold would fire two awards at once and read as a
 * duplicate. The full ladder for that worst case, in order:
 *
 *   day  14  No Days Off      (consecutive)
 *   day  30  Habit            (consecutive)
 *   day  45  Can't Let Go     (distinct days, one game)
 *   day  60  Regular          (distinct days, any game)
 *   day  90  One True Game    (distinct days, one game)
 *   day 180  Dedicated        (distinct days, any game)
 *   day 360  Legend           (distinct days, any game)
 *
 * The streak pair sits at the bottom on purpose: they are the early-game ladder, reachable in a
 * couple of weeks of steady play, while the attendance tiers are the long game and are paced to
 * sit alongside how long the ranks take to climb. Changing any number here means re-checking it
 * against the rest of this ladder — a streak of N is also N distinct days, so two thresholds that
 * share a value would fire together and read as a duplicate.
 */
export const ACHIEVEMENTS = [
  // Collection — how many different games you've touched, all time.
  { id: 'first_steps', emoji: '🐣', name: 'First Steps', description: 'Play your first tracked game.' },
  { id: 'collector', emoji: '🗂️', name: 'Collector', description: 'Play 10 different games.' },
  { id: 'game_hoarder', emoji: '📦', name: 'Game Hoarder', description: 'Play 25 different games.' },
  { id: 'the_backlog', emoji: '📚', name: 'The Backlog', description: 'Play 50 different games.' },
  { id: 'send_help', emoji: '🆘', name: 'Send Help', description: 'Play 75 different games.' },

  // Variety — how many different games in a single day.
  { id: 'variety_is_overrated', emoji: '🎲', name: 'Variety Is Overrated', description: 'Play 3 different games in one day.' },
  { id: 'speedrunner', emoji: '🏃', name: 'Speedrunner', description: 'Start 5 different games within a 3-hour window.' },
  { id: 'identity_crisis', emoji: '🌀', name: 'Identity Crisis', description: 'Play 6 different games in one day.' },
  { id: 'speed_dating', emoji: '💔', name: 'The Speed Dating', description: 'Play 4 different games in one day, none longer than 10 minutes.' },

  // Attendance — distinct days played, any game, in any order.
  { id: 'regular', emoji: '🗓️', name: 'Regular', description: 'Play on 60 different days.' },
  { id: 'dedicated', emoji: '⭐', name: 'Dedicated', description: 'Play on 180 different days.' },
  { id: 'legend', emoji: '🏛️', name: 'Legend', description: 'Play on 360 different days.' },

  // Streaks — consecutive days, no gaps.
  { id: 'no_days_off', emoji: '🔥', name: 'No Days Off', description: 'Play 14 days in a row.' },
  { id: 'habit', emoji: '💪', name: 'Habit', description: 'Play 30 days in a row.' },

  // Loyalty — sticking with one particular game.
  { id: 'cant_let_go', emoji: '🔁', name: "Can't Let Go", description: 'Play the same game on 45 different days.' },
  { id: 'one_true_game', emoji: '💍', name: 'One True Game', description: 'Play the same game on 90 different days.' },
  { id: 'the_whale', emoji: '🐋', name: 'The Whale', description: 'Reach 120+ hours on a single game.' },

  // Session length — how long a single sitting ran.
  { id: 'wrong_game', emoji: '🙈', name: 'Wrong Game', description: 'End a session under 30 seconds.' },
  { id: 'just_one_more_game', emoji: '🎮', name: 'Just One More Game', description: 'Play a single session lasting 3+ hours.' },
  { id: 'should_go_to_bed', emoji: '😴', name: 'I Should Probably Go To Bed', description: 'Play a single session lasting 5+ hours.' },
  { id: 'sleep_is_optional', emoji: '🌙', name: 'Sleep Is Optional', description: 'Play a single session lasting 8+ hours.' },
  { id: 'what_day_is_it', emoji: '🌅', name: 'What Day Is It?', description: 'Play a single session lasting 12+ hours.' },

  // Restarts and false starts — rapid stopping and starting.
  { id: 'the_betrayal', emoji: '🗡️', name: 'The Betrayal', description: 'Quit a game within 1 minute of starting it, then go straight into another.' },
  { id: 'surely_not', emoji: '🙃', name: "I Can't Stop Playing", description: 'Play the same game 3 times in one day, at least 1 hour each time.' },
  { id: 'technical_difficulties', emoji: '🔌', name: 'Technical Difficulties', description: 'Start the same game 5+ times within 10 minutes.' },

  // Absence and return — time away, and coming back.
  { id: 'touch_grass', emoji: '🌱', name: 'Touch Grass', description: 'Earn a rank, then go 14 days without playing anything tracked.' },
  { id: 'welcome_back', emoji: '🎬', name: 'Welcome Back', description: 'Earn a rank, then return to play after 14+ days away.' },
  { id: 'back_again', emoji: '👋', name: 'Back Again', description: 'Return to a game after 60+ days away.' },
  { id: 'the_return', emoji: '🔄', name: 'The Return', description: 'Return to a game after 180+ days away.' },
  { id: 'forgotten_game', emoji: '🏺', name: 'The Forgotten Game', description: 'Return to a game after 365+ days away.' },

  // Co-op — playing at the same time as other tracked members.
  { id: 'not_alone', emoji: '🤝', name: 'Not Alone', description: 'Play a game while another tracked member is playing it too.' },
  { id: 'herd_mentality', emoji: '🦅', name: 'Herd Mentality', description: 'Start a game within 1 minute of 3+ other members starting it.' },
  { id: 'party_time', emoji: '🎉', name: 'Party Time', description: 'Play a game alongside 4+ other tracked members at once.' },
  { id: 'duo', emoji: '👯', name: 'Duo', description: 'Play the same game alongside the same member on 5 different days.' },
  { id: 'squad_goals', emoji: '🛡️', name: 'Squad Goals', description: 'Play a game alongside 7+ other tracked members at once.' },
  { id: 'the_pack', emoji: '🐺', name: 'The Pack', description: 'Play a game alongside 11+ other tracked members at once.' },

  // Discovery.
  { id: 'trailblazer', emoji: '🧭', name: 'Trailblazer', description: 'Be the first to play a game the server has never seen before.' },
];

const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]));
export const achievementById = (id) => ACHIEVEMENT_BY_ID.get(id);

/** Unlocked rows for a player, excluding any achievement id no longer in the current roster (e.g. after one was retired). */
export function getUnlockedAchievements(db, guildId, userId) {
  return db.getPlayerAchievements(guildId, userId).filter((row) => achievementById(row.achievement_id));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SESSION_LENGTH_TIERS = [
  [3 * HOUR, 'just_one_more_game'],
  [5 * HOUR, 'should_go_to_bed'],
  [8 * HOUR, 'sleep_is_optional'],
  [12 * HOUR, 'what_day_is_it'],
];
const SHORT_SESSION_TIERS = [
  [30_000, 'wrong_game'],
];
const SOCIAL_TIERS = [
  [2, 'not_alone'],
  [5, 'party_time'],
  [8, 'squad_goals'],
  [12, 'the_pack'],
];
const WHALE_HOURS_SECONDS = 120 * 3600;
const QUALIFYING_SESSION_SECONDS = 3600;
const BETRAYAL_MAX_SECONDS = 60;
const BETRAYAL_GRACE_MS = 2 * MINUTE;
export const DUO_DAYS_NEEDED = 5;

function dayStartUTC(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function currentStreak(dates) {
  if (!dates.length) return 0;
  let streak = 1;
  let cursor = new Date(`${dates[0]}T00:00:00Z`);
  for (let i = 1; i < dates.length; i++) {
    cursor = new Date(cursor.getTime() - DAY);
    if (dates[i] !== cursor.toISOString().slice(0, 10)) break;
    streak++;
  }
  return streak;
}

function tryUnlock(db, guildId, userId, achievementId, now, unlocked) {
  if (db.unlockAchievement(guildId, userId, achievementId, now)) unlocked.push(achievementId);
}

/** Call right after a member starts a new game session (session actually changed). */
export function evaluateSessionStart(db, guildId, userId, gameName, now) {
  const unlocked = [];
  const dayStart = dayStartUTC(now);

  const distinctGames = db.getDistinctGameCount(guildId, userId);

  // Fires on the first session the bot observes, not the member's first ever. Members who were
  // being tracked before achievements shipped have playtime but no unlock row, and gating this on
  // an empty history would mean they could never earn it.
  tryUnlock(db, guildId, userId, 'first_steps', now, unlocked);

  if (distinctGames >= 10) tryUnlock(db, guildId, userId, 'collector', now, unlocked);
  if (distinctGames >= 25) tryUnlock(db, guildId, userId, 'game_hoarder', now, unlocked);
  if (distinctGames >= 50) tryUnlock(db, guildId, userId, 'the_backlog', now, unlocked);
  if (distinctGames >= 75) tryUnlock(db, guildId, userId, 'send_help', now, unlocked);

  const gamesToday = db.getGamesTouchedSince(guildId, userId, dayStart);
  if (gamesToday >= 3) tryUnlock(db, guildId, userId, 'variety_is_overrated', now, unlocked);
  if (gamesToday >= 6) tryUnlock(db, guildId, userId, 'identity_crisis', now, unlocked);

  // Loyalty to one game is deliberately set above the equivalent any-game milestone (7 days for
  // Regular, 30 for Dedicated) so a member who only ever plays one game doesn't trip both at once.
  const daysForGame = db.getDistinctDaysForGame(guildId, userId, gameName);
  if (daysForGame >= 45) tryUnlock(db, guildId, userId, 'cant_let_go', now, unlocked);
  if (daysForGame >= 90) tryUnlock(db, guildId, userId, 'one_true_game', now, unlocked);

  const lastEnded = db.getLastSessionEndForGame(guildId, userId, gameName);
  if (lastEnded != null) {
    const gapDays = (now - lastEnded) / DAY;
    if (gapDays >= 60) tryUnlock(db, guildId, userId, 'back_again', now, unlocked);
    if (gapDays >= 180) tryUnlock(db, guildId, userId, 'the_return', now, unlocked);
    if (gapDays >= 365) tryUnlock(db, guildId, userId, 'forgotten_game', now, unlocked);
  }

  if (db.getQualifyingSessionCountToday(guildId, userId, gameName, dayStart, QUALIFYING_SESSION_SECONDS) >= 3) {
    tryUnlock(db, guildId, userId, 'surely_not', now, unlocked);
  }
  if (db.getGameStartCountSince(guildId, userId, gameName, now - 10 * MINUTE) >= 5) {
    tryUnlock(db, guildId, userId, 'technical_difficulties', now, unlocked);
  }
  if (db.getGamesTouchedSince(guildId, userId, now - 3 * HOUR) >= 5) {
    tryUnlock(db, guildId, userId, 'speedrunner', now, unlocked);
  }
  // Closing a game and opening another usually reaches us as two separate presence updates with
  // "playing nothing" in between, so the swap is rarely visible as one event — check the last
  // finished session instead, which covers a direct switch and a quit-then-relaunch alike.
  const abandoned = db.getLastCompletedSession(guildId, userId);
  if (abandoned && abandoned.game_name !== gameName
    && abandoned.duration_seconds < BETRAYAL_MAX_SECONDS
    && now - abandoned.ended_at <= BETRAYAL_GRACE_MS) {
    tryUnlock(db, guildId, userId, 'the_betrayal', now, unlocked);
  }

  const daysAny = db.getDistinctDaysAnyGame(guildId, userId);
  if (daysAny >= 60) tryUnlock(db, guildId, userId, 'regular', now, unlocked);
  if (daysAny >= 180) tryUnlock(db, guildId, userId, 'dedicated', now, unlocked);
  if (daysAny >= 360) tryUnlock(db, guildId, userId, 'legend', now, unlocked);

  // A streak of N is also N distinct days, so these must avoid every attendance and loyalty
  // threshold or they'd fire together — see the ladder documented above ACHIEVEMENTS.
  const streak = currentStreak(db.getPlayDates(guildId, userId));
  if (streak >= 14) tryUnlock(db, guildId, userId, 'no_days_off', now, unlocked);
  if (streak >= 30) tryUnlock(db, guildId, userId, 'habit', now, unlocked);

  const recentOthers = db.getActiveUsersForGame(guildId, gameName)
    .filter((entry) => entry.user_id !== userId && entry.started_at >= now - MINUTE);
  if (recentOthers.length >= 3) tryUnlock(db, guildId, userId, 'herd_mentality', now, unlocked);

  if (!db.hasGameBeenPlayedBefore(guildId, gameName, userId)) {
    tryUnlock(db, guildId, userId, 'trailblazer', now, unlocked);
  }

  // Same gate as Touch Grass, for the same reason: coming back only means something if the member
  // had established themselves first. The session starting right now has not banked time yet, so
  // this reads their history, not this visit.
  const lastEndAny = db.getLastSessionEndAny(guildId, userId);
  if (lastEndAny != null && now - lastEndAny >= 14 * DAY
    && rankForSeconds(db.getTotalSeconds(guildId, userId)) >= 0) {
    tryUnlock(db, guildId, userId, 'welcome_back', now, unlocked);
  }

  if (db.getGameStatsTotal(guildId, userId, gameName) >= WHALE_HOURS_SECONDS) {
    tryUnlock(db, guildId, userId, 'the_whale', now, unlocked);
  }

  return unlocked;
}

/** Call after any session start, for every member currently playing that game (thresholds can trip for everyone at once). */
export function evaluateSocialTiers(db, guildId, gameName, now) {
  const players = db.getActiveUsersForGame(guildId, gameName);
  const total = players.length;
  const results = [];
  for (const player of players) {
    const unlocked = [];
    for (const [count, achievementId] of SOCIAL_TIERS) {
      if (total >= count) tryUnlock(db, guildId, player.user_id, achievementId, now, unlocked);
    }
    if (unlocked.length) results.push({ userId: player.user_id, unlocked });
  }
  return results;
}

/** Call after any session start, for every pair of members currently sharing that game, to track recurring duos. */
export function evaluateDuoDays(db, guildId, gameName, now) {
  const players = db.getActiveUsersForGame(guildId, gameName);
  const day = dayKey(now);
  const results = new Map();
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const [userIdA, userIdB] = [players[i].user_id, players[j].user_id].sort();
      db.recordDuoDay(guildId, userIdA, userIdB, day);
      if (db.getDuoDayCount(guildId, userIdA, userIdB) < DUO_DAYS_NEEDED) continue;
      for (const userId of [userIdA, userIdB]) {
        const unlocked = [];
        tryUnlock(db, guildId, userId, 'duo', now, unlocked);
        if (unlocked.length) results.set(userId, [...(results.get(userId) ?? []), ...unlocked]);
      }
    }
  }
  return [...results.entries()].map(([userId, unlocked]) => ({ userId, unlocked }));
}

/** Call when a session ends (its final duration is known), whether stopped or switched away from. */
export function evaluateSessionEnd(db, guildId, userId, completedSession, now) {
  const unlocked = [];
  const durationMs = completedSession.durationSeconds * 1000;
  for (const [threshold, achievementId] of SESSION_LENGTH_TIERS) {
    if (durationMs >= threshold) tryUnlock(db, guildId, userId, achievementId, now, unlocked);
  }
  for (const [threshold, achievementId] of SHORT_SESSION_TIERS) {
    if (durationMs < threshold) tryUnlock(db, guildId, userId, achievementId, now, unlocked);
  }
  // One above Variety Is Overrated's 3 games, which every qualifying day would otherwise satisfy too.
  if (db.getShortGameCountToday(guildId, userId, dayStartUTC(now), 600) >= 4) {
    tryUnlock(db, guildId, userId, 'speed_dating', now, unlocked);
  }
  if (db.getGameStatsTotal(guildId, userId, completedSession.gameName) >= WHALE_HOURS_SECONDS) {
    tryUnlock(db, guildId, userId, 'the_whale', now, unlocked);
  }
  if (completedSession.durationSeconds >= QUALIFYING_SESSION_SECONDS) {
    const qualifying = db.getQualifyingSessionCountToday(guildId, userId, completedSession.gameName, dayStartUTC(now), QUALIFYING_SESSION_SECONDS);
    if (qualifying >= 3) tryUnlock(db, guildId, userId, 'surely_not', now, unlocked);
  }
  return unlocked;
}

/** Call periodically (e.g. every checkpoint tick) for a still-ongoing session, so long-session/hour-milestone achievements fire while playing, not just at the end. */
export function evaluateOngoingSession(db, guildId, userId, gameName, startedAt, now) {
  const unlocked = [];
  const elapsedMs = now - startedAt;
  for (const [threshold, achievementId] of SESSION_LENGTH_TIERS) {
    if (elapsedMs >= threshold) tryUnlock(db, guildId, userId, achievementId, now, unlocked);
  }
  const totalForGame = db.getGameStatsTotal(guildId, userId, gameName) + Math.floor(elapsedMs / 1000);
  if (totalForGame >= WHALE_HOURS_SECONDS) tryUnlock(db, guildId, userId, 'the_whale', now, unlocked);
  if (elapsedMs >= QUALIFYING_SESSION_SECONDS * 1000) {
    // The still-running session just crossed the 1-hour mark itself — count it alongside any
    // earlier qualifying sessions today, so this can be the 3rd one without having to end first.
    const priorQualifying = db.getQualifyingSessionCountToday(guildId, userId, gameName, dayStartUTC(now), QUALIFYING_SESSION_SECONDS);
    if (priorQualifying + 1 >= 3) tryUnlock(db, guildId, userId, 'surely_not', now, unlocked);
  }
  return unlocked;
}

/**
 * Call periodically (e.g. every few hours) to catch members who have gone quiet.
 *
 * Only members who have earned at least the first rank are eligible: going quiet is only a story
 * worth telling about someone who was actually here. Without this, anyone who opened one game once
 * and never came back would collect it a fortnight later.
 */
export function evaluateTouchGrass(db, guildId, now, cutoffDays = 14) {
  const inactive = db.getInactivePlayers(guildId, now - cutoffDays * DAY);
  const results = [];
  for (const { user_id: userId } of inactive) {
    if (rankForSeconds(db.getTotalSeconds(guildId, userId)) < 0) continue;
    const unlocked = [];
    tryUnlock(db, guildId, userId, 'touch_grass', now, unlocked);
    if (unlocked.length) results.push({ userId, unlocked });
  }
  return results;
}
