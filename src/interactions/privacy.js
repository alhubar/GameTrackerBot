import { EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../runtime.js';
import { syncRank } from '../tracking.js';

/**
 * The confirm step behind `/privacy forgetme`.
 *
 * `customId` is `privacy:<action>:<userId>`, and that embedded id **is** the authorization check —
 * the same scheme the `/stats` card uses. The reply is ephemeral, so in practice only the owner can
 * see the buttons, but an id is the only state Discord hands back and checking it costs nothing.
 */

export async function handlePrivacyButton(interaction) {
  const [, action, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'These buttons are not yours.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'cancel') {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Cancelled')
        .setDescription('Nothing was deleted. Your data is exactly as it was.')],
      components: [],
    });
    return;
  }

  const stillOptedOut = db.isOptedOut(interaction.guild.id, interaction.user.id);
  const removed = db.purgeMember(interaction.guild.id, interaction.user.id);
  // Their total is now zero, so the rank they held no longer reflects anything on record. Done
  // after the purge so syncRank reads the erased state rather than the old one.
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member) await syncRank(member).catch(console.error);

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🧹 Erased')
      .setDescription([
        'Everything this bot held about you in this server is gone.',
        '',
        `Removed: **${removed.sessions}** sessions, **${removed.games}** games, `
          + `**${removed.achievements}** achievements, **${removed.duoDays}** co-op day records, `
          + `**${removed.eventSignups}** event RSVPs.`,
        '',
        stillOptedOut
          ? 'You remain opted out, so nothing new will be recorded either.'
          : 'You are still opted in, so tracking continues from your next presence update, starting '
            + 'from nothing. Use `/privacy optout` if you would rather not be tracked at all.',
      ].join('\n'))],
    components: [],
  });
}
