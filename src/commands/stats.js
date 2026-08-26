import { MessageFlags } from 'discord.js';
import { db } from '../runtime.js';
import { buildCardEmbed, buildCardComponents } from '../interactions/cards.js';

export async function handleStats(interaction) {
  const user = interaction.options.getUser('member') ?? interaction.user;
  // Hiding an opted-out member from the rankings but leaving their card open to anyone who types
  // their name would defeat the whole control — /stats replies publicly. They can always see their
  // own, which is their data rather than a ranking.
  if (user.id !== interaction.user.id && db.isOptedOut(interaction.guild.id, user.id)) {
    await interaction.reply({
      content: `${user} is not being tracked and their profile is private.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const { embed, page, totalPages } = await buildCardEmbed('stats', interaction.guild, member, user);
  await interaction.reply({
    embeds: [embed],
    components: buildCardComponents('stats', user.id, interaction.user.id, page, totalPages),
  });
}
