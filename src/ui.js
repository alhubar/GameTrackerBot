import { escapeMarkdown } from 'discord.js';
import { db } from './runtime.js';
import { RANKS, formatPlayTime, rankForSeconds } from './ranks.js';

/** Rendering helpers shared by more than one command or card view. */

/** Finds a text channel by name, the way every configured channel in .env is resolved. */
export function findTextChannel(guild, name) {
  if (!name) return null;
  return guild.channels.cache.find((candidate) => candidate.isTextBased() && candidate.name === name) ?? null;
}

export async function leaderboardLines(rows, guild, { showRank = true } = {}) {
  if (!rows.length) return null;
  return Promise.all(rows.map(async (row, index) => {
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    const nickname = member ? escapeMarkdown(member.displayName) : 'Former member';
    const prefix = showRank ? `**${RANKS[rankForSeconds(row.total_seconds)] ?? 'Unranked'}** ` : '';
    return `${index + 1}. ${prefix}${nickname} — **${formatPlayTime(row.total_seconds)}**`;
  }));
}

export async function buildLeaderboardLines(guild) {
  const lines = await leaderboardLines(db.getLeaderboard(guild.id), guild);
  return lines ?? ['No tracked play time yet.'];
}

export async function buildMonthlyLeaderboardLines(guild) {
  const now = Date.now();
  const nowDate = new Date(now);
  const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
  const lines = await leaderboardLines(db.getMonthlyLeaderboard(guild.id, monthStart, now), guild, { showRank: false });
  return lines ?? ['No tracked play time yet this month.'];
}

export async function buildServerProfileParts(guild) {
  const profile = db.getServerProfile(guild.id);
  const medals = ['🥇', '🥈', '🥉'];
  const topGames = profile.topGames.length
    ? profile.topGames.map((game, index) => `└ ${medals[index]} ${escapeMarkdown(game.game_name)} — **${formatPlayTime(game.total_seconds)}**`)
    : ['└ No game activity recorded yet'];
  const topPlayers = profile.topPlayers.length
    ? await Promise.all(profile.topPlayers.map(async (row, index) => {
        const member = await guild.members.fetch(row.user_id).catch(() => null);
        const name = escapeMarkdown(member?.displayName ?? 'Former member');
        return `└ ${medals[index]} ${name} — **${formatPlayTime(row.total_seconds)}**`;
      }))
    : ['└ No player activity recorded yet'];
  return { profile, topGames, topPlayers };
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
