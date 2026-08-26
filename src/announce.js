import { db, client } from './runtime.js';
import { findTextChannel, presentMemberIds } from './ui.js';
import {
  ACHIEVEMENT_ANNOUNCEMENTS, ACHIEVEMENT_CHANNEL, RECAP_CHANNEL, RECAP_PERIOD,
  RECAP_MIN_SECONDS, RECAP_WINNER_ROLE, RECAP_WINNER_ROLE_ICON,
  SOCIAL_ENABLED, BARD_ROLE, BARD_ROLE_ICON, BARD_MIN_MINUTES,
  SCRIBE_ROLE, SCRIBE_ROLE_ICON, SCRIBE_MIN_MINUTES,
} from './config.js';
import { achievementById } from './achievements.js';
import { evaluateServerAchievements } from './serverAchievements.js';
import {
  buildAchievementEmbed, buildServerAchievementEmbed, buildRecapEmbed, buildNoWinnerRecapEmbed,
  buildSocialBadgesEmbed,
} from './embeds.js';
import { buildRecap, isRecapDue, markRecapAnnounced } from './recap.js';
import { awardSocialBadges } from './socialBadges.js';
import {
  awardWinnerRole, clearWinnerRole, awardBadgeRole, clearBadgeRole,
  BARD_ROLE_COLOR, SCRIBE_ROLE_COLOR,
} from './roles.js';

/**
 * How far down each social board to look. Only the top few can ever hold a badge, but pass-down
 * walks past everyone who already has one, so the list has to be deep enough to have somewhere to
 * go — the same over-fetch the leaderboards do before dropping departed members.
 */
const SOCIAL_CANDIDATES = 25;

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
/**
 * Decides the period's Bard and Scribe, hands their roles over, and returns the card for them —
 * or null when the feature is off, both badges are disabled, or nothing is renderable.
 *
 * Runs whether or not anybody won the playtime title: the boards are independent, and a period
 * where nobody played is exactly the sort where the talkers should still be recognised.
 *
 * The champion is passed in by id only. Nothing here needs their role to exist yet, so this can be
 * settled before the playtime badge is handed over without the two interleaving.
 */
async function settleSocialBadges(guild, recap, championId) {
  if (!SOCIAL_ENABLED || (!BARD_ROLE && !SCRIBE_ROLE)) return null;
  const { range } = recap;
  // Departed members are dropped before the award pass, never after: a post-filter would hand a
  // badge to somebody who has left and then quietly show it as unclaimed.
  const present = await presentMemberIds(guild);
  const board = (metric) => {
    const rows = db.getSocialLeaderboard(guild.id, range.start, range.end, metric, SOCIAL_CANDIDATES);
    return present ? rows.filter((row) => present.has(row.user_id)) : rows;
  };

  const awards = awardSocialBadges({
    championId,
    voice: board('voice'),
    text: board('text'),
    voiceFloorMinutes: BARD_MIN_MINUTES,
    textFloorMinutes: SCRIBE_MIN_MINUTES,
  });

  // An unclaimed badge is stripped rather than left on last period's holder — that is what makes
  // "unclaimed" an outcome the recap can honestly report.
  const handOver = async (roleName, roleIcon, color, positionFromTop, award) => {
    if (!roleName) return;
    if (!award) {
      await clearBadgeRole(guild, roleName)
        .catch((error) => console.error(`Could not clear the ${roleName} role:`, error));
      return;
    }
    await awardBadgeRole(guild, award.user_id, {
      roleName, roleIcon, color, positionFromTop,
      reason: `${roleName} — social badge`,
      awardReason: `${roleName} — top of the board last ${range.periodNoun}`,
    }).catch((error) => console.error(`Could not award the ${roleName} role:`, error));
  };
  // Champion of the Realm keeps the top slot; these stack beneath it in a fixed order.
  await handOver(BARD_ROLE, BARD_ROLE_ICON, BARD_ROLE_COLOR, 2, awards.bard);
  await handOver(SCRIBE_ROLE, SCRIBE_ROLE_ICON, SCRIBE_ROLE_COLOR, 3, awards.scribe);

  const mentioned = new Set([awards.bard?.user_id, awards.scribe?.user_id, ...awards.alsoTopped.keys()]);
  const displayNames = new Map();
  for (const userId of mentioned) {
    if (!userId) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) displayNames.set(userId, member.displayName);
  }

  return buildSocialBadgesEmbed(awards, {
    displayNames,
    range,
    bardRoleName: BARD_ROLE || null,
    scribeRoleName: SCRIBE_ROLE || null,
    bardFloorMinutes: BARD_MIN_MINUTES,
    scribeFloorMinutes: SCRIBE_MIN_MINUTES,
  });
}

export async function announceRecap(guild, now = Date.now(), { force = false } = {}) {
  if (!force && !isRecapDue(db, guild.id, now, RECAP_PERIOD)) return null;
  const recap = buildRecap(db, guild.id, now, { period: RECAP_PERIOD, minSeconds: RECAP_MIN_SECONDS });
  const channel = findTextChannel(guild, RECAP_CHANNEL || ACHIEVEMENT_CHANNEL);

  // One post for the whole period. The badges are settled first so that whichever branch below
  // runs, its message carries the same companion card.
  const socialEmbed = await settleSocialBadges(guild, recap, recap.winner?.userId ?? null)
    .catch((error) => {
      console.error('Could not settle the social badges:', error);
      return null;
    });

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
      await channel.send({ embeds: [embed, socialEmbed].filter(Boolean) })
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
    await channel.send({ content: `<@${recap.winner.userId}>`, embeds: [embed, socialEmbed].filter(Boolean) })
      .catch((error) => console.error('Could not post the recap:', error));
  }
  markRecapAnnounced(db, guild.id, now, RECAP_PERIOD);
  return recap;
}
