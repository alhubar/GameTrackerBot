import 'dotenv/config';
import { LONGEST_SESSION_ACHIEVEMENT_MS } from './achievements.js';
import { RECAP_PERIODS } from './recap.js';

/**
 * Every `.env`-derived setting, parsed and validated once at import time.
 *
 * Validation lives here rather than at each use site so a typo in `.env` fails the process on
 * startup with a message naming the variable, instead of silently disabling a feature hours later.
 * Anything that throws below is a misconfiguration the operator has to fix; anything that only
 * warns still leaves a working bot.
 */

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing. Copy .env.example to .env and add your token.');

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// Defaults to data/tracker.sqlite. Point DATABASE_PATH at a throwaway file to try the bot against
// a test server without writing to the real one.
export const DATABASE_PATH = process.env.DATABASE_PATH?.trim() || undefined;
export const GUILD_ID = process.env.GUILD_ID;

export const BACKUP_ENABLED = process.env.BACKUP_ENABLED?.trim().toLowerCase() !== 'false';
export const BACKUP_DIR = process.env.BACKUP_DIR?.trim() || 'data/backups';
export const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? '7');
if (!Number.isInteger(BACKUP_KEEP) || BACKUP_KEEP < 1) {
  throw new Error(`BACKUP_KEEP must be a whole number of at least 1 — got "${process.env.BACKUP_KEEP}".`);
}
// UTC so the nightly copy lands at the same real moment regardless of where the host is, and so a
// daylight-saving change can never skip or duplicate a night.
export const BACKUP_HOUR_UTC = Number(process.env.BACKUP_HOUR_UTC ?? '4');
if (!Number.isInteger(BACKUP_HOUR_UTC) || BACKUP_HOUR_UTC < 0 || BACKUP_HOUR_UTC > 23) {
  throw new Error(`BACKUP_HOUR_UTC must be a whole number from 0 to 23 — got "${process.env.BACKUP_HOUR_UTC}".`);
}

export const DEFAULT_ROLE_COLORS = [
  0xFFFFFF, // white
  0x57F287, // green
  0x3498DB, // blue
  0xFEE75C, // yellow
  0xE67E22, // orange
  0xED4245, // red
  0x9B59B6, // purple
];

export const DEFAULT_RANK_EMOJIS = ['⬜', '🟩', '🟦', '🟨', '🟧', '🟥', '🟪'];

export const ACHIEVEMENT_ANNOUNCEMENTS = process.env.ACHIEVEMENT_ANNOUNCEMENTS?.trim().toLowerCase() !== 'false';
export const ACHIEVEMENT_CHANNEL = process.env.ACHIEVEMENT_CHANNEL?.trim();
export const LEVEL_UP_CHANNEL = process.env.LEVEL_UP_CHANNEL?.trim();

export const RECAP_ENABLED = process.env.RECAP_ENABLED?.trim().toLowerCase() !== 'false';
export const RECAP_CHANNEL = process.env.RECAP_CHANNEL?.trim();
export const RECAP_PERIOD = (process.env.RECAP_PERIOD?.trim().toLowerCase() || 'week');
if (!RECAP_PERIODS.includes(RECAP_PERIOD)) {
  throw new Error(`RECAP_PERIOD must be one of ${RECAP_PERIODS.join(', ')} — got "${RECAP_PERIOD}".`);
}
// Blank disables the badge entirely; the recap is still posted.
export const RECAP_WINNER_ROLE = process.env.RECAP_WINNER_ROLE?.trim() ?? 'Champion of the Realm';
export const RECAP_WINNER_ROLE_ICON = process.env.RECAP_WINNER_ROLE_ICON?.trim();
// Minimum tracked playtime needed to take the title at all, so a stray few minutes on a quiet
// week doesn't crown anyone. 0 means anyone with any tracked play qualifies.
export const RECAP_MIN_HOURS = Number(process.env.RECAP_MIN_HOURS ?? '2');
if (!Number.isFinite(RECAP_MIN_HOURS) || RECAP_MIN_HOURS < 0) {
  throw new Error(`RECAP_MIN_HOURS must be a non-negative number — got "${process.env.RECAP_MIN_HOURS}".`);
}
export const RECAP_MIN_SECONDS = Math.round(RECAP_MIN_HOURS * 3600);

// Social badges: the weekly awards for members who turn up to talk rather than play. False stops
// both new event handlers being registered at all, so nothing is recorded and no badge is awarded.
// Existing rows are left alone — turning it back on resumes where it left off.
export const SOCIAL_ENABLED = process.env.SOCIAL_ENABLED?.trim().toLowerCase() !== 'false';
// Ceiling on how much voice time one member can bank in a single UTC day. The qualification gate
// already refuses to count anyone sitting alone, muted or deafened, but it cannot tell two friends
// talking from two friends who both left the call connected overnight. This bounds that case; it
// is a blast radius, not a correctness mechanism.
export const SOCIAL_VOICE_DAILY_CAP_MINUTES = Number(process.env.SOCIAL_VOICE_DAILY_CAP_MINUTES ?? '240');
if (!Number.isInteger(SOCIAL_VOICE_DAILY_CAP_MINUTES) || SOCIAL_VOICE_DAILY_CAP_MINUTES < 1) {
  throw new Error(`SOCIAL_VOICE_DAILY_CAP_MINUTES must be a whole number of at least 1 — got "${process.env.SOCIAL_VOICE_DAILY_CAP_MINUTES}".`);
}

// The two social badges. A blank name disables that badge without touching the other, and without
// stopping the minutes being recorded — turning a name back on resumes awarding from real history.
export const BARD_ROLE = process.env.BARD_ROLE?.trim() ?? 'Bard';
export const BARD_ROLE_ICON = process.env.BARD_ROLE_ICON?.trim();
export const SCRIBE_ROLE = process.env.SCRIBE_ROLE?.trim() ?? 'Scribe';
export const SCRIBE_ROLE_ICON = process.env.SCRIBE_ROLE_ICON?.trim();

// Each board carries its own floor, because the two units are not comparable: an hour of voice is
// one ordinary call, while an hour of *active typing minutes* is a very heavy week. A leader below
// the floor leaves the badge unclaimed rather than being crowned for a token contribution.
export const BARD_MIN_MINUTES = Number(process.env.BARD_MIN_MINUTES ?? '60');
if (!Number.isInteger(BARD_MIN_MINUTES) || BARD_MIN_MINUTES < 0) {
  throw new Error(`BARD_MIN_MINUTES must be a whole number of 0 or more — got "${process.env.BARD_MIN_MINUTES}".`);
}
export const SCRIBE_MIN_MINUTES = Number(process.env.SCRIBE_MIN_MINUTES ?? '30');
if (!Number.isInteger(SCRIBE_MIN_MINUTES) || SCRIBE_MIN_MINUTES < 0) {
  throw new Error(`SCRIBE_MIN_MINUTES must be a whole number of 0 or more — got "${process.env.SCRIBE_MIN_MINUTES}".`);
}

// Cave Dweller: the one badge nobody wants, for members who did nothing at all last period.
// **Off unless explicitly switched on**, and the only setting here that defaults to off — it is
// the one that can land badly, it reaches only people who were not there to see it, and it rewards
// nobody. Everything else in this section is worth having on by default; this is not.
export const CAVE_DWELLER_ENABLED = process.env.CAVE_DWELLER_ENABLED?.trim().toLowerCase() === 'true';
export const CAVE_DWELLER_ROLE = process.env.CAVE_DWELLER_ROLE?.trim() ?? 'Cave Dweller';
export const CAVE_DWELLER_ROLE_ICON = process.env.CAVE_DWELLER_ROLE_ICON?.trim();
// How long a member must have been in the guild, and tracked, *before the period began* to be
// judged on it. Somebody who joined on Friday has no rows for the week and has earned no joke.
export const CAVE_DWELLER_GRACE_DAYS = Number(process.env.CAVE_DWELLER_GRACE_DAYS ?? '14');
if (!Number.isInteger(CAVE_DWELLER_GRACE_DAYS) || CAVE_DWELLER_GRACE_DAYS < 0) {
  throw new Error(`CAVE_DWELLER_GRACE_DAYS must be a whole number of 0 or more — got "${process.env.CAVE_DWELLER_GRACE_DAYS}".`);
}
export const CAVE_DWELLER_GRACE_MS = CAVE_DWELLER_GRACE_DAYS * 24 * 60 * 60 * 1000;

// Anti-idle tracking. Discord flips a member to "idle" after roughly ten minutes without input but
// keeps reporting whatever game is still open, so a launcher left running overnight would otherwise
// bank a full night of playtime and outrank everyone who actually played.
export const HOUR_MS = 60 * 60 * 1000;
export const PAUSE_ON_IDLE = process.env.PAUSE_ON_IDLE?.trim().toLowerCase() !== 'false';
// Backstop for the case idle never catches: a mouse jiggler, or a client that simply never reports
// idle. Must stay above the longest session-length achievement or that badge becomes unreachable.
export const MAX_SESSION_HOURS = Number(process.env.MAX_SESSION_HOURS ?? '12');
if (!Number.isFinite(MAX_SESSION_HOURS) || MAX_SESSION_HOURS < 0) {
  throw new Error(`MAX_SESSION_HOURS must be a non-negative number — got "${process.env.MAX_SESSION_HOURS}".`);
}
if (MAX_SESSION_HOURS > 0 && MAX_SESSION_HOURS * HOUR_MS <= LONGEST_SESSION_ACHIEVEMENT_MS) {
  console.warn(
    `MAX_SESSION_HOURS is ${MAX_SESSION_HOURS}h, at or below the longest session-length achievement `
    + `(${LONGEST_SESSION_ACHIEVEMENT_MS / HOUR_MS}h). That achievement can no longer be earned.`,
  );
}
export const MAX_SESSION_MS = MAX_SESSION_HOURS > 0 ? MAX_SESSION_HOURS * HOUR_MS : 0;

function parseTimezonePresets(value) {
  const zones = value ? value.split(',').map((zone) => zone.trim()).filter(Boolean) : ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo'];
  if (zones.length > 25) throw new Error('EVENT_TIMEZONE_PRESETS has more than 25 entries — Discord select menus support at most 25 options.');
  return zones.map((zone) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch {
      throw new Error(`EVENT_TIMEZONE_PRESETS zone "${zone}" is not a valid IANA timezone (e.g. Europe/Madrid, America/Chicago, UTC).`);
    }
    return { label: zone.split('/').pop().replace(/_/g, ' '), value: zone };
  });
}
export const EVENT_TIMEZONE_PRESETS = parseTimezonePresets(process.env.EVENT_TIMEZONE_PRESETS?.trim());
export const EVENT_REMINDER_STAGES_MINUTES = (process.env.EVENT_REMINDER_STAGES_MINUTES ?? '720,60,0')
  .split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0)
  .sort((a, b) => b - a);

export const CHANGES_CHANNEL = process.env.CHANGES_CHANNEL?.trim();
export const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY?.trim();
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Shared card chrome. The tab list drives both the button row and the set of views
// `buildCardEmbed` knows how to render, so adding a tab here is most of adding a tab.
export const CARD_TABS = [
  { id: 'stats', label: '📊 Statistics' },
  { id: 'games', label: '🎮 Games' },
  { id: 'achievements', label: '🏆 Achievements' },
  { id: 'leaderboard', label: '📈 Leaderboard' },
  { id: 'server', label: '🏰 Server' },
];
export const ACHIEVEMENTS_PAGE_SIZE = 8;
export const CARD_ACCENT_COLOR = 0x5865F2;
