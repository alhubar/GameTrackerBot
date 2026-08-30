import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { statSync } from 'node:fs';
import { db } from '../runtime.js';
import { BACKUP_DIR, BACKUP_KEEP, BACKUP_MIRROR_DIR } from '../config.js';
import { listBackups, runBackup } from '../backup.js';

/**
 * `/backup` — an on-demand copy, for the moment before a risky change rather than the nightly one.
 *
 * It writes to the same directory and the same day-stamped name as the scheduled loop, so running
 * it replaces today's copy instead of adding a second one, and rotation still sees a single series.
 */

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function handleBackup(interaction) {
  // Discord hides the command from non-admins, but that default is overridable per-command under
  // Server Settings → Integrations, so the enforceable half of the check lives here too.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Only members with Manage Server can use `/backup`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { path, removed, mirror } = await runBackup(db, BACKUP_DIR, Date.now(), BACKUP_KEEP, BACKUP_MIRROR_DIR);
    const lines = [`✅ Database backed up to \`${path}\` (${megabytes(statSync(path).size)}).`];
    if (removed.length) lines.push(`Rotated out ${removed.length} older cop${removed.length === 1 ? 'y' : 'ies'}.`);
    lines.push(`${listBackups(BACKUP_DIR).length} of a maximum ${BACKUP_KEEP} kept.`);
    // Somebody running this by hand is usually about to do something risky, so a mirror that
    // silently did not happen is exactly the thing they need told before they do it.
    if (mirror?.error) lines.push(`⚠️ The copy to \`${BACKUP_MIRROR_DIR}\` failed: ${mirror.error.message}`);
    else if (mirror) lines.push(`Mirrored to \`${mirror.path}\`.`);
    await interaction.editReply(lines.join('\n'));
  } catch (error) {
    console.error('Backup failed:', error);
    await interaction.editReply(`🔴 Backup failed: ${error.message}`);
  }
}
