import { EmbedBuilder } from 'discord.js';
import { formatPlayTime } from './ranks.js';
import { achievementById } from './achievements.js';

export const ACHIEVEMENT_GOLD = 0xF1C40F;
/** Muted grey for the weeks nobody earned the title — a non-event should not look like a triumph. */
const RECAP_EMPTY_GREY = 0x99AAB5;
/** The social badges' own card. Deliberately not the gold the playtime recap uses — it sits
 *  directly beneath that card, and matching it would read as one long celebration of one person. */
const SOCIAL_BADGE_BLUE = 0x5865F2;

/** The card posted when a member unlocks a personal achievement. */
export function buildAchievementEmbed(achievement, { displayName, avatarUrl, percentOfPlayers }) {
  return new EmbedBuilder()
    .setColor(ACHIEVEMENT_GOLD)
    .setThumbnail(avatarUrl)
    .setAuthor({ name: `${displayName} unlocked an achievement!` })
    .setTitle(`${achievement.emoji} ${achievement.name}`)
    .setDescription(achievement.description)
    .setFooter({ text: `${percentOfPlayers}% of players have this achievement` });
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
  const { winner, range } = recap;
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

  // No runners-up: the card is about the member who won it, and a leaderboard underneath their
  // name turns a celebration into a scoreboard — /leaderboard is right there for anyone who wants
  // the standings. buildRecap still returns the podium — the no-winner card names the closest try.

  embed.setFooter({
    text: roleName
      ? `Wears the ${roleName} badge until next ${range.periodNoun}'s recap`
      : `Top of the leaderboard last ${range.periodNoun}`,
  });
  return embed;
}

/**
 * The companion card for the social badges, posted in the same message as the playtime recap.
 *
 * A second embed rather than more fields on the first: the playtime card already carries three,
 * and Discord lays inline fields out three to a row, so folding two more in would wrap them into a
 * ragged second row underneath. As a separate card the badges read as their own section, and the
 * whole thing is still one post.
 *
 * Returns null when neither badge is configured, so the caller can simply omit it.
 *
 * Where a badge was passed over, the reason sits with the badge rather than under the member who
 * was denied it. That is the opposite of what the spec first said, and it is better: the question
 * a reader actually has is "why did the top talker not get this?", and it is asked while looking
 * at the badge, not while looking at somebody else's name three lines up.
 */
export function buildSocialBadgesEmbed(awards, {
  displayNames, range, bardRoleName = null, scribeRoleName = null,
  bardFloorMinutes = 0, scribeFloorMinutes = 0,
  caveDwellerRoleName = null, caveDwellerCount = null,
}) {
  const badges = [
    {
      roleName: bardRoleName,
      emoji: '🎵',
      award: awards.bard,
      label: 'voice',
      floor: bardFloorMinutes,
      // Voice time is one continuous stretch, so it reads as a duration.
      describe: (row) => `${formatPlayTime(row.voice_minutes * 60)} in voice`,
      floorText: (floor) => `nobody reached ${formatPlayTime(floor * 60)} in voice`,
    },
    {
      roleName: scribeRoleName,
      emoji: '✍️',
      award: awards.scribe,
      label: 'text',
      floor: scribeFloorMinutes,
      // Text minutes are a count of separate minutes somebody was typing in, never one stretch —
      // rendering them as "1h 30m" would claim an hour and a half of continuous typing.
      describe: (row) => `${row.text_minutes} active ${row.text_minutes === 1 ? 'minute' : 'minutes'} of chat`,
      floorText: (floor) => `nobody reached ${floor} active minutes of chat`,
    },
  ].filter((badge) => badge.roleName);

  const showCaveDwellers = caveDwellerRoleName && caveDwellerCount !== null;
  if (!badges.length && !showCaveDwellers) return null;

  const nameOf = (userId) => displayNames.get(userId) ?? 'Unknown member';
  const embed = new EmbedBuilder()
    .setColor(SOCIAL_BADGE_BLUE)
    .setAuthor({ name: '🎖️ Also this week' });

  for (const badge of badges) {
    const lines = [];
    if (badge.award) {
      lines.push(`**${nameOf(badge.award.user_id)}**`, badge.describe(badge.award));
    } else {
      lines.push('*Unclaimed*', badge.floor ? `_${badge.floorText(badge.floor)}_` : '_nobody qualified_');
    }
    // Whoever led this board without being given it. Naming them here explains the result exactly
    // where it looks surprising, and keeps a genuine double winner from being written out of it.
    for (const [userId, boards] of awards.alsoTopped ?? []) {
      if (boards.includes(badge.label) && userId !== badge.award?.user_id) {
        lines.push(`_${nameOf(userId)} topped ${badge.label}, but already wears another badge_`);
      }
    }
    embed.addFields({ name: `${badge.emoji} ${badge.roleName}`, value: lines.join('\n'), inline: true });
  }

  // A count, never a list of names. The role is already visible on the members who hold it, and
  // printing a roll-call of everybody who was absent is a different and much sharper thing than
  // quietly colouring their name. An empty week is worth saying out loud, and is good news.
  if (showCaveDwellers) {
    embed.addFields({
      name: `🕳️ ${caveDwellerRoleName}`,
      value: caveDwellerCount
        ? `**${caveDwellerCount}** ${caveDwellerCount === 1 ? 'member' : 'members'}\n_nothing recorded all ${range.periodNoun}_`
        : `_Nobody — everyone turned up this ${range.periodNoun}_`,
      inline: true,
    });
  }

  embed.setFooter({ text: `Held until next ${range.periodNoun}'s recap` });
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
