import { DEFAULT_RANK_EMOJIS } from '../config.js';
import { RANKS } from '../ranks.js';

export async function handleInfo(interaction) {
  const lines = RANKS.map((rank, index) => {
    const marker = DEFAULT_RANK_EMOJIS[index % DEFAULT_RANK_EMOJIS.length];
    return `${marker} **Level ${index + 1} — ${rank}**`;
  });
  await interaction.reply(`**Game Tracker ranks**\n${lines.join('\n\n')}`);
}
