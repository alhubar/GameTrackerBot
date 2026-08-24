import { ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { db } from '../runtime.js';
import { buildTimezoneSelectRow } from '../interactions/events.js';

export async function handleEventCreate(interaction) {
  await interaction.reply({
    content: 'Which timezone is this event in?',
    components: buildTimezoneSelectRow('event:tzcreate'),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleEventList(interaction) {
  const upcoming = db.getUpcomingEventsForGuild(interaction.guild.id, Date.now(), 10);
  if (!upcoming.length) {
    await interaction.reply({ content: 'No upcoming events. Create one with `/event create`.', flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = upcoming.map((event) => {
    const unixSeconds = Math.floor(event.starts_at / 1000);
    // Only offer the jump link while the channel is still there — a link into a deleted channel is
    // a dead end, and handing someone one is worse than omitting it. The message itself could also
    // be gone, but checking that costs a fetch per row, which is too much for a ten-row list.
    const reachable = event.message_id && interaction.guild.channels.cache.has(event.channel_id);
    const link = reachable ? `https://discord.com/channels/${event.guild_id}/${event.channel_id}/${event.message_id}` : null;
    const going = db.getEventSignups(event.id).filter((row) => row.status === 'going').length;
    return `**${event.title}** — <t:${unixSeconds}:F> (<t:${unixSeconds}:R>) — ${going} going${link ? ` — [jump](${link})` : ''}`;
  });
  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('event:manage').setPlaceholder('Select an event to edit or delete it')
      .addOptions(upcoming.map((event) => ({
        label: event.title.slice(0, 100),
        value: String(event.id),
        description: new Date(event.starts_at).toISOString().slice(0, 16).replace('T', ' '),
      }))),
  );
  await interaction.reply({ content: `**Upcoming events**\n${lines.join('\n')}`, components: [selectRow], flags: MessageFlags.Ephemeral });
}

export async function handleEvent(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'create') await handleEventCreate(interaction);
  else if (sub === 'list') await handleEventList(interaction);
}
