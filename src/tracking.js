import { ActivityType } from 'discord.js';
import { db } from './runtime.js';
import { memberRef } from './log.js';
import { DEFAULT_ROLE_COLORS, LEVEL_UP_CHANNEL, PAUSE_ON_IDLE } from './config.js';
import { findTextChannel } from './ui.js';
import { RANKS, RANK_HOURS, formatHours, levelUpMessageTemplate, rankForSeconds, roleName } from './ranks.js';
import {
  evaluateSessionStart, evaluateSessionEnd, evaluateSocialTiers, evaluateDuoDays,
} from './achievements.js';
import { announceAchievements, checkServerAchievements } from './announce.js';

/**
 * Presence in, sessions and roles out — the heart of the bot.
 *
 * `updateActivity` is the single place that starts/stops sessions, evaluates achievements and
 * reconciles rank roles. The 60-second checkpoint loop in index.js re-derives the same state for
 * sessions Discord has stopped sending events about; it does not duplicate the logic here.
 */

/**
 * Liveness counters for `/health`. Presence events are the bot's only real input, so "when did the
 * last one arrive" is the difference between a quiet server and Discord having stopped talking
 * to us — a distinction nothing else in the bot surfaces.
 */
export const trackerState = {
  startedAt: Date.now(),
  lastPresenceUpdateAt: null,
  lastCheckpointAt: null,
  presenceUpdates: 0,
};

export function playingGame(presence) {
  return presence?.activities.find((activity) => activity.type === ActivityType.Playing)?.name ?? null;
}

export async function syncRank(member) {
  if (member.user.bot) return;
  const total = db.getTotalSeconds(member.guild.id, member.id);
  const rankIndex = rankForSeconds(total);
  const rankRoles = db.getRankRoles(member.guild.id);
  const trackedRoleIds = new Set(rankRoles.map((entry) => entry.role_id));
  const targetId = rankRoles.find((entry) => entry.rank_index === rankIndex)?.role_id;
  const target = targetId ? member.guild.roles.cache.get(targetId) : (rankIndex >= 0 ? member.guild.roles.cache.find((role) => role.name === roleName(RANKS[rankIndex])) : null);
  const roles = member.guild.roles.cache.filter((role) => trackedRoleIds.has(role.id));
  const remove = roles.filter((role) => role.id !== target?.id && member.roles.cache.has(role.id));
  if (remove.size) await member.roles.remove(remove, 'Game tracker rank changed');
  if (!target) return roles.size > 0; // No rank below the first configured threshold.
  if (!member.roles.cache.has(target.id)) await member.roles.add(target, 'Game tracker rank changed');
  return true;
}

export async function announceRankUp(member, oldRank) {
  const seconds = db.getTotalSeconds(member.guild.id, member.id);
  const newRank = rankForSeconds(seconds);
  if (newRank <= oldRank) return;

  // LEVEL_UP_CHANNEL wins when set, so rank-ups can be moved without re-running /setup somewhere
  // else. Without it, they keep going wherever /setup was last run, as before.
  const channelId = db.getNotificationChannel(member.guild.id);
  const channel = LEVEL_UP_CHANNEL
    ? findTextChannel(member.guild, LEVEL_UP_CHANNEL)
    : (channelId ? member.guild.channels.cache.get(channelId) : null);
  if (!channel?.isTextBased()) return;

  const message = levelUpMessageTemplate(newRank)
    .replaceAll('{user}', `${member}`)
    .replaceAll('{level}', newRank + 1)
    .replaceAll('{rank}', RANKS[newRank])
    .replaceAll('{hours}', formatHours(RANK_HOURS[newRank]));
  await channel.send(message);
}

export async function reconcileRank(member, oldRank) {
  const roleWasSynced = await syncRank(member);
  if (roleWasSynced) await announceRankUp(member, oldRank);
}

export async function updateActivity(member, presence) {
  if (member.user.bot) return;
  trackerState.lastPresenceUpdateAt = Date.now();
  trackerState.presenceUpdates += 1;
  const oldRank = rankForSeconds(db.getTotalSeconds(member.guild.id, member.id));
  const game = playingGame(presence);
  const now = Date.now();

  if (game) {
    const { changed, previous } = db.startSession(member.guild.id, member.id, game, now);
    // Discord reports "idle" after about ten minutes without input while still naming the game.
    // Stop the clock on it and restart only once the member is genuinely back at the keyboard.
    // A status flip carries no `changed`, so this has to run outside that branch.
    const idleChanged = PAUSE_ON_IDLE && presence?.status === 'idle'
      ? db.pauseSession(member.guild.id, member.id, now)
      : db.resumeSession(member.guild.id, member.id, now);
    if (changed) {
      if (previous) {
        await announceAchievements(member, evaluateSessionEnd(db, member.guild.id, member.id, previous, now));
      }
      await announceAchievements(member, evaluateSessionStart(db, member.guild.id, member.id, game, now));

      for (const { userId, unlocked } of evaluateSocialTiers(db, member.guild.id, game, now)) {
        const target = userId === member.id ? member : await member.guild.members.fetch(userId).catch(() => null);
        if (target) await announceAchievements(target, unlocked);
      }
      for (const { userId, unlocked } of evaluateDuoDays(db, member.guild.id, game, now)) {
        const target = userId === member.id ? member : await member.guild.members.fetch(userId).catch(() => null);
        if (target) await announceAchievements(target, unlocked);
      }
    }
    if (!changed && !idleChanged) {
      // A presence event that touched neither the game nor the idle state (a custom status edit,
      // a Spotify update, mobile to desktop) banked no time, so no rank or server milestone can
      // have moved. Reconciling the rank is still cheap and repairs a manually removed role; the
      // server-achievement sweep is not, and the 60s tick runs it for every guild anyway.
      await reconcileRank(member, oldRank);
      return;
    }
  } else {
    const previous = db.stopSession(member.guild.id, member.id, now);
    if (!previous) {
      // Not playing now and was not playing before — the overwhelming majority of presence events
      // on a busy server. Same reasoning as above: nothing banked, nothing to sweep for.
      await reconcileRank(member, oldRank);
      return;
    }
    await announceAchievements(member, evaluateSessionEnd(db, member.guild.id, member.id, previous, now));
  }
  await reconcileRank(member, oldRank);
  await checkServerAchievements(member.guild).catch(console.error);
}

export async function setupRoles(guild) {
  const savedRoles = new Map(db.getRankRoles(guild.id).map((entry) => [entry.rank_index, entry.role_id]));
  const legacyRoles = [...guild.roles.cache.values()]
    .filter((role) => role.name.startsWith('Game Tracker | ') && ![...savedRoles.values()].includes(role.id))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  for (const [index, rank] of RANKS.entries()) {
    const name = roleName(rank);
    let role = guild.roles.cache.get(savedRoles.get(index));
    role ??= guild.roles.cache.find((candidate) => candidate.name === name);
    role ??= legacyRoles.shift();
    if (role) {
      if (role.name !== name) await role.setName(name, 'Game tracker rank configuration changed');
    } else {
      role = await guild.roles.create({
        name,
        color: DEFAULT_ROLE_COLORS[index % DEFAULT_ROLE_COLORS.length],
        reason: `Game tracker rank ${index + 1}`,
      });
    }
    db.saveRankRole(guild.id, index, role.id);
  }
}

export async function syncGuildRanks(guild) {
  await guild.members.fetch();
  for (const member of guild.members.cache.values()) {
    await syncRank(member).catch((error) => console.error(`Could not sync rank for ${memberRef(member.id)}:`, error));
  }
}
