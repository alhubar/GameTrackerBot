import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { db, client } from '../runtime.js';
import { CARD_ACCENT_COLOR, EVENT_TIMEZONE_PRESETS } from '../config.js';
import { COUNTS_AS_PLAYED_SECONDS } from '../achievements.js';
import { parseEventTime, formatEventTime } from '../events.js';

/**
 * The `/event` subsystem's Discord surface: embeds, buttons, the timezone select and the create /
 * edit modals, plus the handlers behind them.
 *
 * State rides in the `customId` as `event:<action>[:<eventId>][:<zone>]`. The timezone cannot be a
 * dropdown *inside* a modal, so it is chosen first and then carried through the modal's id — that
 * is why `event:tzcreate` and `event:tzedit:<id>` exist as a separate step.
 *
 * The scheduling rules themselves live in `src/events.js`, deliberately free of Discord calls so
 * they stay testable; this module only renders and dispatches.
 */

/**
 * Who may edit or delete an event: its creator, or anyone with Manage Server.
 *
 * The creator check alone left an event stranded the moment its creator left the guild — nobody,
 * not even the owner, could correct or cancel it, while RSVPs kept working and people kept signing
 * up for something no one could fix. It self-cleans 24h after its start time, which is no help at
 * all for an event scheduled a month out.
 */
function canManageEvent(interaction, event) {
  if (interaction.user.id === event.creator_id) return true;
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

const CANNOT_MANAGE = 'Only the person who created this event, or someone with Manage Server, can do that.';

export function buildEventEmbed(event, signups) {
  const going = signups.filter((row) => row.status === 'going');
  const maybe = signups.filter((row) => row.status === 'maybe');
  const declined = signups.filter((row) => row.status === 'declined');
  const unixSeconds = Math.floor(event.starts_at / 1000);
  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle(event.title)
    .addFields({ name: '🗓️ When', value: `<t:${unixSeconds}:F>\n<t:${unixSeconds}:R>`, inline: true });
  if (event.description) embed.setDescription(event.description);
  if (event.game_name) embed.addFields({ name: '🎮 Game', value: event.game_name, inline: true });
  embed.addFields({
    name: `✅ Going (${going.length})`,
    value: going.length ? going.map((row) => `<@${row.user_id}>`).join(', ') : 'Nobody yet — be the first!',
  });
  if (maybe.length) embed.addFields({ name: `🤔 Maybe (${maybe.length})`, value: maybe.map((row) => `<@${row.user_id}>`).join(', ') });
  if (declined.length) embed.addFields({ name: `❌ Can't make it (${declined.length})`, value: declined.map((row) => `<@${row.user_id}>`).join(', ') });
  return embed;
}

export function buildEventComponents(eventId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`event:going:${eventId}`).setLabel("I'm in").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`event:maybe:${eventId}`).setLabel('Maybe').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`event:declined:${eventId}`).setLabel("Can't make it").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`event:edit:${eventId}`).setLabel('✏️ Edit').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`event:delete:${eventId}`).setLabel('🗑️ Delete').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildEventModal(customId, title, timezoneLabel, values = {}) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short)
        .setValue(values.title ?? '').setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('at').setLabel(`Start (DD-MM-YYYY HH:mm), ${timezoneLabel}`).setStyle(TextInputStyle.Short)
        .setValue(values.at ?? '').setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('game').setLabel('Game (optional)').setStyle(TextInputStyle.Short)
        .setValue(values.game ?? '').setRequired(false),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph)
        .setValue(values.description ?? '').setRequired(false),
    ),
  );
}

export function buildTimezoneSelectRow(customId) {
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Choose a timezone for this event')
      .addOptions(EVENT_TIMEZONE_PRESETS.map((preset) => ({ label: preset.label, value: preset.value }))),
  )];
}

// minValues(0) lets the creator submit with nobody picked (a deliberate "skip inviting" action),
// distinct from just never touching the picker at all — both end up notifying nobody either way.
// maxValues/prefilled are both capped at 25 upstream (Discord's hard limit on a select menu).
export function buildEventInviteRow(eventId, prefilledUserIds) {
  const select = new UserSelectMenuBuilder().setCustomId(`event:invite:${eventId}`)
    .setPlaceholder('Invite specific members (optional)').setMinValues(0).setMaxValues(25);
  if (prefilledUserIds.length) select.setDefaultUsers(prefilledUserIds);
  return [new ActionRowBuilder().addComponents(select)];
}

export function timezoneLabelFor(zone) {
  return EVENT_TIMEZONE_PRESETS.find((preset) => preset.value === zone)?.label ?? zone;
}

/** After an edit/delete triggered somewhere other than the original announcement (e.g. via /event list),
 *  keep the original channel message in sync too, so it doesn't show stale info or dead buttons. */
export async function syncOriginalEventMessage(event, interaction, embed, components) {
  if (!event.message_id || event.message_id === interaction.message?.id) return;
  const guild = client.guilds.cache.get(event.guild_id);
  const channel = guild?.channels.cache.get(event.channel_id);
  if (!channel?.isTextBased()) return;
  const original = await channel.messages.fetch(event.message_id).catch(() => null);
  if (original) await original.edit({ embeds: [embed], components }).catch(() => {});
}

export async function handleEventButton(interaction) {
  const [, action, eventIdStr] = interaction.customId.split(':');
  const eventId = Number(eventIdStr);
  const event = db.getEvent(eventId);
  if (!event) {
    await interaction.reply({ content: 'This event no longer exists.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === 'edit' || action === 'delete') {
    if (!canManageEvent(interaction, event)) {
      await interaction.reply({ content: CANNOT_MANAGE, flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'delete') {
      db.deleteEvent(eventId);
      const cancelledEmbed = new EmbedBuilder()
        .setColor(0x99AAB5)
        .setTitle(`~~${event.title}~~ (cancelled)`)
        .setDescription('This event was cancelled.');
      await syncOriginalEventMessage(event, interaction, cancelledEmbed, []);
      await interaction.update({ embeds: [cancelledEmbed], components: [] });
      return;
    }
    await interaction.reply({
      content: 'Which timezone is the new start time in?',
      components: buildTimezoneSelectRow(`event:tzedit:${eventId}`),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  db.upsertEventSignup(eventId, interaction.user.id, action);
  const signups = db.getEventSignups(eventId);
  // Drop the responder from the invite-ping line (if they're on it) so someone who has already
  // answered — going, maybe, or declined — never gets pinged by it again. content persists
  // across interaction.update() unless overwritten, so this has to be explicit, not omitted.
  const content = interaction.message.content
    ? interaction.message.content.replace(new RegExp(`<@!?${interaction.user.id}>\\s*`), '').trim() || null
    : null;
  await interaction.update({ content, embeds: [buildEventEmbed(event, signups)], components: buildEventComponents(eventId) });
}

export async function handleEventManageSelect(interaction) {
  const eventId = Number(interaction.values[0]);
  const event = db.getEvent(eventId);
  if (!event) {
    await interaction.update({ content: 'That event no longer exists.', embeds: [], components: [] });
    return;
  }
  const signups = db.getEventSignups(eventId);
  await interaction.update({ content: null, embeds: [buildEventEmbed(event, signups)], components: buildEventComponents(eventId) });
}

export async function handleEventInviteSelect(interaction) {
  const eventId = Number(interaction.customId.split(':')[2]);
  const event = db.getEvent(eventId);
  if (!event) {
    await interaction.update({ content: 'This event no longer exists.', components: [] });
    return;
  }
  if (interaction.values.length) {
    const guild = client.guilds.cache.get(event.guild_id);
    const channel = guild?.channels.cache.get(event.channel_id);
    const original = event.message_id && channel?.isTextBased()
      ? await channel.messages.fetch(event.message_id).catch(() => null)
      : null;
    // Pings must live in the message's content, not the embed — mentions inside an embed field
    // (like the Going list above) render but never actually notify anyone.
    if (original) await original.edit({ content: interaction.values.map((id) => `<@${id}>`).join(' ') }).catch(() => {});
  }
  await interaction.update({
    content: interaction.values.length
      ? `Notified ${interaction.values.length} member${interaction.values.length === 1 ? '' : 's'}.`
      : 'Nobody selected — no one was notified.',
    components: [],
  });
}

export async function handleTimezoneCreateSelect(interaction) {
  const zone = interaction.values[0];
  await interaction.showModal(buildEventModal(`event:createmodal:${zone}`, 'Create event', timezoneLabelFor(zone)));
}

export async function handleTimezoneEditSelect(interaction) {
  const eventId = Number(interaction.customId.split(':')[2]);
  const event = db.getEvent(eventId);
  if (!event) {
    await interaction.update({ content: 'This event no longer exists.', components: [] });
    return;
  }
  const zone = interaction.values[0];
  const modal = buildEventModal(`event:editmodal:${eventId}:${zone}`, 'Edit event', timezoneLabelFor(zone), {
    title: event.title,
    at: formatEventTime(event.starts_at, zone),
    game: event.game_name ?? '',
    description: event.description ?? '',
  });
  await interaction.showModal(modal);
}

export async function handleEventCreateModal(interaction) {
  const zone = interaction.customId.split(':')[2];
  const title = interaction.fields.getTextInputValue('title');
  const atText = interaction.fields.getTextInputValue('at');
  const description = interaction.fields.getTextInputValue('description') || null;
  const game = interaction.fields.getTextInputValue('game') || null;
  const { utcMs, error: parseError } = parseEventTime(atText, zone);
  if (parseError) {
    await interaction.reply({ content: `${parseError} (interpreted in ${timezoneLabelFor(zone)} time)`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (utcMs <= Date.now()) {
    await interaction.reply({ content: 'That time is in the past — pick a time in the future.', flags: MessageFlags.Ephemeral });
    return;
  }
  const eventId = db.createEvent(interaction.guild.id, interaction.channelId, interaction.user.id, title, description, game, utcMs);
  const event = db.getEvent(eventId);
  await interaction.reply({ embeds: [buildEventEmbed(event, [])], components: buildEventComponents(eventId) });
  const reply = await interaction.fetchReply().catch(() => null);
  if (reply) db.setEventMessageId(eventId, reply.id);

  const prefilled = game ? db.getPlayersForGame(interaction.guild.id, game, COUNTS_AS_PLAYED_SECONDS) : [];
  await interaction.followUp({
    content: 'Want to notify specific members about this event? '
      + (prefilled.length ? 'Pre-filled with members who’ve already played the game — add or remove anyone, or clear it to skip.' : 'Pick anyone to ping, or leave it empty to skip.'),
    components: buildEventInviteRow(eventId, prefilled),
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

export async function handleEventEditModal(interaction) {
  const [, , eventIdStr, zone] = interaction.customId.split(':');
  const eventId = Number(eventIdStr);
  const event = db.getEvent(eventId);
  if (!event) {
    await interaction.reply({ content: 'This event no longer exists.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canManageEvent(interaction, event)) {
    await interaction.reply({ content: CANNOT_MANAGE, flags: MessageFlags.Ephemeral });
    return;
  }
  const title = interaction.fields.getTextInputValue('title');
  const atText = interaction.fields.getTextInputValue('at');
  const description = interaction.fields.getTextInputValue('description') || null;
  const game = interaction.fields.getTextInputValue('game') || null;
  const { utcMs, error: parseError } = parseEventTime(atText, zone);
  if (parseError) {
    await interaction.reply({ content: `${parseError} (interpreted in ${timezoneLabelFor(zone)} time)`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (utcMs <= Date.now()) {
    await interaction.reply({ content: 'That time is in the past — pick a time in the future.', flags: MessageFlags.Ephemeral });
    return;
  }
  db.updateEvent(eventId, title, description, game, utcMs);
  const updatedEvent = db.getEvent(eventId);
  const signups = db.getEventSignups(eventId);
  const updatedEmbed = buildEventEmbed(updatedEvent, signups);
  const updatedComponents = buildEventComponents(eventId);
  await syncOriginalEventMessage(updatedEvent, interaction, updatedEmbed, updatedComponents);
  await interaction.update({ embeds: [updatedEmbed], components: updatedComponents });
}
