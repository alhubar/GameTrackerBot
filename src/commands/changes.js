import { MessageFlags } from 'discord.js';
import { db } from '../runtime.js';
import { CHANGES_CHANNEL, GITHUB_REPOSITORY, GITHUB_TOKEN } from '../config.js';
import { findTextChannel, splitDiscordMessage } from '../ui.js';

async function fetchLatestRelease(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must use the format owner/repository.');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Discord-Game-Tracker',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers });
  if (response.status === 404) throw new Error('No published GitHub Release was found yet.');
  if (!response.ok) throw new Error(`GitHub could not load the latest release (HTTP ${response.status}).`);
  return response.json();
}

/** Drops a release body's own leading title line if it has one, so it never duplicates the
 *  header this command already adds. Only strips a line that is bold end-to-end AND mentions
 *  the release's own version (e.g. "**📣 Game Tracker v1.0.0**") — an ordinary bold section
 *  header used as the first line of real release notes (e.g. "**Being AFK no longer counts as
 *  playing**") never mentions the version, so it's left alone. */
export function stripLeadingTitleLine(body, tagName) {
  const lines = body.split('\n');
  const first = lines[0]?.trim();
  const version = tagName.replace(/^v/i, '');
  if (first && /^\*\*.+\*\*$/.test(first) && version && first.includes(version)) {
    lines.shift();
    // Compare trimmed: GitHub stores release bodies with CRLF, so splitting on \n leaves a
    // trailing \r on every line and a "blank" line is "\r", never "". Without the trim the
    // separator blanks below a stripped title all survive and the post opens on a gap.
    while (lines.length && lines[0].trim() === '') lines.shift();
  }
  return lines.join('\n');
}

export async function handleChanges(interaction) {
  const force = interaction.options.getBoolean('force') ?? false;
  if (!CHANGES_CHANNEL || !GITHUB_REPOSITORY) {
    await interaction.reply({ content: 'Set CHANGES_CHANNEL and GITHUB_REPOSITORY in `.env` before using `/changes`.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.guild.channels.fetch();
  const channel = findTextChannel(interaction.guild, CHANGES_CHANNEL);
  if (!channel) {
    await interaction.reply({ content: `I could not find a text channel named #${CHANGES_CHANNEL}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  let release;
  try {
    release = await fetchLatestRelease(GITHUB_REPOSITORY);
  } catch (error) {
    await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!force && db.getLastAnnouncedRelease(interaction.guild.id) === String(release.id)) {
    await interaction.reply({ content: 'The latest GitHub Release has already been announced. Use `/changes force:True` to post it again.', flags: MessageFlags.Ephemeral });
    return;
  }
  const body = stripLeadingTitleLine(release.body?.trim() || 'No release notes were provided.', release.tag_name);
  const announcement = `📣 **New Game Tracker version ${release.tag_name} released!**\n${body}`;
  for (const message of splitDiscordMessage(announcement)) {
    await channel.send({ content: message, allowedMentions: { parse: [] } });
  }
  db.setLastAnnouncedRelease(interaction.guild.id, release.id);
  await interaction.reply({ content: `Posted the latest GitHub Release in ${channel}.`, flags: MessageFlags.Ephemeral });
}
