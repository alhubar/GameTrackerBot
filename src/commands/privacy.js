import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { db } from '../runtime.js';
import { CARD_ACCENT_COLOR } from '../config.js';
import { formatPlayTime } from '../ranks.js';

/**
 * `/privacy` — every tracking control a member has over their own data, in one ephemeral place.
 *
 * Ephemeral throughout, and never accepts a target other than the caller. `/stats` is public and
 * takes a member option, so a data inventory rendered there would publish one member's record to
 * the channel and let anyone pull up anyone else's — the opposite of a privacy control.
 *
 * Opting out is reversible and deletes nothing: recording stops and every ranking hides them, but
 * their rows stay exactly where they are, so opting back in restores the lot. Erasure is the
 * separate, deliberately harder path.
 */

export const PRIVACY_NOTE = 'Opting out stops new recording and hides you from every ranking. '
  + 'Nothing is deleted, so you can opt back in at any time and pick up where you left off.';

export function buildStatusEmbed(guildId, userId) {
  const optedOutAt = db.getOptOutAt(guildId, userId);
  const stored = db.getStoredDataSummary(guildId, userId);
  const rows = [
    `⏱️ Playtime recorded: **${formatPlayTime(stored.totalSeconds)}**`,
    `🎮 Games: **${stored.games}**`,
    `📓 Recorded sessions: **${stored.sessions}**`,
    `🏆 Achievements unlocked: **${stored.achievements}**`,
    `🤝 Co-op partners on record: **${stored.duoPartners}**`,
    `📅 Event RSVPs: **${stored.eventSignups}** · events created: **${stored.eventsCreated}**`,
  ];
  if (stored.corrections) rows.push(`✏️ Admin corrections to your stats: **${stored.corrections}**`);
  if (stored.activeSession) rows.push('▶️ You have a session in progress right now.');

  return new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle('🔒 Your tracking and data')
    .setDescription(optedOutAt
      ? `🚫 **You are opted out** since <t:${Math.floor(optedOutAt / 1000)}:D>. Nothing new is being recorded and you are hidden from every ranking.`
      : '✅ **You are being tracked.** Presence-based playtime is recorded and you appear on the rankings.')
    .addFields({ name: 'What is stored about you in this server', value: rows.join('\n'), inline: false })
    .setFooter({ text: optedOutAt ? 'Use /privacy optin to resume, or /privacy forgetme to erase it all.' : 'Use /privacy optout to stop being tracked.' });
}

async function handleStatus(interaction) {
  await interaction.editReply({ embeds: [buildStatusEmbed(interaction.guild.id, interaction.user.id)] });
}

async function handleOptOut(interaction) {
  const { id: guildId } = interaction.guild;
  if (db.isOptedOut(guildId, interaction.user.id)) {
    await interaction.editReply('You are already opted out. Use `/privacy optin` to resume tracking.');
    return;
  }
  // Closing the session in flight is part of opting out: its unbanked minutes would otherwise be
  // credited by the next checkpoint, after the member had already asked to stop being recorded.
  const closed = db.optOut(guildId, interaction.user.id, Date.now());
  const lines = ['🚫 **You are now opted out.** No new playtime will be recorded, and you have been removed from the leaderboards, server rankings and weekly recap.'];
  if (closed) lines.push(`Your session in progress (**${closed.gameName}**) was closed and its ${formatPlayTime(closed.durationSeconds)} kept.`);
  lines.push('');
  lines.push('Your existing history is untouched — `/privacy optin` brings it all back. To erase it instead, use `/privacy forgetme`.');
  await interaction.editReply(lines.join('\n'));
}

async function handleOptIn(interaction) {
  if (!db.optIn(interaction.guild.id, interaction.user.id)) {
    await interaction.editReply('You are already being tracked — there is nothing to resume.');
    return;
  }
  await interaction.editReply('✅ **Tracking resumed.** Your history is back on the rankings, and new sessions will be recorded from your next presence update.');
}

async function handleForgetMe(interaction) {
  const stored = db.getStoredDataSummary(interaction.guild.id, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('⚠️ Erase everything?')
    .setDescription([
      'This permanently deletes everything this bot holds about you in this server:',
      `**${formatPlayTime(stored.totalSeconds)}** of playtime, **${stored.games}** games, `
        + `**${stored.sessions}** sessions and **${stored.achievements}** achievements.`,
      '',
      '**This cannot be undone.** There is no restore short of a server backup.',
      stored.duoPartners
        ? `⚠️ You have co-op history with **${stored.duoPartners}** other member(s). Co-op days are stored as *pairs*, so erasing yours also lowers their co-op counts.`
        : null,
      stored.eventsCreated
        ? `Events you created stay up so nobody's plans are cancelled, but will no longer name you.`
        : null,
    ].filter(Boolean).join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`privacy:erase:${interaction.user.id}`)
      .setLabel('Erase everything').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`privacy:cancel:${interaction.user.id}`)
      .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

const SUBCOMMANDS = { status: handleStatus, optout: handleOptOut, optin: handleOptIn, forgetme: handleForgetMe };

export async function handlePrivacy(interaction) {
  // Always ephemeral: every branch of this command is about one member's own data.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await SUBCOMMANDS[interaction.options.getSubcommand()](interaction);
}
