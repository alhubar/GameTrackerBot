import { db } from '../runtime.js';
import { formatPlayTime } from '../ranks.js';
import { SERVER_ACHIEVEMENTS, serverAchievementById, getUnlockedServerAchievements } from '../serverAchievements.js';
import { buildServerProfileParts, buildHallOfFameLines, splitDiscordMessage } from '../ui.js';
import { buildServerRecords, recordsAsLines } from '../records.js';

export async function handleServer(interaction) {
  const { profile, topGames, topPlayers } = await buildServerProfileParts(interaction.guild);
  const serverAchievements = getUnlockedServerAchievements(db, interaction.guild.id);
  const achievementLines = serverAchievements.length
    ? serverAchievements.map((row) => {
        const a = serverAchievementById(row.achievement_id);
        return `└ ${a.emoji} **${a.name}** — ${a.description}`;
      })
    : ['└ None yet — keep growing!'];
  const records = await buildServerRecords(interaction.guild);
  const hallOfFame = await buildHallOfFameLines(interaction.guild);
  const text = [
    '🏰 **Server Gaming Statistics**',
    '',
    `⏱️ **Total gaming time:** ${formatPlayTime(profile.totalSeconds)}`,
    '',
    '🏆 **Most played games**',
    ...topGames,
    '',
    '🔥 **Most active players**',
    ...topPlayers,
    // No section header: each record carries its own, and /server already says what it is.
    // Skipped whole when nothing is set, so no stray blank line is left behind.
    ...(records.length ? ['', ...recordsAsLines(records)] : []),
    // Skipped whole until the first badge has been handed out, for the same reason as the
    // records above: a heading over nothing reads as something broken.
    ...(hallOfFame ? ['', '🎖️ **Hall of Fame**', ...hallOfFame] : []),
    '',
    `🏆 **Server achievements (${serverAchievements.length}/${SERVER_ACHIEVEMENTS.length})**`,
    ...achievementLines,
  ].join('\n');
  const [firstChunk, ...restChunks] = splitDiscordMessage(text);
  await interaction.reply(firstChunk);
  for (const chunk of restChunks) await interaction.followUp(chunk);
}
