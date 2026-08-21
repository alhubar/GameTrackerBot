import { EmbedBuilder } from 'discord.js';
import { formatPlayTime } from './ranks.js';
import { achievementById } from './achievements.js';

export const ACHIEVEMENT_GOLD = 0xF1C40F;
/** Muted grey for the weeks nobody earned the title — a non-event should not look like a triumph. */
const RECAP_EMPTY_GREY = 0x99AAB5;
const PODIUM_MEDALS = ['🥇', '🥈', '🥉'];

/** The card posted when a member unlocks a personal achievement. */
export function buildAchievementEmbed(achievement, { displayName, avatarUrl, percentOfPlayers }) {
  return new EmbedBuilder()
    .setColor(ACHIEVEMENT_GOLD)
    .setThumbnail(avatarUrl)
    .setAuthor({ name: `${displayName} unlocked an achievement!` })
    .setTitle(`${achievement.emoji} ${achievement.name}`)
    .setDescription(achievement.description)
    .setFooter({ text: `Only ${percentOfPlayers}% of players have this achievement` });
}

/**
 * The banner posted when the server as a whole crosses a milestone. Kept to just the headline and
 * the celebration line — the running totals live in /server and the stats card, and repeating them
 * here buried the thing actually being celebrated.
 *
 * The thumbnail is the server's own icon, mirroring how a personal unlock shows the member's
 * avatar. A server with no icon set simply renders without one.
 */
export function buildServerAchievementEmbed(tier, guildIconUrl = null) {
  return new EmbedBuilder()
    .setColor(ACHIEVEMENT_GOLD)
    .setThumbnail(guildIconUrl)
    .setAuthor({ name: 'SERVER ACHIEVEMENT UNLOCKED' })
    .setTitle(`${tier.emoji} ${tier.name}`)
    .setDescription(tier.celebration);
}

/**
 * The end-of-period showpiece. `recap` comes from buildRecap; `displayNames` maps user ids to
 * names so this stays free of Discord lookups, and `avatarUrl` is the winner's picture.
 */
export function buildRecapEmbed(recap, { displayNames, avatarUrl, roleName = null }) {
  const { winner, range, podium } = recap;
  const nameOf = (userId) => displayNames.get(userId) ?? 'Unknown member';

  const embed = new EmbedBuilder()
    .setColor(ACHIEVEMENT_GOLD)
    .setThumbnail(avatarUrl)
    // No date range: the message's own timestamp already says which week this was.
    .setAuthor({ name: `🏆 ${range.title}` })
    .setTitle(nameOf(winner.userId))
    .setDescription(`**${formatPlayTime(winner.totalSeconds)}** played across **${winner.gamesPlayed}** `
      + `${winner.gamesPlayed === 1 ? 'game' : 'different games'} last ${range.periodNoun}.`);

  if (winner.topGame) {
    embed.addFields({
      name: '🎮 Most played',
      value: `**${winner.topGame}**\n${formatPlayTime(winner.topGameSeconds)}`,
      inline: true,
    });
  }

  const earned = winner.achievements.map((id) => achievementById(id)).filter(Boolean);
  embed.addFields({
    name: `🏅 Achievements earned (${earned.length})`,
    value: earned.length
      // Long unlock runs would blow past the 1024-character field cap, so show a few and count the rest.
      ? earned.slice(0, 5).map((a) => `${a.emoji} ${a.name}`).join('\n')
        + (earned.length > 5 ? `\n*…and ${earned.length - 5} more*` : '')
      : `*None this ${range.periodNoun}*`,
    inline: true,
  });

  if (podium.length > 1) {
    embed.addFields({
      name: '📊 Runners-up',
      value: podium.slice(1)
        .map((entry, index) => `${PODIUM_MEDALS[index + 1]} ${nameOf(entry.userId)} — ${formatPlayTime(entry.totalSeconds)}`)
        .join('\n'),
      inline: false,
    });
  }

  embed.setFooter({
    text: roleName
      ? `Wears the ${roleName} badge until next ${range.periodNoun}'s recap`
      : `Top of the leaderboard last ${range.periodNoun}`,
  });
  return embed;
}

/**
 * The card for a period nobody earned. Wears the bot's own avatar rather than a member's, since
 * there is no member to show, and stays grey so it never reads as a celebration.
 */
export function buildNoWinnerRecapEmbed(recap, { botAvatarUrl = null, roleName = null }) {
  const { range, minSeconds, podium } = recap;
  const embed = new EmbedBuilder()
    .setColor(RECAP_EMPTY_GREY)
    .setThumbnail(botAvatarUrl)
    .setAuthor({ name: `🏆 ${range.title}` })
    .setTitle('Nobody was worthy')
    .setDescription(minSeconds
      ? `No one managed **${formatPlayTime(minSeconds)}** of tracked play last ${range.periodNoun}, `
        + 'so the title goes unclaimed.'
      : `Nobody played anything tracked last ${range.periodNoun}, so the title goes unclaimed.`);

  // Naming the closest attempt gives the week a nudge without pretending it was a win.
  const best = podium[0];
  if (best) {
    embed.addFields({
      name: '⏱️ Closest attempt',
      value: `${formatPlayTime(best.totalSeconds)} — short of the ${formatPlayTime(minSeconds)} needed`,
      inline: false,
    });
  }

  embed.setFooter({
    text: roleName ? `The ${roleName} badge sits vacant` : `Better luck next ${range.periodNoun}`,
  });
  return embed;
}
