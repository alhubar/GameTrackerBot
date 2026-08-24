import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { db, client } from '../runtime.js';
import { CARD_ACCENT_COLOR } from '../config.js';
import { ACHIEVEMENTS } from '../achievements.js';
import { SERVER_ACHIEVEMENTS } from '../serverAchievements.js';
import { trackerState } from '../tracking.js';

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

  // Red only for an actual fault. A yellow "quiet" or "still starting up" is not a problem, and
  // colouring it as one trains the reader to ignore the colour.
  const faulted = !database.ok || checkpoint.icon === '🔴' || presence.icon === '🔴';

  const embed = new EmbedBuilder()
    .setColor(faulted ? EMBED_RED : CARD_ACCENT_COLOR)
    .setTitle('🩺 Game Tracker health')
    .addFields(
      { name: '🤖 Bot', value: `🟢 Online, started ${relative(trackerState.startedAt)}\n└ Gateway ${Math.max(0, Math.round(client.ws.ping))}ms · ${client.guilds.cache.size} guild(s)`, inline: false },
      { name: '💾 Database', value: database.ok ? '🟢 Readable' : `🔴 ${database.error}`, inline: false },
      { name: '📡 Presence tracking', value: `${presence.icon} ${presence.text}`, inline: false },
      { name: '⏱️ Checkpoint loop', value: `${checkpoint.icon} ${checkpoint.text}`, inline: false },
      { name: '🎮 Active sessions (this server)', value: `${activeSessions}`, inline: true },
      { name: '👥 Tracked players', value: `${trackedPlayers}`, inline: true },
      { name: '🏆 Achievements unlocked', value: `${unlockedHere} personal · ${serverUnlocked}/${SERVER_ACHIEVEMENTS.length} server`, inline: true },
    )
    .setFooter({ text: `${ACHIEVEMENTS.length} personal and ${SERVER_ACHIEVEMENTS.length} server achievements defined` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
