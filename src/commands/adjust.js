import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { db } from '../runtime.js';
import { CARD_ACCENT_COLOR } from '../config.js';
import { RANKS, formatPlayTime, rankForSeconds } from '../ranks.js';
import { reconcileRank } from '../tracking.js';
import { ADJUSTMENT_KINDS, applyTimeAdjustment, voidSession, mergeGames } from '../adjustments.js';
import { DUPLICATE_REASONS, findDuplicateGameNames } from '../gameNames.js';

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
const SESSION_LOG_LIMIT = 10;
// An embed description is capped at 4096 characters, and a Discord activity name is free text long
// enough that twenty rows of one could pass that on their own. Bounding the name bounds the line,
// which bounds the list — more predictable than dropping rows off the end of an audit.
const GAME_NAME_MAX = 60;
// Discord caps an autocomplete choice name at 100 characters and a response at 25 choices.
const CHOICE_NAME_MAX = 100;
const CHOICE_LIMIT = 25;
// Ten suggestions is already more merges than anybody does in one sitting, and the list is ordered
// so the ones worth doing first are the ones shown. The scan limit bounds an all-pairs comparison
// against pathological data rather than paging it — a real library is a few dozen names.
const DUPLICATE_LIMIT = 10;
const DUPLICATE_SCAN_LIMIT = 1000;
// Discord caps an embed description at 4096 and rejects the whole message for one character over,
// so the sweep stops filling well short of it rather than risking a reply that never arrives.
const DESCRIPTION_BUDGET = 3800;

/** Ranked, and labelled with how far each class can be trusted, because they differ a lot. */
const REASON_LABELS = {
  [DUPLICATE_REASONS.IDENTICAL]: '🟢 **The same name** apart from case, punctuation or spacing',
  [DUPLICATE_REASONS.NEAR]: '🟡 **A character or two apart** — usually a typo',
  [DUPLICATE_REASONS.EXTENDS]: '🟠 **One name plus words** — a re-title or edition, or two different games',
};

/** Said on every reply, empty or not: the case this cannot see is the case that motivated `merge`. */
const RENAME_BLIND_SPOT = '_A rename sharing no words with the old title — Counter-Strike: Global '
  + 'Offensive → Counter-Strike 2 — cannot be spotted this way. Those still need an eye on them._';

const signed = (seconds) => `${seconds < 0 ? '−' : '+'}${formatPlayTime(Math.abs(seconds))}`;
const rankName = (index) => (index >= 0 ? RANKS[index] : 'no rank');
const stamp = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;
const gameLabel = (name) => (name.length > GAME_NAME_MAX ? `${name.slice(0, GAME_NAME_MAX - 1)}…` : name);
// A code span is the only rendering that shows a stray space, which is exactly the difference the
// duplicate sweep exists to surface. A backtick inside the name would end the span early, so those
// few names fall back to bold and lose the whitespace hint rather than breaking the whole line.
const nameSpan = (name) => (name.includes('`') ? `**${name}**` : `\`${name}\``);

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

/**
 * `/adjust merge` — the fix for one game recorded under two names.
 *
 * Guild-wide and takes no member, because a spelling is wrong for everybody who has it. Nothing
 * here can change a total or a rank: the time moves between game names and `member_stats` is never
 * touched, which is why this needs none of the clamping the other two subcommands live by.
 */
async function handleMerge(interaction) {
  const fromName = interaction.options.getString('from', true);
  // `into` is trimmed and `from` deliberately is not. `from` comes from the picker and has to match
  // a stored name exactly — and a stray trailing space is precisely the kind of variant spelling
  // this command exists to clean up, so trimming it would make that case unmergeable. `into` may be
  // typed, where surrounding whitespace is never what anybody meant.
  const intoName = interaction.options.getString('into', true).trim();
  const reason = interaction.options.getString('reason');

  if (!intoName) {
    await interaction.editReply('`into` needs a name to keep.');
    return;
  }
  if (fromName === intoName) {
    await interaction.editReply('Both names are the same, so there is nothing to merge.');
    return;
  }

  const result = mergeGames(db, {
    guildId: interaction.guild.id,
    fromName,
    intoName,
    actorId: interaction.user.id,
    reason,
  });

  if (!result) {
    await interaction.editReply(
      `Nothing is recorded under **${fromName}** in this server, so there was nothing to merge. `
      + 'Nothing was changed or logged — pick the name from the list rather than typing it.',
    );
    return;
  }

  const movedSeconds = result.members.reduce((total, member) => total + member.movedSeconds, 0);
  const memberCount = result.members.length;
  const lines = [
    `**${fromName}** → **${intoName}**`,
    `${memberCount} ${memberCount === 1 ? 'member' : 'members'} affected · `
      + `**${formatPlayTime(movedSeconds)}** moved · ${result.sessionsMoved} recorded `
      + `${result.sessionsMoved === 1 ? 'session' : 'sessions'} renamed.`,
    result.intoExisted
      ? `**${intoName}** now: ${formatPlayTime(result.intoTotalSeconds)} across the server.`
      : `**${intoName}** held nothing before, so this was a rename. It now has `
        + `${formatPlayTime(result.intoTotalSeconds)} across the server.`,
  ];
  if (result.activeMoved) {
    lines.push(`▶️ ${result.activeMoved} ${result.activeMoved === 1 ? 'session is' : 'sessions are'} running `
      + 'under that name right now and moved too, so the time still on the clock lands on the new name.');
  }
  lines.push('No totals or ranks changed — a merge moves time between names rather than adding or removing any.');
  // Said out loud because it is the one number members can see going *down* afterwards, and a count
  // that drops with no explanation reads as lost data.
  lines.push('Anyone who had both names now has one fewer distinct game, so game counts and the '
    + `collection tiers can read lower. ${ACHIEVEMENT_NOTE}`);
  if (reason) lines.push(`Reason: ${reason}`);

  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle('🔀 Games merged')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Merging back would not restore the split — this cannot be undone.' });
  await interaction.editReply({ embeds: [embed] });
}

/**
 * `/adjust sessions` — the read half of the session tools.
 *
 * Until this existed, a recorded session could only be *seen* from inside the `/adjust session`
 * picker: one member at a time, and only while part-way through voiding one. "Did the bot record
 * last night properly?" had no answer short of opening the database, which is the question the rest
 * of this command already exists to act on.
 *
 * Running sessions lead the list because they are what an audit is usually chasing — a session that
 * never closed, or one still banking time for somebody who stopped playing hours ago. They carry no
 * id: nothing reaches `play_sessions` until it closes, so there is nothing for `/adjust session` to
 * void yet.
 *
 * Deliberately not filtered for opt-out or for departure. Opt-out filters rankings and records, and
 * this is neither — it is an admin reading the bot's own record in order to correct it, the same
 * ground `/adjust log` stands on. An opted-out member accrues nothing new anyway, which is why
 * their status is stated rather than left to explain a short list.
 */
async function handleSessions(interaction) {
  const user = interaction.options.getUser('member');
  const userId = user?.id ?? null;
  const now = Date.now();
  const running = db.getRunningSessions(interaction.guild.id, userId, SESSION_LOG_LIMIT, now);
  const rows = db.getSessionLog(interaction.guild.id, userId, SESSION_LOG_LIMIT);
  // Stated rather than left to explain itself: an admin reading a short or empty list for somebody
  // who opted out is otherwise looking at a tracking bug that is not there.
  const optOutNote = user && db.isOptedOut(interaction.guild.id, user.id)
    ? `⚠️ **${user.tag}** has opted out of tracking, so nothing new is being recorded for them.`
    : null;

  if (!running.length && !rows.length) {
    const nothing = user
      ? `No sessions are recorded for **${user.tag}**.`
      : 'No sessions are recorded in this server yet.';
    await interaction.editReply(optOutNote ? `${nothing}\n${optOutNote}` : nothing);
    return;
  }

  // A filtered list names the member once in the title, so the per-row mention is carried only on
  // the server-wide list, where consecutive rows are about different people.
  const who = (id) => (user ? '' : ` <@${id}>`);
  const lines = [];

  if (running.length) {
    lines.push('**Running now**');
    lines.push(...running.map((session) => {
      // An idle session is the most common reason a total "stopped moving", and the pause is
      // invisible on every other surface — the elapsed time simply stops growing.
      const idle = session.pausedAt
        ? ` · ⏸️ idle since ${stamp(session.pausedAt, 'R')}, not counting`
        : '';
      // The start is a full date rather than a time of day: a session running since Tuesday is
      // exactly the one this list is for, and "started 20:44" would not say which Tuesday.
      return `▶️${who(session.userId)} **${gameLabel(session.gameName)}** · `
        + `${formatPlayTime(session.elapsedSeconds)} so far · started ${stamp(session.startedAt)}${idle}`;
    }));
  }

  if (rows.length) {
    if (running.length) lines.push('', '**Recorded**');
    lines.push(...rows.map((row) => `\`#${row.id}\`${who(row.user_id)} **${gameLabel(row.game_name)}** · `
      + `${formatPlayTime(row.duration_seconds)} · ended ${stamp(row.ended_at)}`));
  }

  if (optOutNote) lines.push('', optOutNote);

  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle(user ? `🎮 Sessions for ${user.tag}` : '🎮 Recent sessions')
    .setDescription(lines.join('\n'))
    .setFooter({
      text: rows.length
        ? `Showing the ${rows.length} most recent. Void one with /adjust session — the id is what its picker lists.`
        : 'Nothing has finished yet — a session only gets an id once it closes.',
    });
  await interaction.editReply({ embeds: [embed] });
}

/**
 * `/adjust duplicates` — the read half of `merge`, the same way `sessions` is the read half of
 * `session`.
 *
 * Read-only and never an automatic merge. A merge is a guild-wide judgement that a spelling is
 * wrong for everybody, and it has no undo — `play_sessions` and `active_sessions` are rewritten
 * along with the aggregates, and the `stat_adjustments` row recording it is never edited. Noticing
 * is safe; acting is not, so this stops at naming the pair and the command that would fix it.
 *
 * The three classes are labelled rather than blended into one score, because they are not equally
 * trustworthy — see `gameNames.js`. What none of them catch is a rename that shares no words with
 * the old title, which is the case that motivated `/adjust merge` in the first place; the footer
 * says so, since a list that finds nothing otherwise reads as "there is nothing to find".
 */
async function handleDuplicates(interaction) {
  const games = db.getGuildGameTotals(interaction.guild.id, DUPLICATE_SCAN_LIMIT);
  const suggestions = findDuplicateGameNames(games);

  if (!games.length) {
    await interaction.editReply('No games are recorded in this server yet, so there is nothing to compare.');
    return;
  }
  if (!suggestions.length) {
    await interaction.editReply(
      `Nothing looks like a duplicate among the ${games.length} game `
      + `${games.length === 1 ? 'name' : 'names'} recorded here.\n${RENAME_BLIND_SPOT}`,
    );
    return;
  }

  const blocks = suggestions.map((suggestion) => [
    REASON_LABELS[suggestion.reason],
    ...suggestion.names.map((entry) => {
      const players = `${entry.playerCount} ${entry.playerCount === 1 ? 'player' : 'players'}`;
      // The one difference invisible in a rendered message is the one this exists to catch: a stray
      // space reads as an identical name with mysteriously separate totals. `/adjust merge`
      // deliberately does not trim its `from`, so the name stays mergeable exactly as stored.
      const edges = entry.name !== entry.name.trim() ? ' · ⚠️ stray leading or trailing space' : '';
      return `└ ${nameSpan(gameLabel(entry.name))} — ${formatPlayTime(entry.totalSeconds)}, ${players}${edges}`;
    }),
  ]);

  // A group can hold any number of spellings and a name runs to 60 characters, so ten of them can
  // pass the 4096 an embed description allows — which Discord rejects outright, leaving a log line
  // and no reply at all. Dropping the weakest suggestions is the graceful half of that; the footer
  // says how many went. One block always goes in, however long it is: a truncated line beats none.
  const shown = [];
  let budget = DESCRIPTION_BUDGET - RENAME_BLIND_SPOT.length;
  for (const block of blocks) {
    const cost = block.join('\n').length + 2;
    if (shown.length >= DUPLICATE_LIMIT || (shown.length && cost > budget)) break;
    shown.push(block);
    budget -= cost;
  }
  const lines = shown.flatMap((block, index) => (index ? ['', ...block] : block));

  const footer = [
    suggestions.length > shown.length
      ? `Showing the ${shown.length} strongest of ${suggestions.length}.`
      : `${suggestions.length} ${suggestions.length === 1 ? 'suggestion' : 'suggestions'} from ${games.length} names.`,
    'Each group leads with the name holding the most time — the obvious one to keep.',
    'Nothing has been changed. Fold one in with /adjust merge, which cannot be undone.',
  ];
  // Reported rather than hidden: a partial sweep that says nothing looks exactly like a clean one.
  if (games.length >= DUPLICATE_SCAN_LIMIT) footer.push(`Only the ${DUPLICATE_SCAN_LIMIT} most-played names were compared.`);

  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle('🔎 Possible duplicate game names')
    .setDescription([...lines, '', RENAME_BLIND_SPOT].join('\n'))
    .setFooter({ text: footer.join(' ') });
  await interaction.editReply({ embeds: [embed] });
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
    const target = user ? '' : ` <@${row.user_id}>`;
    // A merge moved no time, so the signed amount every other kind leads with would read as a
    // correction of zero. It names the two games instead, which is what it actually did.
    const what = row.kind === ADJUSTMENT_KINDS.MERGE
      ? `folded **${row.game_name}** into **${row.merged_into}**${target ? ` for${target}` : ''}`
      : `${row.kind === ADJUSTMENT_KINDS.SESSION ? `voided session \`#${row.session_id}\`` : 'adjusted'}${target}`
        + ` **${signed(row.delta_seconds)}** on **${row.game_name}**`;
    const parts = [`<t:${Math.floor(row.created_at / 1000)}:f> — <@${row.actor_id}> ${what}`];
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

const SUBCOMMANDS = {
  time: handleTime,
  session: handleSession,
  merge: handleMerge,
  sessions: handleSessions,
  duplicates: handleDuplicates,
  log: handleLog,
};

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
    // `merge` takes no member, so both its pickers list what the whole guild has on record.
    if (interaction.options.getSubcommand() === 'merge') {
      const wanted = String(focused.value ?? '').toLowerCase();
      await interaction.respond(db.getGuildGameNames(interaction.guild.id, CHOICE_LIMIT * 2)
        .filter((name) => name.toLowerCase().includes(wanted))
        .slice(0, CHOICE_LIMIT)
        .map((name) => ({ name: name.slice(0, CHOICE_NAME_MAX), value: name })));
      return;
    }
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
