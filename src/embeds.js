import { EmbedBuilder } from 'discord.js';
import { formatPlayTime } from './ranks.js';
import { achievementById } from './achievements.js';
import { WINNER_ROLE_COLOR } from './roles.js';

export const ACHIEVEMENT_GOLD = 0xF1C40F;
/** Muted grey for the weeks nobody earned the title — a non-event should not look like a triumph. */
const RECAP_EMPTY_GREY = 0x99AAB5;
/** The badges' own card. Not the winner's colour: it sits directly beneath that card, and
 *  matching it would read as one long celebration of one person. */
const SOCIAL_BADGE_BLUE = 0x5865F2;
/** How many cave dwellers to name before falling back to "and N more". */
const CAVE_DWELLERS_NAMED = 8;
/** How many of the podium to name under the winner. Two, because the field sits beside two others
 *  on one inline row and a taller one would leave them stranded against its whitespace. */
const RECAP_RUNNERS_UP = 2;

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

/** 1st, 2nd, 3rd, 4th… with the 11th–13th exceptions English needs and the naive rule gets wrong. */
export function ordinal(n) {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * The end-of-period showpiece. `recap` comes from buildRecap; `displayNames` maps user ids to
 * names so this stays free of Discord lookups, and `avatarUrl` is the winner's picture.
 *
 * `winNumber` is which win this is for them, counting every period on record. It is shown only from
 * the second onwards — "1st time taking the title" is what winning already means, and printing it
 * under every first-time winner makes the line read as boilerplate rather than as a run.
 */
export function buildRecapEmbed(recap, { displayNames, avatarUrl, roleName = null, winNumber = 1 }) {
  const { winner, range } = recap;
  const nameOf = (userId) => displayNames.get(userId) ?? 'Unknown member';

  const embed = new EmbedBuilder()
    .setColor(WINNER_ROLE_COLOR)
    .setThumbnail(avatarUrl)
    // No date range: the message's own timestamp already says which week this was.
    .setAuthor({ name: `🏆 ${range.title}` })
    .setTitle(nameOf(winner.userId))
    .setDescription(`**${formatPlayTime(winner.totalSeconds)}** played across **${winner.gamesPlayed}** `
      + `${winner.gamesPlayed === 1 ? 'game' : 'different games'} last ${range.periodNoun}.`
      + (winNumber > 1 ? `

👑 Their **${ordinal(winNumber)} time** taking the title.` : ''));

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

  // The rest of the podium, as a third inline field. Discord lays inline fields three to a row, so
  // this one completes the row the two above start rather than opening a ragged second one — the
  // same geometry that keeps it off the /stats card. Kept to names and times: the card is still
  // about the member who won it, and /leaderboard is there for anyone who wants full standings.
  //
  // Anyone the caller could not name is dropped rather than rendered as the 'Unknown member'
  // fallback, which is what a departed runner-up would otherwise read as. The podium deliberately
  // does not over-fetch, so that shortens the field rather than backfilling — a name the server
  // cannot see is worse than one line where there were two.
  const runnersUp = (recap.podium ?? [])
    .filter((entry) => entry.userId !== winner.userId && displayNames.has(entry.userId))
    .slice(0, RECAP_RUNNERS_UP);
  if (runnersUp.length) {
    embed.addFields({
      name: '🥈 Close behind',
      value: runnersUp
        .map((entry) => `**${nameOf(entry.userId)}** — ${formatPlayTime(entry.totalSeconds)}`)
        .join('\n'),
      inline: true,
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
 * The companion card for the social badges, posted in the same message as the playtime recap.
 *
 * A second embed rather than more fields on the first: that card already carries three, and Discord
 * lays inline fields out three to a row, so folding two more in would wrap them into a ragged second
 * row. As its own card the badges read as their own section, and it is still one post.
 *
 * One row of inline fields, deliberately. A tabbed version of this was built and rejected: buttons
 * on a public announcement edit the *shared* message, so one member clicking a tab changes what
 * everybody else sees. Fine for the `/stats` card, which is gated to whoever ran it; wrong for a
 * post the whole server is reading. A compact row shows every badge at once and needs no clicking.
 *
 * Returns null when there is nothing to show, so the caller can simply omit it.
 *
 * Where a badge was passed over, the reason sits with the badge rather than under the member who
 * was denied it: the question a reader has is "why did the top talker not get this?", and they ask
 * it while looking at the badge, not somebody else's name three lines up.
 */
export function buildSocialBadgesEmbed(awards, {
  displayNames, range, bardRoleName = null, scribeRoleName = null,
  bardFloorMinutes = 0, scribeFloorMinutes = 0,
  caveDwellerRoleName = null, caveDwellerIds = null,
}) {
  const nameOf = (userId) => displayNames.get(userId) ?? 'Unknown member';

  const badges = [
    {
      roleName: bardRoleName,
      emoji: '🎵',
      award: awards.bard,
      label: 'voice',
      floor: bardFloorMinutes,
      describe: (row) => `${formatPlayTime(row.voice_minutes * 60)} in voice`,
      floorText: (floor) => `nobody reached ${formatPlayTime(floor * 60)}`,
    },
    {
      roleName: scribeRoleName,
      emoji: '✍️',
      award: awards.scribe,
      label: 'text',
      floor: scribeFloorMinutes,
      // Rendered as a duration to match the field beside it. Strictly these are a *count* of
      // separate minutes somebody sent a message in rather than one unbroken stretch of typing, so
      // it reads as slightly more continuous than it was — deliberate, because two fields side by
      // side in visibly different units was the worse read.
      describe: (row) => `${formatPlayTime(row.text_minutes * 60)} in chat`,
      floorText: (floor) => `nobody reached ${formatPlayTime(floor * 60)}`,
    },
  ].filter((badge) => badge.roleName);

  const fields = badges.map((badge) => {
    // Whoever led this board without being given it, so a genuine double winner is not written out.
    const led = [...(awards.alsoTopped ?? [])]
      .filter(([userId, boards]) => boards.includes(badge.label) && userId !== badge.award?.user_id)
      .map(([userId]) => `_${nameOf(userId)} led this_`);
    // The floor line only when it is true. A badge left unclaimed because its leader already holds
    // one was reached by somebody — "nobody reached 1h" above their name is false.
    const lines = badge.award
      ? [`**${nameOf(badge.award.user_id)}**`, badge.describe(badge.award)]
      : ['*Unclaimed*', ...(led.length ? [] : [`_${badge.floor ? badge.floorText(badge.floor) : 'nobody qualified'}_`])];
    lines.push(...led);
    return { name: `${badge.emoji} ${badge.roleName}`, value: lines.join('\n'), inline: true };
  });

  // Only when somebody actually holds it. A field saying nobody was absent is a field about
  // nothing, and on a card celebrating what people did it is the one entry that earns its place
  // least. It was briefly always-on while this was a tab strip, where a row that changed width week
  // to week read as a fault — as a plain field there is nothing to keep the shape of.
  //
  // Named rather than counted, but capped: a field value is 1024 characters, and a quiet week on a
  // large server would otherwise drop the whole embed rather than shorten one line.
  const caveField = caveDwellerField(caveDwellerRoleName, caveDwellerIds, nameOf);
  if (caveField) fields.push(caveField);

  if (!fields.length) return null;
  return new EmbedBuilder()
    .setColor(SOCIAL_BADGE_BLUE)
    .setAuthor({ name: '🎖️ Also this week' })
    .addFields(fields)
    .setFooter({ text: `Held until next ${range.periodNoun}'s recap` });
}
/** The Cave Dweller field, or null when the badge is off or nobody new arrived. Shared by the badge
 *  card and the rest card, since the badge keeps running through a rest period. */
function caveDwellerField(roleName, userIds, nameOf) {
  if (!roleName || !userIds?.length) return null;
  const shown = userIds.slice(0, CAVE_DWELLERS_NAMED).map(nameOf);
  const rest = userIds.length - shown.length;
  return {
    name: `🕳️ ${roleName}`,
    value: `**${shown.join('**, **')}**${rest ? ` _and ${rest} more_` : ''}\n_watching from the shadows_`,
    inline: true,
  };
}

/**
 * The card for a rest period: no badges were awarded, on purpose, so every member shows their own
 * rank for a period. Grey like the no-winner card, because nothing was won — but it says why, so
 * a recap with no names in it does not read as the bot having broken.
 *
 * `restPeriods` is BADGE_REST_PERIODS. With one, the period now running is the next one judged, so
 * the card can say so plainly; with more, it does not try to count down.
 */
export function buildRestPeriodEmbed(range, {
  botAvatarUrl = null, restPeriods = 1, displayNames = new Map(),
  caveDwellerRoleName = null, caveDwellerIds = null,
} = {}) {
  const nameOf = (userId) => displayNames.get(userId) ?? 'Unknown member';
  const noun = range.periodNoun;
  const embed = new EmbedBuilder()
    .setColor(RECAP_EMPTY_GREY)
    .setThumbnail(botAvatarUrl)
    .setAuthor({ name: `🏆 ${range.title}` })
    .setTitle(`🛌 Rest ${noun}`)
    .setDescription(`No badges this time — everybody wears their own rank for a ${noun}.\n\n`
      + (restPeriods === 1
        ? `This ${noun} counts again for everyone: the badges are back at next ${noun}'s recap.`
        : 'The badges come back once the rest is over, and the count starts fresh for everyone.'));
  const caveField = caveDwellerField(caveDwellerRoleName, caveDwellerIds, nameOf);
  if (caveField) embed.addFields(caveField);
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
