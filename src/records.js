import { escapeMarkdown } from 'discord.js';
import { db } from './runtime.js';
import { formatPlayTime } from './ranks.js';
import { COUNTS_AS_PLAYED_SECONDS } from './achievements.js';

/**
 * Server records: the single best of each kind, and who currently holds it.
 *
 * Records are deliberately not achievements. An achievement is permanent once unlocked; a record
 * is whoever holds it *right now* and changes hands the moment somebody beats it. That is why they
 * are computed on read rather than stored, and why there is no announcement when one changes.
 *
 * The game-count record uses the same one-hour bar as the collection ladder
 * (`COUNTS_AS_PLAYED_SECONDS`) so "most games" means the same thing here as on a member's own card.
 *
 * Each record is returned as `{ emoji, label, detail }` rather than a finished string, because the
 * two surfaces need different shapes from the same data: on the `/stats` card each record is its
 * own embed field (`emoji + label` as the field name), while `/server` renders it as a bold text
 * heading. Handing back pre-joined lines forced the card to stuff every record into one field under
 * a wrapper heading, which read as an extra blank line the other sections did not have.
 */

/**
 * Game names come from whatever a member's Discord Rich Presence reports, so unlike a nickname they
 * are not length-bounded, and `escapeMarkdown` can nearly double one full of markdown characters.
 *
 * Each record is now its own embed field, so a single detail line has the whole 1024-character
 * budget to itself and only a pathological name could overflow it — but a long one still produces
 * an unreadable line, and Discord rejects the entire embed if any field does overflow, taking the
 * rest of the /server card with it. Clip before escaping, so the limit counts visible characters.
 */
const MAX_NAME_CHARS = 60;
const clip = (text) => (text.length > MAX_NAME_CHARS ? `${text.slice(0, MAX_NAME_CHARS - 1)}…` : text);
const gameName = (name) => escapeMarkdown(clip(name));

async function memberName(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  return escapeMarkdown(clip(member?.displayName ?? 'Former member'));
}

/**
 * Whichever records the server has actually set, omitting the rest, so a quiet server shows a short
 * honest list instead of a column of placeholders.
 *
 * Returns an EMPTY array when nothing is set at all. Callers skip the section entirely in that
 * case rather than printing a placeholder: neither surface labels this block, so a lone
 * "nothing here yet" line would sit under no heading and read as a stray fragment.
 */
export async function buildServerRecords(guild) {
  const records = db.getServerRecords(guild.id, COUNTS_AS_PLAYED_SECONDS);
  const out = [];

  if (records.longestSession?.duration_seconds) {
    const who = await memberName(guild, records.longestSession.user_id);
    const game = gameName(records.longestSession.game_name);
    out.push({
      emoji: '⏱️',
      label: 'Longest session',
      detail: `└ ${who} — **${formatPlayTime(records.longestSession.duration_seconds)}** in ${game}`,
    });
  }
  if (records.topGameByPlayers?.players > 1) {
    const game = gameName(records.topGameByPlayers.game_name);
    out.push({
      emoji: '👥',
      label: 'Largest gaming group',
      detail: `└ ${game} — **${records.topGameByPlayers.players} players**`,
    });
  }
  if (records.topCollector?.games) {
    const who = await memberName(guild, records.topCollector.user_id);
    out.push({
      emoji: '🕹️',
      label: 'Most games by one player',
      detail: `└ ${who} — **${records.topCollector.games}**`,
    });
  }

  return out;
}

/** Embed fields for the /stats card — one per record, the same shape as every other section. */
export const recordsAsFields = (records) =>
  records.map(({ emoji, label, detail }) => ({ name: `${emoji} ${label}`, value: detail, inline: false }));

/** Text lines for the plain /server reply, matching the bold headings around them. */
export const recordsAsLines = (records) =>
  records.flatMap(({ emoji, label, detail }) => [`${emoji} **${label}**`, detail]);
