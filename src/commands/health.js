import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { db, client } from '../runtime.js';
import {
  CARD_ACCENT_COLOR, SOCIAL_ENABLED, SOCIAL_VOICE_DAILY_CAP_MINUTES,
  BACKUP_ENABLED, BACKUP_DIR, BACKUP_KEEP, BACKUP_HOUR_UTC,
} from '../config.js';
import { ACHIEVEMENTS } from '../achievements.js';
import { SERVER_ACHIEVEMENTS } from '../serverAchievements.js';
import { trackerState } from '../tracking.js';
import { listBackups, newestBackupDay, expectedBackupDay } from '../backup.js';
import { DUPLICATE_SCAN_LIMIT, findDuplicateGameNames } from '../gameNames.js';

/**
 * `/health` — an admin-only answer to the question the logs would otherwise have to answer:
 * "is tracking actually running, or did Discord quietly stop sending presence events?"
 *
 * That failure mode is invisible everywhere else in this bot. Discord-facing errors are
 * deliberately swallowed into `.catch(console.error)`, so a stalled gateway or a dead checkpoint
 * loop looks exactly like a quiet evening: no crash, no message, playtime silently not accruing.
 * The two ages below are what separate the two.
 */

// The checkpoint loop in index.js runs on this cadence; anything past a few missed ticks means the
// interval itself is wedged rather than merely between runs.
const CHECKPOINT_INTERVAL_MS = 60_000;
const CHECKPOINT_STALL_MS = 3 * CHECKPOINT_INTERVAL_MS;
// Presence traffic is bursty and a genuinely quiet server can go hours without an event, so this
// is reported as information rather than graded as a fault.
const PRESENCE_QUIET_MS = 6 * 60 * 60 * 1000;
// The backup loop in index.js checks hourly, and setInterval counts from process start rather than
// from the top of the hour — so the nightly copy legitimately lands anywhere in the hour after
// BACKUP_HOUR_UTC arrives. Two of those is the grace before a missing copy is called a fault, the
// same "a few missed ticks" shape the checkpoint threshold above uses.
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const BACKUP_GRACE_MS = 2 * BACKUP_CHECK_INTERVAL_MS;
// Discord's own danger red, matching the palette the rest of the bot's embeds use.
const EMBED_RED = 0xED4245;

/** Discord renders this as a live relative time ("3 seconds ago"), correct in every viewer's locale. */
const relative = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

function checkpointStatus(now) {
  const { lastCheckpointAt, startedAt } = trackerState;
  if (lastCheckpointAt === null) {
    // The first tick is a minute out from startup, so silence before then is expected.
    return now - startedAt < CHECKPOINT_STALL_MS
      ? { icon: '🟡', text: 'Starting — first checkpoint not due yet' }
      : { icon: '🔴', text: 'No checkpoint has run; the interval is not firing' };
  }
  const age = now - lastCheckpointAt;
  return age > CHECKPOINT_STALL_MS
    ? { icon: '🔴', text: `Stalled — last ran ${relative(lastCheckpointAt)}` }
    : { icon: '🟢', text: `Ran ${relative(lastCheckpointAt)}` };
}

function presenceStatus(now) {
  const { lastPresenceUpdateAt, presenceUpdates } = trackerState;
  if (lastPresenceUpdateAt === null) {
    return {
      icon: '🟡',
      text: 'No presence events received yet — if this persists, check the Presence Intent',
    };
  }
  const quiet = now - lastPresenceUpdateAt > PRESENCE_QUIET_MS;
  return {
    icon: quiet ? '🟡' : '🟢',
    text: `Last event ${relative(lastPresenceUpdateAt)} (${presenceUpdates} this run)`,
  };
}

/**
 * Whether the nightly copy is actually being taken.
 *
 * This is the loop that can be broken for weeks without anybody noticing: a failure is one
 * `console.error` in index.js and nothing else, and every plausible cause — a `BACKUP_DIR` that no
 * longer exists, a full disk, permissions lost in a host migration — is silent and permanent.
 *
 * Worse, until this existed the only way to check was to run `/backup`, which writes the *same*
 * day-stamped filename the loop uses. Checking therefore destroyed the evidence it was run to look
 * for: afterwards today's copy exists either way. Reading the filenames answers the question
 * without touching them, which is exactly what `backup.js` keeps its state on disk for.
 *
 * Graded against the newest copy that should exist *by now* rather than against "today", or a
 * healthy install would report a fault every morning before `BACKUP_HOUR_UTC` came round.
 */
function backupStatus(now) {
  if (!BACKUP_ENABLED) return { icon: '⚪', text: 'Off — BACKUP_ENABLED is false' };
  const newest = newestBackupDay(BACKUP_DIR);
  const expected = expectedBackupDay(now, BACKUP_HOUR_UTC, BACKUP_GRACE_MS);
  if (!newest) {
    // Nothing on disk is only expected while the first hourly check is still pending. Past that it
    // is the loud case this whole field exists for — the directory is almost certainly unwritable.
    return now - trackerState.startedAt < BACKUP_CHECK_INTERVAL_MS
      ? { icon: '🟡', text: 'No copies yet — the first check has not run' }
      : { icon: '🔴', text: `No copies in \`${BACKUP_DIR}\` — check the path exists and is writable` };
  }
  // Day stamps are ISO, so they compare correctly as strings and need no parsing back to dates.
  const kept = listBackups(BACKUP_DIR).length;
  const tally = `${kept} of ${BACKUP_KEEP} kept · ${String(BACKUP_HOUR_UTC).padStart(2, '0')}:00 UTC`;
  return newest >= expected
    ? { icon: '🟢', text: `Newest ${newest} · ${tally}` }
    : { icon: '🔴', text: `Newest is ${newest}, expected ${expected} — a night was missed · ${tally}` };
}

/**
 * How well the voice gate is backed up in this particular server.
 *
 * The gate refuses to count anyone alone, muted or deafened, but it cannot tell two friends
 * talking from two friends who both left the call connected overnight. Discord's AFK channel does
 * catch that — it moves idlers out, and the gate never counts the AFK room — but *only if the
 * server has one configured*. Without it the daily cap is the sole backstop, and that fact is
 * invisible everywhere else, so `/health` is where it belongs.
 */
function voiceGateStatus(guild) {
  const cap = `${SOCIAL_VOICE_DAILY_CAP_MINUTES}m/day cap`;
  if (!guild.afkChannelId) {
    return {
      icon: '🟡',
      text: `No AFK channel set — idle voice is bounded only by the ${cap}`,
    };
  }
  const minutes = Math.round((guild.afkTimeout ?? 0) / 60);
  return {
    icon: '🟢',
    text: `<#${guild.afkChannelId}> after ${minutes}m idle · ${cap}`,
  };
}

/**
 * How many groups of game names look like one game split in two.
 *
 * `gameNames.js` opens by naming the problem it exists to solve — "somebody has to *notice* the
 * split first, and nobody goes looking" — and `/adjust duplicates` inherits it one level up: it
 * only runs when an admin thinks to type it, and nothing ever suggests they should. A split can
 * sit in `game_stats` for months, shortening the most-played list and costing a distinct game to
 * everyone who holds both spellings.
 *
 * **Shown only when it is non-zero**, which is what settles whether this belongs on a command that
 * otherwise answers "is anything broken". A split spelling is not a fault — the bot is working
 * exactly as designed — and a line reading `0` on almost every run trains the reader to skip the
 * whole card, the same reasoning that keeps a quiet evening from being coloured red above. A line
 * that appears only when there is something to do cannot be habituated to. It is the same rule
 * `/server` already follows for its records, Hall of Fame and activity rows: omitted whole rather
 * than rendered empty.
 *
 * Counts *groups*, not names, so the number here matches the list `/adjust duplicates` then shows.
 * Reads against the same `DUPLICATE_SCAN_LIMIT` for the same reason.
 */
function duplicateGroupCount(guildId) {
  return findDuplicateGameNames(db.getGuildGameTotals(guildId, DUPLICATE_SCAN_LIMIT)).length;
}

export async function handleHealth(interaction) {
  // Discord already hides the command from non-admins via setDefaultMemberPermissions, but a server
  // owner can override that per-command under Server Settings → Integrations, so the real check
  // lives here as well. `usable` and `visible` have to agree, and only this half is enforceable.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'Only server administrators can use `/health`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = Date.now();
  const database = db.ping();
  const checkpoint = checkpointStatus(now);
  const presence = presenceStatus(now);
  const activeSessions = database.ok ? db.getActiveSessionCount(interaction.guild.id) : 0;
  const unlockedHere = database.ok ? db.getTotalAchievementUnlockCount(interaction.guild.id) : 0;
  const trackedPlayers = database.ok ? db.getTrackedPlayerCount(interaction.guild.id) : 0;
  const serverUnlocked = database.ok ? db.getServerAchievements(interaction.guild.id).length : 0;
  const voice = database.ok && SOCIAL_ENABLED
    ? db.getVoiceCounts(interaction.guild.id)
    : { present: 0, counting: 0 };
  const voiceGate = voiceGateStatus(interaction.guild);
  const backup = backupStatus(now);
  const duplicates = database.ok ? duplicateGroupCount(interaction.guild.id) : 0;

  // Red only for an actual fault. A yellow "quiet" or "still starting up" is not a problem, and
  // colouring it as one trains the reader to ignore the colour. A missed backup counts: it is the
  // one thing here that is already broken by the time it shows, rather than merely quiet.
  const faulted = !database.ok || checkpoint.icon === '🔴' || presence.icon === '🔴'
    || backup.icon === '🔴';

  const embed = new EmbedBuilder()
    .setColor(faulted ? EMBED_RED : CARD_ACCENT_COLOR)
    .setTitle('🩺 Game Tracker health')
    .addFields(
      { name: '🤖 Bot', value: `🟢 Online, started ${relative(trackerState.startedAt)}\n└ Gateway ${Math.max(0, Math.round(client.ws.ping))}ms · ${client.guilds.cache.size} guild(s)`, inline: false },
      { name: '💾 Database', value: database.ok ? '🟢 Readable' : `🔴 ${database.error}`, inline: false },
      { name: '📡 Presence tracking', value: `${presence.icon} ${presence.text}`, inline: false },
      { name: '⏱️ Checkpoint loop', value: `${checkpoint.icon} ${checkpoint.text}`, inline: false },
      { name: '🗄️ Backups', value: `${backup.icon} ${backup.text}`, inline: false },
      { name: '🎮 Active sessions (this server)', value: `${activeSessions}`, inline: true },
      { name: '👥 Tracked players', value: `${trackedPlayers}`, inline: true },
      { name: '🏆 Achievements unlocked', value: `${unlockedHere} personal · ${serverUnlocked}/${SERVER_ACHIEVEMENTS.length} server`, inline: true },
    )
    .addFields(...(SOCIAL_ENABLED ? [
      {
        name: '🎙️ In voice (this server)',
        value: `${voice.present} present · ${voice.counting} earning`,
        inline: true,
      },
      { name: '🛡️ Voice idle guard', value: `${voiceGate.icon} ${voiceGate.text}`, inline: false },
    ] : []))
    // Present only when there is something to act on — see `duplicateGroupCount`. Last, because it
    // is the one row that is a job rather than a status.
    .addFields(...(duplicates ? [{
      name: '🔀 Possible duplicate game names',
      value: `${duplicates} ${duplicates === 1 ? 'group looks' : 'groups look'} like one game split in two`
        + ' — review with `/adjust duplicates`',
      inline: false,
    }] : []))
    .setFooter({ text: `${ACHIEVEMENTS.length} personal and ${SERVER_ACHIEVEMENTS.length} server achievements defined` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
