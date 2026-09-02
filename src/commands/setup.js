import { MessageFlags } from 'discord.js';
import { db } from '../runtime.js';
import { RANKS } from '../ranks.js';
import { setupRoles, syncGuildRanks, RankShiftDetected } from '../tracking.js';

export async function handleSetup(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await setupRoles(interaction.guild);
  } catch (error) {
    if (!(error instanceof RankShiftDetected)) throw error;
    await interaction.editReply(error.message);
    return;
  }
  await syncGuildRanks(interaction.guild);
  db.setNotificationChannel(interaction.guild.id, interaction.channelId);
  await interaction.editReply(`The ${RANKS.length} tracker roles are ready and member ranks have been synchronized. Rank-up announcements will be posted in this channel. Ensure the bot role is above them.`);
}
