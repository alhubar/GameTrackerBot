import { buildLeaderboardLines, buildMonthlyLeaderboardLines } from '../ui.js';

export async function handleLeaderboard(interaction) {
  const [allTime, monthly] = await Promise.all([
    buildLeaderboardLines(interaction.guild),
    buildMonthlyLeaderboardLines(interaction.guild),
  ]);
  await interaction.reply([
    '**All-Time Leaderboard**',
    allTime.join('\n'),
    '',
    '**This Month Best Gamer**',
    monthly.join('\n'),
  ].join('\n'));
}
