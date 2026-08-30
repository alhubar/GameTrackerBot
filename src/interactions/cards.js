import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, escapeMarkdown,
} from 'discord.js';
import { db, client } from '../runtime.js';
import {
  CARD_TABS, ACHIEVEMENTS_PAGE_SIZE, CARD_ACCENT_COLOR, DEFAULT_ROLE_COLORS,
} from '../config.js';
import { RANKS, formatPlayTime, rankForSeconds } from '../ranks.js';
import { ACHIEVEMENTS, achievementById, getUnlockedAchievements } from '../achievements.js';
import { SERVER_ACHIEVEMENTS, serverAchievementById, getUnlockedServerAchievements } from '../serverAchievements.js';
import {
  buildLeaderboardLines, buildMonthlyLeaderboardLines, buildServerProfileParts, buildHallOfFameLines,
} from '../ui.js';
import { buildServerRecords, recordsAsFields } from '../records.js';

/**
 * The `/stats` profile card: five tabs behind one message, with paging on the longer ones.
 *
 * All of the card's state rides in the button `customId` (`card:<view>:<target>:<requester>:<page>`)
 * because Discord gives components no other state channel. The embedded `requesterId` is the
 * authorization check — see `handleCardButton`.
 */

export function buildCardComponents(view, targetUserId, requesterId, page = 0, totalPages = 1) {
  const buttons = CARD_TABS.map(({ id, label }) => new ButtonBuilder()
    .setCustomId(`card:${id}:${targetUserId}:${requesterId}:tab`)
    .setLabel(label)
    .setStyle(id === view ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(id === view));
  const rows = [new ActionRowBuilder().addComponents(buttons)];
  if ((view === 'achievements' || view === 'server' || view === 'leaderboard') && totalPages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`card:${view}:${targetUserId}:${requesterId}:${page - 1}`)
        .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`card:${view}:${targetUserId}:${requesterId}:pageinfo`)
        .setLabel(`Page ${page + 1}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`card:${view}:${targetUserId}:${requesterId}:${page + 1}`)
        .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    ));
  }
  return rows;
}

export async function buildCardEmbed(view, guild, member, user, requestedPage = 0) {
  const embed = new EmbedBuilder();
  let page = 0;
  let totalPages = 1;

  if (view === 'leaderboard') {
    totalPages = 2;
    page = Math.min(Math.max(0, requestedPage), totalPages - 1);
    embed.setColor(CARD_ACCENT_COLOR);
    if (page === 0) {
      embed.setTitle('📈 Leaderboard — All-Time').setDescription((await buildLeaderboardLines(db, guild)).join('\n'));
    } else {
      embed.setTitle('📈 Leaderboard — This Month').setDescription((await buildMonthlyLeaderboardLines(db, guild)).join('\n'));
    }
  } else if (view === 'server') {
    const { profile, topGames, topPlayers } = await buildServerProfileParts(db, guild);
    const serverAchievements = getUnlockedServerAchievements(db, guild.id);
    const achievementPages = Math.max(1, Math.ceil(serverAchievements.length / ACHIEVEMENTS_PAGE_SIZE));
    totalPages = 1 + achievementPages;
    page = Math.min(Math.max(0, requestedPage), totalPages - 1);

    embed.setColor(CARD_ACCENT_COLOR);

    if (page === 0) {
      const records = await buildServerRecords(db, guild);
      const hallOfFame = await buildHallOfFameLines(db, guild);
      embed.setTitle('🏰 Server Stats').addFields(
        { name: '⏱️ Total gaming time', value: formatPlayTime(profile.totalSeconds), inline: true },
        { name: '🏆 Most played games', value: topGames.join('\n'), inline: false },
        { name: '🔥 Most active players', value: topPlayers.join('\n'), inline: false },
        // One field per record, so each reads exactly like the sections above it. A single
        // wrapper field would need a name Discord accepts, and even a zero-width space still
        // occupies its own line — which showed up as a blank gap the other sections do not have.
        ...recordsAsFields(records),
        // Omitted until a recap has actually handed something out, so a new server does not
        // carry an empty monument to a week that has not happened yet.
        ...(hallOfFame ? [{ name: '🎖️ Hall of Fame', value: hallOfFame.join('\n'), inline: false }] : []),
        { name: '🏆 Server achievements', value: `${serverAchievements.length}/${SERVER_ACHIEVEMENTS.length}`, inline: false },
      );
    } else {
      const achievementPage = page - 1;
      const pageItems = serverAchievements.slice(achievementPage * ACHIEVEMENTS_PAGE_SIZE, (achievementPage + 1) * ACHIEVEMENTS_PAGE_SIZE);
      const list = pageItems.length
        ? pageItems.map((row) => {
            const achievement = serverAchievementById(row.achievement_id);
            return achievement ? `${achievement.emoji} **${achievement.name}** — ${achievement.description}` : null;
          }).filter(Boolean).join('\n')
        : 'None yet — keep growing!';
      embed.setTitle('🏆 Server Achievements').setDescription(list);
    }
  } else {
    const profileName = escapeMarkdown(member?.displayName ?? user.username);
    const profile = db.getPlayerProfile(guild.id, user.id, Date.now(), view === 'games' ? 10 : 3);
    const rankIndex = rankForSeconds(profile.totalSeconds);
    const rank = RANKS[rankIndex] ?? 'Unranked';
    const level = rankIndex >= 0 ? `Level ${rankIndex + 1} — ${rank}` : 'Level 0 — Unranked';

    embed.setColor(rankIndex >= 0 ? DEFAULT_ROLE_COLORS[rankIndex % DEFAULT_ROLE_COLORS.length] : 0x99AAB5)
      .setAuthor({ name: `${profileName}'s Profile`, iconURL: (member ?? user).displayAvatarURL() });

    if (view === 'games') {
      embed.setTitle('🎮 Games').setDescription(profile.topGames.length
        ? profile.topGames.map((game, index) => `**${index + 1}.** ${escapeMarkdown(game.game_name)} — ${formatPlayTime(game.total_seconds)}`).join('\n')
        : 'No game activity recorded yet.');
    } else if (view === 'achievements') {
      const achievements = getUnlockedAchievements(db, guild.id, user.id);
      totalPages = Math.max(1, Math.ceil(achievements.length / ACHIEVEMENTS_PAGE_SIZE));
      page = Math.min(Math.max(0, requestedPage), totalPages - 1);
      const pageItems = achievements.slice(page * ACHIEVEMENTS_PAGE_SIZE, (page + 1) * ACHIEVEMENTS_PAGE_SIZE);
      const list = pageItems.length
        ? pageItems.map((row) => {
            const achievement = achievementById(row.achievement_id);
            return achievement ? `${achievement.emoji} **${achievement.name}** — ${achievement.description}` : null;
          }).filter(Boolean).join('\n')
        : 'None yet — keep playing!';
      embed.setTitle('🏆 Achievements')
        .setDescription(`**${achievements.length}/${ACHIEVEMENTS.length}** unlocked`)
        .addFields({ name: 'Unlocked', value: list });
    } else {
      const achievements = getUnlockedAchievements(db, guild.id, user.id);
      embed.setTitle('📊 Statistics').addFields(
        { name: '⭐ Rank', value: level, inline: true },
        { name: '⏱️ Total playtime', value: formatPlayTime(profile.totalSeconds), inline: true },
        { name: '🎯 This month', value: formatPlayTime(profile.monthSeconds), inline: true },
        { name: '🔥 Longest session', value: formatPlayTime(profile.longestSeconds), inline: true },
        { name: '🎮 Games played', value: `${profile.gamesPlayed}`, inline: true },
        { name: '🏆 Achievements', value: `${achievements.length}/${ACHIEVEMENTS.length}`, inline: true },
      );
    }
  }
  return { embed, page, totalPages };
}

/**
 * Anyone can be *shown* a card, but only the member who ran `/stats` can drive it. Without this
 * a bystander could page someone else's card out from under them mid-read.
 */
export async function handleCardButton(interaction) {
  const [, view, targetUserId, requesterId, pageStr] = interaction.customId.split(':');
  if (interaction.user.id !== requesterId) {
    await interaction.reply({ content: 'Only the person who ran `/stats` can use these buttons — run it yourself to get your own.', flags: MessageFlags.Ephemeral });
    return;
  }
  const user = await client.users.fetch(targetUserId).catch(() => null);
  if (!user) return;
  const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  const { embed, page, totalPages } = await buildCardEmbed(view, interaction.guild, member, user, parseInt(pageStr, 10) || 0);
  await interaction.update({
    embeds: [embed],
    components: buildCardComponents(view, targetUserId, requesterId, page, totalPages),
  });
}
