import { escapeMarkdown } from 'discord.js';
import { RANKS, formatPlayTime, rankForSeconds } from './ranks.js';
import { RECAP_BADGES } from './recap.js';

/**
 * Rendering helpers shared by more than one command or card view.
 *
 * The builders below take `db` as a parameter rather than importing the runtime singleton — the
 * same shape socialTracking.js uses, and for the same reason: importing runtime.js opens the
 * configured database, so a module that does it can never be loaded by a test. Every caller
 * already has the handle.
 */

/** Finds a text channel by name, the way every configured channel in .env is resolved. */
export function findTextChannel(guild, name) {
  if (!name) return null;
  return guild.channels.cache.find((candidate) => candidate.isTextBased() && candidate.name === name) ?? null;
}

/**
 * Members who have left the guild keep every row they ever earned — the bot deletes nothing on
 * departure, so somebody who leaves by accident and rejoins finds their hours, rank and
 * achievements exactly as they were. They are only hidden from the *rankings*, which are about who
 * is here now; rejoining puts them straight back at the position their playtime earns.
 *
 * Because they are filtered after the query, the boards ask for far more rows than they show, so a
 * server with several departed members still fills its ten places instead of quietly shrinking.
 */
const LEADERBOARD_SIZE = 10;
const LEADERBOARD_CANDIDATES = 50;
const TOP_PLAYERS_SIZE = 3;
const TOP_PLAYERS_CANDIDATES = 25;

/**
 * Ids of members still in the guild, or `null` when Discord could not be asked.
 *
 * `null` rather than an empty set matters: an empty set is indistinguishable from "everyone left"
 * and would blank the leaderboard on a transient API failure. Callers treat `null` as "show
 * everyone", which is exactly the behaviour that existed before filtering.
 *
 * One bulk fetch, skipped entirely when the cache already holds the whole guild, so the several
 * calls a single `/stats` card makes cost at most one round trip between them.
 */
export async function presentMemberIds(guild) {
  if (guild.memberCount && guild.members.cache.size >= guild.memberCount) {
    return new Set(guild.members.cache.keys());
  }
  const members = await guild.members.fetch().catch(() => null);
  return members ? new Set(members.keys()) : null;
}

/** Drops departed members, then trims to the number actually displayed. */
function stillHere(rows, present, limit) {
  return (present ? rows.filter((row) => present.has(row.user_id)) : rows).slice(0, limit);
}

export async function leaderboardLines(rows, guild, { showRank = true, limit = LEADERBOARD_SIZE } = {}) {
  if (!rows.length) return null;
  const present = await presentMemberIds(guild);
  const visible = stillHere(rows, present, limit);
  if (!visible.length) return null;
  return visible.map((row, index) => {
    // Only reachable when the fetch above failed and the cache is incomplete.
    const member = guild.members.cache.get(row.user_id);
    const nickname = member ? escapeMarkdown(member.displayName) : 'Former member';
    const prefix = showRank ? `**${RANKS[rankForSeconds(row.total_seconds)] ?? 'Unranked'}** ` : '';
    return `${index + 1}. ${prefix}${nickname} — **${formatPlayTime(row.total_seconds)}**`;
  });
}

export async function buildLeaderboardLines(db, guild) {
  const lines = await leaderboardLines(db.getLeaderboard(guild.id, LEADERBOARD_CANDIDATES), guild);
  return lines ?? ['No tracked play time yet.'];
}

export async function buildMonthlyLeaderboardLines(db, guild) {
  const now = Date.now();
  const nowDate = new Date(now);
  const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
  const rows = db.getMonthlyLeaderboard(guild.id, monthStart, now, LEADERBOARD_CANDIDATES);
  const lines = await leaderboardLines(rows, guild, { showRank: false });
  return lines ?? ['No tracked play time yet this month.'];
}

export async function buildServerProfileParts(db, guild) {
  // Total gaming time deliberately still counts departed members: it is the server's history, not
  // a roster. Only the "most active players" ranking is filtered.
  const profile = db.getServerProfile(guild.id, Date.now(), TOP_PLAYERS_CANDIDATES);
  const present = await presentMemberIds(guild);
  const activePlayers = stillHere(profile.topPlayers, present, TOP_PLAYERS_SIZE);
  const medals = ['🥇', '🥈', '🥉'];
  const topGames = profile.topGames.length
    ? profile.topGames.map((game, index) => `└ ${medals[index]} ${escapeMarkdown(game.game_name)} — **${formatPlayTime(game.total_seconds)}**`)
    : ['└ No game activity recorded yet'];
  const topPlayers = activePlayers.length
    ? activePlayers.map((row, index) => {
        const member = guild.members.cache.get(row.user_id);
        const name = escapeMarkdown(member?.displayName ?? 'Former member');
        return `└ ${medals[index]} ${name} — **${formatPlayTime(row.total_seconds)}**`;
      })
    : ['└ No player activity recorded yet'];
  return { profile, topGames, topPlayers };
}

/** Matches the three-deep medal lists either side of it on /server and the server card. */
const HALL_OF_FAME_SIZE = 3;

/**
 * The members who have taken the most recap badges, or null when none has ever been handed out.
 *
 * Departed winners are deliberately kept. They did win it, and the recap said so with their name at
 * the time — the same call the server records make, and the opposite of the leaderboards, which are
 * about who is here to be ranked today. Opted-out members are filtered in SQL, because that part
 * *is* a ranking of members and every ranking hides them.
 */
export async function buildHallOfFameLines(db, guild, limit = HALL_OF_FAME_SIZE) {
  const rows = db.getHallOfFame(guild.id, limit);
  if (!rows.length) return null;
  // Called for the cache it warms, not the ids it returns: names have to resolve for members this
  // card does not filter on.
  await presentMemberIds(guild);
  const medals = ['🥇', '🥈', '🥉'];
  return rows.map((row, index) => {
    const member = guild.members.cache.get(row.user_id);
    const name = escapeMarkdown(member?.displayName ?? 'Former member');
    const breakdown = RECAP_BADGES.filter((badge) => row[badge.key])
      .map((badge) => `${badge.emoji}${row[badge.key]}`).join(' ');
    return `└ ${medals[index]} ${name} — **${row.wins}** ${row.wins === 1 ? 'badge' : 'badges'} · ${breakdown}`;
  });
}

export function splitDiscordMessage(content, maxLength = 2000) {
  const chunks = [];
  let remaining = content;
  while (remaining.length > maxLength) {
    const boundary = Math.max(remaining.lastIndexOf('\n', maxLength), remaining.lastIndexOf(' ', maxLength));
    const cutAt = boundary > 0 ? boundary : maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
