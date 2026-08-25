import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { db, client } from '../runtime.js';
import { COUNTS_AS_PLAYED_SECONDS } from '../achievements.js';
import { parseEventTime, formatEventTime } from '../events.js';
import {
  RSVP_STATUSES, MANAGE_ACTIONS, buildEventEmbed, buildEventComponents, buildEventModal,
  buildTimezoneSelectRow, buildEventInviteRow, timezoneLabelFor, withoutMention, contentPatchAfterReply,
  buildEventManagePanel,
} from './eventViews.js';

/**
 * The `/event` subsystem's handlers: the button, select and modal dispatch behind the surface
 * rendered in `eventViews.js`.
 *
 * State rides in the `customId` as `event:<action>[:<eventId>][:<zone>]`. The timezone cannot be a
 * dropdown *inside* a modal, so it is chosen first and then carried through the modal's id — that
 * is why `event:tzcreate` and `event:tzedit:<id>` exist as a separate step.
 *
 * The scheduling rules themselves live in `src/events.js`, deliberately free of Discord calls so
 * they stay testable; this module only dispatches.
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

/**
 * After an action triggered somewhere other than the original announcement (e.g. via /event list),
 * keep the original channel message in sync too, so it doesn't show stale info or dead buttons.
 *
 * No-ops when the interaction is already attached to the announcement — that message has just been
 * edited by `interaction.update()` and does not need editing twice.
 *
 * `pruneMentionFor` drops one member's ping from the invite line. It has to be handled here rather
 * than by the caller because the line lives on the announcement, and the caller is by definition
 * looking at some other copy of the card, whose content is not the same string (usually not any
 * string at all).
 */
export async function syncOriginalEventMessage(event, interaction, embed, components, { pruneMentionFor = null } = {}) {
  if (!event.message_id || event.message_id === interaction.message?.id) return;
  const guild = client.guilds.cache.get(event.guild_id);
  const channel = guild?.channels.cache.get(event.channel_id);
  if (!channel?.isTextBased()) return;
  const original = await channel.messages.fetch(event.message_id).catch(() => null);
  if (!original) return;
  const patch = pruneMentionFor ? contentPatchAfterReply(original.content, pruneMentionFor) : {};
  await original.edit({ embeds: [embed], components, ...patch }).catch(() => {});
}

export async function handleEventButton(interaction) {
  const [, action, eventIdStr] = interaction.customId.split(':');
  const eventId = Number(eventIdStr);
  const event = db.getEvent(eventId);
  if (!event) {
    await interaction.reply({ content: 'This event no longer exists.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (MANAGE_ACTIONS.includes(action)) {
    if (!canManageEvent(interaction, event)) {
      await interaction.reply({ content: CANNOT_MANAGE, flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'tools') {
      await interaction.reply({
        content: `Managing **${event.title}**`,
        components: buildEventManagePanel(eventId),
        flags: MessageFlags.Ephemeral,
      });
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
    if (action === 'resend') {
      const guild = client.guilds.cache.get(event.guild_id);
      const channel = guild?.channels.cache.get(event.channel_id);
      if (!channel?.isTextBased()) {
        await interaction.reply({ content: 'Could not find the channel to resend this event to.', flags: MessageFlags.Ephemeral });
        return;
      }
      // The announcement was posted as an interaction reply, which needs no SendMessages; the resend
      // is an ordinary message, which does. Check before acknowledging, while reply() is still
      // available — past deferUpdate() the router's catch falls to editReply(), which would write
      // its error over the announcement's own content, taking the invite line with it.
      const me = guild.members.me;
      if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
        await interaction.reply({
          content: 'I can’t post in that channel any more, so I can’t resend this event.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // The button can be clicked from the live announcement itself — announcements posted before
      // the ⚙️ Manage panel still carry the inline row — or from an ephemeral surface: the panel,
      // or the copy /event list renders. Only in the first case is the message we're replacing the
      // one this interaction is attached to, which changes how we acknowledge it below.
      const onOriginal = interaction.message.id === event.message_id;
      if (onOriginal) await interaction.deferUpdate();
      const old = onOriginal
        ? interaction.message
        : (event.message_id ? await channel.messages.fetch(event.message_id).catch(() => null) : null);
      const signups = db.getEventSignups(eventId);
      let newMessage;
      try {
        newMessage = await channel.send({
          // Carried over deliberately: the content is the invite ping line, every responder is
          // pruned out of it as they answer, so re-posting it pings exactly the people who still
          // haven't — the point of resending a buried event. It is also the only record of who was
          // invited (there is no invites table), so dropping it here would lose that outright.
          content: old?.content || undefined,
          embeds: [buildEventEmbed(event, signups)],
          components: buildEventComponents(eventId),
        });
      } catch (error) {
        console.error(`[EVENT] Could not resend event ${eventId} into channel ${event.channel_id}:`, error);
        const failed = 'Could not post the event again — the old announcement is untouched.';
        if (onOriginal) await interaction.followUp({ content: failed, flags: MessageFlags.Ephemeral }).catch(() => {});
        else await interaction.reply({ content: failed, flags: MessageFlags.Ephemeral });
        return;
      }
      db.setEventMessageId(eventId, newMessage.id);
      // Removing the superseded post is best-effort and last on purpose: the row already points at
      // the new message, so failing here leaves a stale duplicate rather than an event nobody can
      // reach. Swallowing it silently left two live announcements and no trace of why.
      if (old) {
        await old.delete().catch((error) => {
          console.warn(`[EVENT] Resent event ${eventId} as message ${newMessage.id}, but could not delete the old message ${old.id}:`, error);
        });
      }
      if (!onOriginal) {
        await interaction.update({
          content: 'Resent to the bottom of the channel. 🔁',
          embeds: [buildEventEmbed(event, signups)],
          components: buildEventComponents(eventId),
        });
      }
      return;
    }
    await interaction.reply({
      content: 'Which timezone is the new start time in?',
      components: buildTimezoneSelectRow(`event:tzedit:${eventId}`),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Anything that isn't an RSVP falls through to here, so an id this version doesn't know — a
  // button from an older announcement, say — would otherwise be written straight into
  // event_signups as a status. There is no CHECK on that column and the key is (event, member),
  // so it would silently overwrite a real answer with a junk one.
  if (!RSVP_STATUSES.includes(action)) {
    await interaction.reply({
      content: 'That button no longer works. Open the event again with `/event list`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  db.upsertEventSignup(eventId, interaction.user.id, action);
  const signups = db.getEventSignups(eventId);
  const embed = buildEventEmbed(event, signups);
  const components = buildEventComponents(eventId);
  // Drop the responder from the invite-ping line (if they're on it) so someone who has already
  // answered — going, maybe, or declined — never gets pinged by it again. content persists
  // across interaction.update() unless overwritten, so this has to be explicit, not omitted.
  const content = withoutMention(interaction.message.content, interaction.user.id);
  await interaction.update({ content, embeds: [embed], components });
  // An RSVP can arrive from the announcement or from the copy /event list renders into an ephemeral
  // message, and the update above only ever edits whichever was clicked. Without this, answering
  // from the list left the announcement showing a stale Going list and still carrying the
  // responder's ping — which a later resend would then fire at someone who had already replied.
  // Acknowledging first keeps the click instant; the announcement follows a beat later.
  await syncOriginalEventMessage(event, interaction, embed, components, { pruneMentionFor: interaction.user.id });
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
