import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
} from 'discord.js';
import { CARD_ACCENT_COLOR, EVENT_TIMEZONE_PRESETS } from '../config.js';
import { describeRepeat, REPEAT_RULES } from '../events.js';

/**
 * Everything the `/event` subsystem *renders*, kept apart from the handlers that dispatch it.
 *
 * The split exists so this half is reachable from a test: `interactions/events.js` imports
 * `runtime.js`, which opens the database and constructs a Discord client at import time, so merely
 * naming a builder from there would have those side effects. Nothing here touches `db` or `client`
 * — same reasoning that keeps `src/events.js` free of Discord calls.
 */

/** The three RSVP buttons, and so the only values `event_signups.status` may take. */
export const RSVP_STATUSES = ['going', 'maybe', 'declined'];

/**
 * Event buttons that manage the event rather than answering it — all gated on `canManageEvent`.
 * `tools` opens the panel; the other three are the panel's own buttons, still gated individually
 * because the panel is an ordinary message that outlives the click that opened it.
 */
export const MANAGE_ACTIONS = ['tools', 'edit', 'resend', 'delete'];

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
  // Third in the inline row, so When / Game / Repeats fills it exactly. Shown at all only when the
  // event repeats: every event ever created before this existed is a one-off, and saying so on all
  // of them would be noise on the overwhelming majority.
  const repeats = describeRepeat(event.repeat_rule);
  if (repeats) embed.addFields({ name: '🔁 Repeats', value: repeats, inline: true });
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
      // One button in place of Edit/Resend/Delete inline. Those are visible to everyone but work
      // only for the creator and Manage Server, so most members were shown three controls that
      // could do nothing but refuse them. `tools` rather than `manage` because `event:manage` is
      // already the /event list select — the router tells them apart (it matches that one on
      // exact equality, and only for a string select), but a reader would not.
      new ButtonBuilder().setCustomId(`event:tools:${eventId}`).setLabel('⚙️ Manage').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * The private panel behind ⚙️ Manage, shown as an ephemeral reply.
 *
 * Ephemeral rather than swapping the row on the announcement: `interaction.update()` there would
 * change the buttons for everyone looking at the message, not just the person who clicked.
 *
 * The three ids are unchanged from when these buttons sat on the announcement itself, so every
 * event already posted keeps working — its existing row still routes to the same handlers, and the
 * handlers already cope with being clicked from somewhere other than the announcement.
 */
export function buildEventManagePanel(eventId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event:edit:${eventId}`).setLabel('✏️ Edit').setStyle(ButtonStyle.Secondary),
    // "Resend" is meant literally: the repost carries the invite ping line, so members who still
    // have not answered are notified again. Anyone who has answered was pruned off that line at
    // that moment, so nobody is pinged twice for the same reply.
    new ButtonBuilder().setCustomId(`event:resend:${eventId}`).setLabel('🔁 Resend').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`event:delete:${eventId}`).setLabel('🗑️ Delete').setStyle(ButtonStyle.Secondary),
  )];
}

/**
 * Drops one member's ping from the invite line, leaving the rest of it intact.
 *
 * The line is the only record of who was invited — there is no invites table — and every responder
 * is pruned out of it as they answer, so what remains is exactly the people still to reply.
 * Returns `null` for an empty result, because that is what `interaction.update()` needs to clear
 * content rather than leave the previous value standing.
 */
export function withoutMention(content, userId) {
  if (!content) return null;
  // String.raw so the \s survives as a regex escape — a plain template literal needs it doubled,
  // and a single backslash there silently degrades into matching a literal "s".
  return content.replace(new RegExp(String.raw`<@!?${userId}>\s*`), '').trim() || null;
}

/**
 * The content half of an edit to the announcement after `userId` answered — spread into the edit
 * payload alongside the embed.
 *
 * Returns an empty object, not `{ content: null }`, when the line does not change: discord.js sends
 * an omitted `content` as "leave it alone" and a null one as "clear it". The callers that only
 * refresh an embed (an edit, a cancellation) go through the same payload builder, so emitting the
 * key unconditionally would wipe the invite line out from under them.
 */
export function contentPatchAfterReply(currentContent, userId) {
  const pruned = withoutMention(currentContent, userId);
  // `currentContent || null` because discord.js reports a message with no content as '', while
  // withoutMention normalises the same emptiness to null — compared raw, those never match.
  return pruned === (currentContent || null) ? {} : { content: pruned };
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
    // The fifth and last row a modal may hold. A dropdown would be the obvious control and modals
    // cannot contain one — the timezone step exists for exactly that reason, and it costs a whole
    // extra click before the form opens. Paying that a second time, on every event whether or not
    // it repeats, is worse than parsing a word.
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('repeat').setLabel(`Repeat (${REPEAT_RULES.join('/')})`).setStyle(TextInputStyle.Short)
        .setPlaceholder('Leave blank for a one-off').setValue(values.repeat ?? '').setRequired(false),
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
