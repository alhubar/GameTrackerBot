import { db } from '../runtime.js';
import { buildLeaderboardLines, buildMonthlyLeaderboardLines } from '../ui.js';

export async function handleLeaderboard(interaction) {
  const [allTime, monthly] = await Promise.all([
    buildLeaderboardLines(db, interaction.guild),
    buildMonthlyLeaderboardLines(db, interaction.guild),
  ]);
  await interaction.reply([
    '**All-Time Leaderboard**',
    allTime.join('\n'),
    '',
    '**This Month Best Gamer**',
    monthly.join('\n'),
  ].join('\n'));
}
