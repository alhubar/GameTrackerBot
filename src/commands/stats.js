import { buildCardEmbed, buildCardComponents } from '../interactions/cards.js';

export async function handleStats(interaction) {
  const user = interaction.options.getUser('member') ?? interaction.user;
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const { embed, page, totalPages } = await buildCardEmbed('stats', interaction.guild, member, user);
  await interaction.reply({
    embeds: [embed],
    components: buildCardComponents('stats', user.id, interaction.user.id, page, totalPages),
  });
}
