import { db, client } from './runtime.js';
import { findTextChannel } from './ui.js';
import {
  ACHIEVEMENT_ANNOUNCEMENTS, ACHIEVEMENT_CHANNEL, RECAP_CHANNEL, RECAP_PERIOD,
  RECAP_MIN_SECONDS, RECAP_WINNER_ROLE, RECAP_WINNER_ROLE_ICON,
} from './config.js';
import { achievementById } from './achievements.js';
import { evaluateServerAchievements } from './serverAchievements.js';
import { buildAchievementEmbed, buildServerAchievementEmbed, buildRecapEmbed, buildNoWinnerRecapEmbed } from './embeds.js';
import { buildRecap, isRecapDue, markRecapAnnounced } from './recap.js';
import { awardWinnerRole, clearWinnerRole } from './roles.js';

/** Everything that turns an unlocked achievement or a finished recap into a Discord message. */

export async function announceAchievements(member, achievementIds) {
  if (!ACHIEVEMENT_ANNOUNCEMENTS || !achievementIds?.length || !ACHIEVEMENT_CHANNEL) return;
  const channel = findTextChannel(member.guild, ACHIEVEMENT_CHANNEL);
  if (!channel) return;
  const trackedPlayers = db.getTrackedPlayerCount(member.guild.id);
  for (const id of achievementIds) {
    const achievement = achievementById(id);
    if (!achievement) continue;
    const unlockCount = db.getAchievementUnlockCount(member.guild.id, id);
    const embed = buildAchievementEmbed(achievement, {
      displayName: member.displayName,
      avatarUrl: member.displayAvatarURL(),
      percentOfPlayers: trackedPlayers ? Math.max(1, Math.round((unlockCount / trackedPlayers) * 100)) : 100,
    });
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] })
      .catch((error) => console.error('Could not announce achievement:', error));
  }
}

export async function announceServerAchievements(guild, unlockedTiers) {
  if (!ACHIEVEMENT_ANNOUNCEMENTS || !unlockedTiers?.length || !ACHIEVEMENT_CHANNEL) return;
  const channel = findTextChannel(guild, ACHIEVEMENT_CHANNEL);
  if (!channel) return;
  for (const tier of unlockedTiers) {
    const embed = buildServerAchievementEmbed(tier, guild.iconURL() ?? null);
    await channel.send({ embeds: [embed] }).catch((error) => console.error('Could not announce server achievement:', error));
  }
}

export async function checkServerAchievements(guild) {
  const { unlocked } = evaluateServerAchievements(db, guild.id);
  await announceServerAchievements(guild, unlocked);
}

/**
 * Posts the last completed period's recap once, on the first check after it ends. The period key is
 * recorded either way, so a quiet week is not retried forever and a restart cannot double-post.
 */
export async function announceRecap(guild, now = Date.now(), { force = false } = {}) {
  if (!force && !isRecapDue(db, guild.id, now, RECAP_PERIOD)) return null;
  const recap = buildRecap(db, guild.id, now, { period: RECAP_PERIOD, minSeconds: RECAP_MIN_SECONDS });
  const channel = findTextChannel(guild, RECAP_CHANNEL || ACHIEVEMENT_CHANNEL);

  if (!recap.winner) {
    // Nobody cleared the bar, so the badge comes off whoever held it and the period is announced
    // as unclaimed rather than passed over in silence.
    await clearWinnerRole(guild, RECAP_WINNER_ROLE).catch((error) =>
      console.error('Could not clear the winner role:', error));
    if (channel) {
      const embed = buildNoWinnerRecapEmbed(recap, {
        botAvatarUrl: client.user?.displayAvatarURL() ?? null,
        roleName: RECAP_WINNER_ROLE || null,
      });
      await channel.send({ embeds: [embed] })
        .catch((error) => console.error('Could not post the recap:', error));
    }
    markRecapAnnounced(db, guild.id, now, RECAP_PERIOD);
    return recap;
  }

  const role = await awardWinnerRole(guild, recap.winner.userId, {
    roleName: RECAP_WINNER_ROLE,
    roleIcon: RECAP_WINNER_ROLE_ICON,
  });

  if (channel) {
    const displayNames = new Map();
    for (const entry of recap.podium) {
      const member = await guild.members.fetch(entry.userId).catch(() => null);
      if (member) displayNames.set(entry.userId, member.displayName);
    }
    const winnerMember = await guild.members.fetch(recap.winner.userId).catch(() => null);
    const embed = buildRecapEmbed(recap, {
      displayNames,
      avatarUrl: winnerMember?.displayAvatarURL() ?? null,
      roleName: role?.name ?? null,
    });
    await channel.send({ content: `<@${recap.winner.userId}>`, embeds: [embed] })
      .catch((error) => console.error('Could not post the recap:', error));
  }
  markRecapAnnounced(db, guild.id, now, RECAP_PERIOD);
  return recap;
}
