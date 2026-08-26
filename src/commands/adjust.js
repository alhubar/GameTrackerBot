import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { db } from '../runtime.js';
import { CARD_ACCENT_COLOR } from '../config.js';
import { RANKS, formatPlayTime, rankForSeconds } from '../ranks.js';
import { reconcileRank } from '../tracking.js';
import { ADJUSTMENT_KINDS, applyTimeAdjustment, voidSession } from '../adjustments.js';

/**
 * `/adjust` — the admin escape hatch for stats that do not match reality.
 *
 * Game names arrive as free text from Discord presence ("Counter-Strike 2", exact punctuation and
 * all), so both the game and the session are picked from autocomplete rather than typed. A typo in
 * a typed game name would not error — it would silently create a *new* game on the member's record
 * and leave the wrong one untouched, which is the opposite of a correction.
 *
 * The reply always states the totals before and after and any rank movement, because this is the
 * one command whose whole purpose is changing a number a member can see.
 */

const LOG_LIMIT = 10;
// Discord caps an autocomplete choice name at 100 characters and a response at 25 choices.
const CHOICE_NAME_MAX = 100;
const CHOICE_LIMIT = 25;

const signed = (seconds) => `${seconds < 0 ? '−' : '+'}${formatPlayTime(Math.abs(seconds))}`;
const rankName = (index) => (index >= 0 ? RANKS[index] : 'no rank');

function rankLine(totalBefore, totalAfter) {
  const before = rankForSeconds(totalBefore);
  const after = rankForSeconds(totalAfter);
  if (before === after) return `Rank unchanged (${rankName(after)}).`;
  return after > before
    ? `📈 Rank raised: ${rankName(before)} → **${rankName(after)}**.`
    : `📉 Rank lowered: ${rankName(before)} → **${rankName(after)}**. The role has been updated to match.`;
}

/**
 * Achievements deliberately survive a correction, so say so on any subtraction rather than leaving
 * an admin to wonder whether one quietly disappeared.
 */
const ACHIEVEMENT_NOTE = 'Achievements already unlocked are kept — corrections never re-lock them.';

async function replyResult(interaction, { title, lines, member, totalBefore, totalAfter }) {
  // Fix the role before answering, so the reply describes a state that is already true.
  if (member) await reconcileRank(member, rankForSeconds(totalBefore)).catch(console.error);
  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Total: ${formatPlayTime(totalBefore)} → ${formatPlayTime(totalAfter)}` });
  await interaction.editReply({ embeds: [embed] });
}

async function handleTime(interaction) {
  const user = interaction.options.getUser('member', true);
  const gameName = interaction.options.getString('game', true);
  const minutes = interaction.options.getInteger('minutes', true);
  const reason = interaction.options.getString('reason');

  if (minutes === 0) {
    await interaction.editReply('`minutes` was 0, so there is nothing to change.');
    return;
  }

  const result = applyTimeAdjustment(db, {
    guildId: interaction.guild.id,
    userId: user.id,
    actorId: interaction.user.id,
    gameName,
    deltaSeconds: minutes * 60,
    reason,
  });

  if (result.appliedSeconds === 0) {
    await interaction.editReply(
      `**${user.tag}** has no time recorded on **${gameName}**, so there was nothing to remove. Nothing was changed or logged.`,
    );
    return;
  }

  const lines = [`**${signed(result.appliedSeconds)}** on **${gameName}** for ${user}.`];
  // The clamp is reported rather than hidden: an admin who asked for two hours and got forty
  // minutes needs to know the rest was never on that game to begin with.
  if (result.appliedSeconds !== result.requestedSeconds) {
    lines.push(`⚠️ Asked for ${signed(result.requestedSeconds)}, but **${gameName}** only held `
      + `${formatPlayTime(Math.abs(result.appliedSeconds))}. The rest was never on this game.`);
  }
  lines.push(`**${gameName}** now: ${formatPlayTime(result.gameAfter)}.`);
  lines.push(rankLine(result.totalBefore, result.totalAfter));
  if (result.appliedSeconds < 0) lines.push(ACHIEVEMENT_NOTE);
  if (reason) lines.push(`Reason: ${reason}`);

  await replyResult(interaction, {
    title: '✏️ Playtime corrected',
    lines,
    member: interaction.options.getMember('member'),
    totalBefore: result.totalBefore,
    totalAfter: result.totalAfter,
  });
}

async function handleSession(interaction) {
  const sessionId = interaction.options.getInteger('session', true);
  const reason = interaction.options.getString('reason');

  const result = voidSession(db, {
    guildId: interaction.guild.id,
    sessionId,
    actorId: interaction.user.id,
    reason,
  });

  if (!result) {
    await interaction.editReply(`No session with id \`${sessionId}\` exists in this server. Pick one from the list rather than typing an id.`);
    return;
  }

  const { session } = result;
  const lines = [
    `Voided session \`#${sessionId}\` — **${session.game_name}**, `
      + `${formatPlayTime(session.duration_seconds)}, ended <t:${Math.floor(session.ended_at / 1000)}:f>.`,
    `**${signed(result.appliedSeconds)}** for <@${session.user_id}>.`,
  ];
  if (-result.appliedSeconds !== session.duration_seconds) {
    lines.push(`⚠️ The session was worth ${formatPlayTime(session.duration_seconds)}, but only `
      + `${formatPlayTime(-result.appliedSeconds)} was still on the books to remove.`);
  }
  lines.push(`**${session.game_name}** now: ${formatPlayTime(result.gameAfter)}.`);
  lines.push(rankLine(result.totalBefore, result.totalAfter));
  lines.push(ACHIEVEMENT_NOTE);
  if (reason) lines.push(`Reason: ${reason}`);

  await replyResult(interaction, {
    title: '🗑️ Session voided',
    lines,
    member: await interaction.guild.members.fetch(session.user_id).catch(() => null),
    totalBefore: result.totalBefore,
    totalAfter: result.totalAfter,
  });
}

async function handleLog(interaction) {
  const user = interaction.options.getUser('member');
  const rows = db.getAdjustments(interaction.guild.id, user?.id ?? null, LOG_LIMIT);

  if (!rows.length) {
    await interaction.editReply(user
      ? `No corrections have been recorded for **${user.tag}**.`
      : 'No corrections have been recorded in this server.');
    return;
  }

  const lines = rows.map((row) => {
    const what = row.kind === ADJUSTMENT_KINDS.SESSION
      ? `voided session \`#${row.session_id}\``
      : 'adjusted';
    const target = user ? '' : ` <@${row.user_id}>`;
    const parts = [`<t:${Math.floor(row.created_at / 1000)}:f> — <@${row.actor_id}> ${what}${target}`
      + ` **${signed(row.delta_seconds)}** on **${row.game_name}**`];
    if (row.reason) parts.push(`  ↳ ${row.reason}`);
    return parts.join('\n');
  });

  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle(user ? `📋 Corrections for ${user.tag}` : '📋 Recent corrections')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Showing the ${rows.length} most recent. Corrections are never removed from this log.` });
  await interaction.editReply({ embeds: [embed] });
}

const SUBCOMMANDS = { time: handleTime, session: handleSession, log: handleLog };

export async function handleAdjust(interaction) {
  // Discord hides the command from non-admins, but that default is overridable per-command under
  // Server Settings → Integrations, so the enforceable half of the check lives here as well.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'Only server administrators can use `/adjust`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await SUBCOMMANDS[interaction.options.getSubcommand()](interaction);
}

/**
 * Fills the `game` and `session` pickers from what the chosen member actually has on record.
 *
 * Discord gives an autocomplete interaction three seconds and no way to report an error, so
 * anything unexpected answers with an empty list — an empty picker is recoverable, a timed-out one
 * leaves the field stuck loading.
 */
export async function handleAdjustAutocomplete(interaction) {
  try {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused(true);
    // `getUser` does NOT work here and never will: an autocomplete payload carries no `resolved`
    // block, so discord.js builds this resolver from the raw options and `option.user` is always
    // undefined — getUser would return null on every keystroke and leave both pickers permanently
    // empty. The raw value of a user option is the id itself, which is all this needs.
    const userId = interaction.options.get('member')?.value;
    if (!userId) {
      await interaction.respond([]);
      return;
    }
    const query = String(focused.value ?? '').toLowerCase();

    if (focused.name === 'game') {
      const choices = db.getMemberGameNames(interaction.guild.id, userId, CHOICE_LIMIT * 2)
        .filter((name) => name.toLowerCase().includes(query))
        .slice(0, CHOICE_LIMIT)
        .map((name) => ({ name: name.slice(0, CHOICE_NAME_MAX), value: name }));
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'session') {
      const choices = db.getRecentSessions(interaction.guild.id, userId, CHOICE_LIMIT)
        .map((row) => ({
          // The id leads so a partially typed number still matches the session it names.
          name: `#${row.id} · ${row.game_name} · ${formatPlayTime(row.duration_seconds)} · `
            + `${new Date(row.ended_at).toISOString().slice(0, 10)}`,
          value: row.id,
        }))
        .filter((choice) => choice.name.toLowerCase().includes(query))
        .map((choice) => ({ ...choice, name: choice.name.slice(0, CHOICE_NAME_MAX) }));
      await interaction.respond(choices);
      return;
    }
    await interaction.respond([]);
  } catch (error) {
    console.error('Autocomplete failed:', error);
    await interaction.respond([]).catch(() => {});
  }
}
